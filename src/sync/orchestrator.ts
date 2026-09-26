import type { VaultBridgeSettings } from "../settings";
import type { IFileSystem } from "../fs/interface";
import type { IBackendProvider } from "../fs/backend";
import type { Logger } from "../logging/logger";
import { AsyncMutex } from "../queue/async-queue";
import { computeScopeFingerprint } from "./scope-fingerprint";
import { isExcludedFromSync } from "./sync-scope";
import { SyncStateStore } from "./state";
import { LocalChangeTracker, type TrackerSnapshot } from "./local-tracker";
import { collectChanges } from "./change-detector";
import { planSync } from "./decision-engine";
import { refinePlan } from "./rename-optimizer";
import { executePlan, toConflictRecords, DESKTOP_TRANSFER_POOL, MOBILE_TRANSFER_POOL } from "./plan-executor";
import type { ExecutionContext, ExecutionResult } from "./plan-executor";
import { classifyHttpError } from "../fs/errors";
import { decideRetry, sleep } from "./error";
import type { ConflictRecord, SyncStatus, SyncAction } from "./types";
import { pullIfFastForward } from "./pull-single";
import { CycleSummary } from "./sync-notification";
import type { SyncCycleResult } from "./sync-notification";
import {
	enforceListingCompleteness,
	SuspiciousListingError,
	protectFoldersWithSurvivors,
	deletionKey,
} from "./deletion-guard";
import { FailedActionTracker } from "./failed-action-tracker";
import { HeldDeletions } from "./held-deletions";

export type { SyncStatus };

export interface SyncOrchestratorDeps {
	getSettings: () => VaultBridgeSettings;
	saveSettings: () => Promise<void>;
	/** The vault's configured config directory (`Vault#configDir`), for config sync. */
	configDir: () => string;
	/** This plugin's manifest id (`Plugin#manifest.id`), for config sync. */
	pluginId: () => string;
	localFs: () => IFileSystem | null;
	remoteFs: () => IFileSystem | null;
	backendProvider: () => IBackendProvider | null;
	onStatusChange: (status: SyncStatus) => void;
	onProgress: (text: string) => void;
	notify: (message: string, durationMs?: number) => void;
	/** Returns true when running on mobile (used for mobile sync restrictions) */
	isMobile: () => boolean;
	/** Returns true when the backend is in the process of connecting */
	isBackendConnecting?: () => boolean;
	/** Returns true when the Obsidian workspace layout is ready (vault index loaded) */
	isLayoutReady?: () => boolean;
	localTracker: LocalChangeTracker;
	logger?: Logger;
	/** Persist a cycle's resolved conflicts to the audit history (once per cycle). */
	recordConflicts?: (records: ConflictRecord[]) => Promise<void>;
	/** Update the active conflict tracker dashboard file (sync-conflicts.md). */
	updateConflictTracker?: (newConflictPaths: string[]) => Promise<void>;
	/** Called when deletions are quarantined so the UI can surface an approve/reject action. */
	onDeletionsHeld?: (held: SyncAction[]) => void;
}

const MAX_RETRIES = 3;

export class SyncOrchestrator {
	private syncMutex = new AsyncMutex();
	private stateStore: SyncStateStore;
	private syncPending = false;
	/** Deletions held for review by the mass-deletion guard, and the user's approvals. */
	private readonly heldDeletions = new HeldDeletions();
	/**
	 * A cycle that ended with failures may have advanced the backend's in-memory
	 * delta cursor past work it never committed (the committed checkpoint is held
	 * back, but the live FS cursor is not re-seeded same-process). Force the next
	 * cycle cold — a full list × baseline join recovers it regardless of cursor.
	 */
	private recoverViaColdScan = false;
	private failedActionTracker = new FailedActionTracker();
	/** Stable id grouping this plugin session's conflict-history records. */
	private readonly sessionId = crypto.randomUUID();
	private deps: SyncOrchestratorDeps;

	constructor(deps: SyncOrchestratorDeps) {
		this.deps = deps;
		const vaultId = deps.getSettings().vaultId;
		this.stateStore = new SyncStateStore(vaultId);
	}

	get state(): SyncStateStore {
		return this.stateStore;
	}

	isSyncing(): boolean {
		return this.syncMutex.isLocked;
	}

	get isLocked(): boolean {
		return this.syncMutex.isLocked;
	}

	async close(): Promise<void> {
		await this.stateStore.close();
	}

	async clearSyncState(): Promise<void> {
		await this.syncMutex.run(async () => {
			this.deps.logger?.info("Clearing sync state");
			await this.stateStore.clear();
		});
	}

	/** Returns the deletions currently quarantined by the limit or velocity guard. */
	getPendingDeletions(): SyncAction[] {
		return this.heldDeletions.pending();
	}

	/**
	 * Approve held deletions and run a sync that applies them. Also resets the
	 * velocity window so the approved count doesn't immediately re-trigger the
	 * rolling cap.
	 *
	 * When `actionsToApprove` is provided, only those specific deletions are approved
	 * and any unapproved deletions remain quarantined. Defaults to approving all
	 * currently pending deletions.
	 *
	 * The held actions are NOT replayed. They were planned in an earlier cycle, and a
	 * file edited or re-created since then must not be deleted from that stale plan.
	 * The sync re-detects each held path from current state; only deletions it still
	 * plans for an approved (action, path) pair bypass the guards.
	 */
	async approvePendingDeletions(actionsToApprove?: readonly SyncAction[]): Promise<void> {
		const count = this.heldDeletions.approve(actionsToApprove);
		if (count === 0) return;
		this.deps.logger?.info("Held deletions approved", { count });
		await this.runSync();
	}

	shouldSync(): boolean {
		const hasRemote = !!this.deps.remoteFs();
		const isLocked = this.syncMutex.isLocked;
		const isConnecting = this.deps.isBackendConnecting?.() ?? false;
		const isLayoutReady = this.deps.isLayoutReady?.() ?? true;
		if (!hasRemote || isLocked || isConnecting || !isLayoutReady) {
			this.deps.logger?.debug("shouldSync: skipped", { hasRemote, isLocked, isConnecting, isLayoutReady });
		}
		return hasRemote && !isLocked && !isConnecting && isLayoutReady;
	}

	/** Whether `path` is outside the sync scope (see {@link isExcludedFromSync}). */
	isExcluded(path: string): boolean {
		return isExcludedFromSync(path, this.deps.getSettings(), this.deps.configDir(), this.deps.pluginId());
	}

	/**
	 * Discard the committed remote checkpoint and run a sync, forcing one cold
	 * reconcile (full list × baseline). The reset runs UNDER syncMutex so it can't
	 * clear the live FS cache/cursor mid-cycle and corrupt an in-flight sync; the
	 * subsequent runSync then sees no checkpoint and goes cold.
	 */
	async rescan(): Promise<void> {
		await this.syncMutex.run(() => this.deps.remoteFs()?.checkpoint?.resetCheckpoint());
		await this.runSync();
	}

	async runSync(): Promise<void> {
		const remoteFs = this.deps.remoteFs();
		if (!remoteFs) {
			this.deps.onStatusChange("not_connected");
			this.deps.logger?.debug("runSync: skipped — no remote backend");
			return;
		}

		if (this.deps.isBackendConnecting?.()) {
			this.deps.logger?.debug("runSync: skipped — backend connecting");
			return;
		}

		if (!(this.deps.isLayoutReady?.() ?? true)) {
			this.deps.logger?.debug("runSync: skipped — layout not ready");
			return;
		}

		// A runSync arriving while locked is a debounce-fired VAULT change (or a
		// rescan): set syncPending so the do/while runs another cycle and the
		// snapshot-surviving dirty path is consumed on HOT. SIGNAL triggers never
		// reach here — triggerSync's isSyncing() guard already dropped them. Do not
		// recast syncPending as "dirty exists": markDirty does not set it, so a
		// dirty-count loop would bypass the 5s debounce and tight-loop during
		// continuous editing (ADR 0004).
		if (this.syncMutex.isLocked) {
			this.syncPending = true;
			return;
		}

		await this.syncMutex.run(async () => {
			// Coalesce every cycle in this burst into ONE end-of-run notice (see
			// CycleSummary): a mobile resume firing focus + visibilitychange
			// back-to-back must not show "Everything up to date" twice.
			const summary = new CycleSummary();
			do {
				this.syncPending = false;
				this.deps.onStatusChange("syncing");

				// One snapshot per cycle, captured above the retry loop, drives both
				// detection and the acknowledge (see TrackerSnapshot for why).
				const snapshot = this.deps.localTracker.snapshot();

				// Force a full cold reconcile when delta-based detection can't be
				// trusted: no committed remote checkpoint (last sync never completed
				// or was reset), or the previous cycle failed (its in-memory cursor
				// may have advanced past un-committed work). Cold recovers either via
				// a full list × baseline join. The checkpoint (delta cursor) lives in
				// the backend's own store now, so this is an async FS query.
				const noCheckpoint = remoteFs.checkpoint
					? !(await remoteFs.checkpoint.hasCheckpoint())
					: false;
				const scopeFingerprint = await computeScopeFingerprint(
					this.deps.getSettings(),
					this.deps.configDir(),
					this.deps.pluginId(),
				);
				const scopeChanged = remoteFs.checkpoint?.getScopeFingerprint
					? (await remoteFs.checkpoint.getScopeFingerprint()) !== scopeFingerprint
					: false;
				const forceFullScan = noCheckpoint || this.recoverViaColdScan || scopeChanged;
				this.deps.logger?.info("Sync started", { forceFullScan, scopeChanged });

				const result = await this.executeWithRetry(forceFullScan, snapshot, scopeFingerprint);
				if (!result) return; // Fatal error already handled

				const { succeeded, failed, blocked, conflicts } = result;
				// If failures are all quarantined permanent local-origin actions, cold scan is not needed next cycle
				this.recoverViaColdScan = this.needsColdRecovery(result.result);
				if (failed > 0 || blocked > 0) {
					this.deps.onStatusChange("partial_error");
					this.deps.logger?.warn("Sync completed with errors", { succeeded, conflicts, failed, blocked });
				} else {
					this.deps.onStatusChange("idle");
					this.deps.logger?.info("Sync completed", { succeeded, conflicts, failed, blocked });
				}

				summary.add(result.result);

				// Record this cycle's resolved conflicts to the audit history — once per
				// cycle, and only when there were any. Writing stays separate from
				// resolution: the resolver produced the outcomes, this just persists them.
				// Best-effort: the audit write is supplementary, so a failure here must not
				// turn an otherwise-clean cycle into a reported error nor skip the dirty-path
				// acknowledgment below — log it and carry on.
				const conflictRecords = result.result.conflicts;
				if (conflictRecords.length > 0) {
					await this.deps.recordConflicts?.(toConflictRecords(conflictRecords,
						this.deps.getSettings().conflictStrategy, this.sessionId, new Date().toISOString()))
						?.catch((err) => this.deps.logger?.warn("Failed to record conflict history", { message: err instanceof Error ? err.message : String(err) }));
				}
				const mergedConflictPaths = conflictRecords
					.filter(c => c.resolution.action === "merged" && c.resolution.hasConflictMarkers)
					.map(c => c.action.path);
				await this.deps.updateConflictTracker?.(mergedConflictPaths)
					?.catch((err) => this.deps.logger?.warn("Failed to update conflict tracker", { message: err instanceof Error ? err.message : String(err) }));

				await this.deps.logger?.flush();

				this.deps.localTracker.acknowledge(snapshot);
			} while (this.syncPending);

			// One notice per burst, gated on its OWN setting (`enableLogging` controls
			// only whether logs are written — it used to double as this gate).
			if (this.deps.getSettings().showSyncNotifications) {
				this.deps.notify(summary.message);
			}
		});
	}

	/**
	 * Execute sync with retry logic. Returns null on fatal error (already reported).
	 */
	private async executeWithRetry(
		forceFullScan: boolean,
		snapshot: TrackerSnapshot,
		scopeFingerprint: string,
	): Promise<SyncCycleResult | null> {
		let lastError: unknown = null;
		let lastResult: ExecutionResult | null = null;

		for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
			try {
				lastResult = await this.executeSyncOnce(forceFullScan, snapshot, scopeFingerprint);
				return {
					result: lastResult,
					succeeded: lastResult.succeeded.length,
					failed: lastResult.failed.length,
					blocked: lastResult.blocked.length,
					conflicts: lastResult.conflicts.length,
				};
			} catch (err) {
				lastError = err;
				if (err instanceof SuspiciousListingError) {
					this.deps.onStatusChange("error");
					this.deps.notify(
						`Sync stopped: the ${err.side} file listing looks incomplete ` +
						`(${err.listedCount} of ${err.baselineCount} known files). ` +
						`No changes were made. Try "Rescan" once the issue is resolved.`,
						15_000,
					);
					this.deps.logger?.warn("Suspicious listing — sync aborted", {
						side: err.side, listedCount: err.listedCount, baselineCount: err.baselineCount,
					});
					await this.deps.logger?.flush();
					// Explicitly clear recoverViaColdScan: returning null early skips the
					// normal `failed > 0` update in runSync, so without this the flag stays
					// true and the next sync is cold again — triggering this error in a loop.
					this.recoverViaColdScan = false;
					return null;
				}
				// Classification is the backend's job (it knows its own error shapes,
				// e.g. that Google 403 can mean rate-limit); the retry POLICY is the
				// engine's and stays backend-neutral. Fall back to the generic HTTP
				// classifier for backends that don't override it.
				const provider = this.deps.backendProvider();
				const classification = provider?.classifyError?.(err) ?? classifyHttpError(err);
				this.deps.logger?.error(
					`Sync error (attempt ${attempt}/${MAX_RETRIES})`,
					{ kind: classification.kind, message: err instanceof Error ? err.message : String(err) },
				);

				const decision = decideRetry(classification, attempt, MAX_RETRIES, Math.random);
				if (decision.action === "abort") {
					this.deps.onStatusChange("error");
					if (classification.kind === "storageFull") {
						// Storage-full is a clean abort: don't force a cold scan on the next
						// cycle — the listing state is fine, the remote is just over quota.
						this.recoverViaColdScan = false;
						this.deps.notify(
							`Sync stopped: your ${provider?.displayName ?? "remote storage"} is full. ` +
							`Free up space, then tap "Sync now".`,
							15_000,
						);
					} else {
						this.deps.notify(decision.kind === "auth"
							? "Authentication error. Please reconnect in settings."
							: `Permission denied. Please check your ${provider?.displayName ?? "remote backend"} permissions.`);
					}
					return null;
				}
				// "stop" (e.g. 404) and "exhausted" both fall through to the generic
				// failure handler below; only "retry" waits and loops.
				if (decision.action !== "retry") break;
				await sleep(decision.delayMs);
			}
		}

		this.deps.onStatusChange("error");
		const msg = lastError instanceof Error ? lastError.message : "Unknown error";
		this.deps.notify(`Sync error: ${msg}`);
		this.deps.logger?.error("Sync failed after retries", { message: msg });
		await this.deps.logger?.flush();
		return null;
	}

	async pullSingle(path: string): Promise<void> {
		if (this.isExcluded(path)) {
			this.deps.logger?.debug("pullSingle: skipped — out of sync scope", { path });
			return;
		}
		await this.syncMutex.run(async () => {
			const localFs = this.deps.localFs();
			const remoteFs = this.deps.remoteFs();
			if (!localFs || !remoteFs) {
				this.deps.logger?.warn("pullSingle: skipped — no local or remote fs", { path });
				return;
			}

			await pullIfFastForward(path, {
				localFs,
				remoteFs,
				stateStore: this.stateStore,
				localTracker: this.deps.localTracker,
				logger: this.deps.logger,
			});
		});
	}

	getStatus(): SyncStatus {
		return this.syncMutex.isLocked ? "syncing" : "idle";
	}

	private async executeSyncOnce(
		forceFullScan: boolean,
		snapshot: TrackerSnapshot,
		scopeFingerprint: string,
	) {
		const localFs = this.deps.localFs();
		const remoteFs = this.deps.remoteFs();
		if (!localFs || !remoteFs) {
			throw new Error("Cannot sync: local or remote filesystem is not available");
		}
		const settings = this.deps.getSettings();

		const changeSet = await collectChanges({
			localFs,
			remoteFs,
			stateStore: this.stateStore,
			changes: snapshot,
			// Exclude at the source so ignored files are never stat()'d or content-read
			// (enrichment) — see ChangeDetectorDeps.isExcluded. The post-detection
			// filter below now only carries the mobile file-size cap.
			isExcluded: (path) => this.isExcluded(path),
		}, {
			forceFullScan,
			// Re-evaluate held deletions every cycle until they are approved or no longer
			// planned — the delta cursor has already moved past remote-origin ones.
			extraPaths: this.heldDeletions.pending().map((a) => a.path),
		});

		const { renamePairs, folderRenamePairs } = snapshot;
		const remoteOnlyPaths = changeSet.entries.filter((e) => !e.local && e.remote).map((e) => e.path);
		this.deps.logger?.info("Change detection completed", {
			temperature: changeSet.temperature,
			entries: changeSet.entries.length,
			localOnly: changeSet.entries.filter((e) => e.local && !e.remote).length,
			remoteOnly: remoteOnlyPaths.length,
			both: changeSet.entries.filter((e) => e.local && e.remote).length,
			enriched: changeSet.entries.filter((e) => e.local?.hash && !e.prevSync).length,
			renamePairs: renamePairs.size,
		});
		if (remoteOnlyPaths.length > 0) {
			this.deps.logger?.debug("Remote-only paths", { paths: remoteOnlyPaths });
		}
		if (renamePairs.size > 0) {
			const rpPaths = new Set([...renamePairs.keys(), ...renamePairs.values()]);
			const rpEntries = changeSet.entries
				.filter((e) => rpPaths.has(e.path))
				.map((e) => ({
					path: e.path,
					local: !!e.local,
					remote: !!e.remote,
					prevSync: !!e.prevSync,
					hash: (e.local?.hash || e.prevSync?.hash || "").substring(0, 8) || undefined,
				}));
			this.deps.logger?.debug("Rename entry details", { entries: rpEntries });
		}

		// Cold scans are the post-failure recovery path: a truncated listing looks
		// identical to "user deleted everything." Abort before planning when either
		// side's listing is suspiciously sparse relative to the known baseline.
		// Directories count on both sides: folders are baselined too, so counting only
		// files against every record would misread a folder-heavy vault as truncated.
		if (changeSet.temperature === "cold") {
			const localCount = changeSet.entries.filter((e) => e.local).length;
			const remoteCount = changeSet.entries.filter((e) => e.remote).length;
			const baselineCount = changeSet.entries.filter((e) => e.prevSync).length;
			enforceListingCompleteness(localCount, remoteCount, baselineCount);
		}

		// Exclusion now happens at detection (collectChanges' isExcluded); this filter
		// carries only the mobile file-size cap, applied after detection so an
		// oversized file still gets a record-aware decision rather than vanishing.
		const isMobile = this.deps.isMobile();
		const maxBytes = settings.mobileMaxFileSizeMB * 1024 * 1024;
		const filtered = !isMobile ? changeSet.entries : changeSet.entries.filter((e) => {
			const size = Math.max(e.local?.size ?? 0, e.remote?.size ?? 0);
			return size <= maxBytes;
		});

		if (filtered.length !== changeSet.entries.length) {
			this.deps.logger?.debug("Files filtered", {
				total: changeSet.entries.length,
				afterFilter: filtered.length,
				excluded: changeSet.entries.length - filtered.length,
			});
		}

		if (folderRenamePairs.size > 0) {
			this.deps.logger?.info("Folder rename pairs detected", {
				count: folderRenamePairs.size,
				pairs: [...folderRenamePairs.entries()].map(([n, o]) => `${o} → ${n}`),
			});
		}
		const { plan, protectedFolders } = protectFoldersWithSurvivors(refinePlan(
			planSync(filtered),
			renamePairs,
			folderRenamePairs,
			changeSet.remoteRenamePairs,
			this.deps.logger,
		));
		if (protectedFolders.length > 0) {
			this.deps.logger?.info("Kept folders that still hold synced content", { folders: protectedFolders });
		}

		const actionBreakdown: Record<string, number> = {};
		for (const a of plan.actions) {
			actionBreakdown[a.action] = (actionBreakdown[a.action] ?? 0) + 1;
		}
		this.deps.logger?.info("Sync plan created", {
			total: plan.actions.length,
			...actionBreakdown,
		});

		// Split deletions from safe actions. Over-limit or velocity-exceeding deletions
		// are quarantined: the safe actions (pushes, pulls, merges) still execute this
		// cycle, and the user is notified to approve the held deletions separately.
		// Deletions the user already approved are neither counted nor held.
		const { executionPlan, held, velocityBlocked, isNewHold } =
			this.heldDeletions.gate(plan, settings.maxDeletionsPerSync);
		if (held.length > 0) {
			this.deps.logger?.warn("Deletions quarantined", {
				held: held.length,
				velocityBlocked,
				safe: executionPlan.actions.length,
				paths: held.slice(0, 50).map(deletionKey),
			});
			if (isNewHold) {
				this.deps.notify(
					`${held.length} deletions held for review — everything else synced. ` +
					`Run the "Approve held deletions" command to apply them.`,
					15_000,
				);
				this.deps.onDeletionsHeld?.(held);
			}
		}

		const total = executionPlan.actions.length;

		const provider = this.deps.backendProvider();
		const ctx: ExecutionContext = {
			localFs,
			remoteFs,
			committer: {
				stateStore: this.stateStore,
				enableThreeWayMerge: settings.enableThreeWayMerge,
				localFs,
				logger: this.deps.logger,
			},
			conflictStrategy: settings.conflictStrategy,
			onProgress: (completed: number) => {
				if (total > 0) this.deps.onProgress(`Syncing ${completed}/${total}...`);
			},
			logger: this.deps.logger,
			classifyError: (err) => provider?.classifyError?.(err) ?? classifyHttpError(err),
			isActionBlocked: (action) => this.failedActionTracker.isBlocked(settings.backendType, action),
			transferPool: this.deps.isMobile() ? MOBILE_TRANSFER_POOL : DESKTOP_TRANSFER_POOL,
		};

		const result = await executePlan(executionPlan, ctx);
		this.heldDeletions.endCycle();
		const classifyError = (err: unknown) => provider?.classifyError?.(err) ?? classifyHttpError(err);
		this.failedActionTracker.recordCycle(settings.backendType, result, classifyError);

		// Persist backend state. commitCheckpoint advances the delta cursor (+ file map,
		// atomically) only on a fully clean cycle; a partial sync keeps the prior cursor.
		// Held deletions also keep it: the persisted cursor then still precedes the
		// remote deletions being held, so a restart replays and re-holds them instead of
		// forgetting them (and later resurrecting the files on the other side).
		const cleanCycle = result.failed.length === 0 && held.length === 0;
		// The checkpoint lives on the FS now (no provider downcast): flush it only on a
		// fully clean cycle so a partial sync keeps the prior committed cursor.
		if (cleanCycle && remoteFs?.checkpoint) {
			await remoteFs.checkpoint.commitCheckpoint({ scopeFingerprint });
		}
		// readBackendState now persists only non-secret token state (the cursor lives
		// in the backend store, committed above) — safe to run every cycle as long as
		// the backend is still connected and not tearing down.
		if (this.deps.remoteFs() && !this.deps.isBackendConnecting?.()) {
			if (provider?.readBackendState) {
				settings.backendData = {
					...settings.backendData,
					...provider.readBackendState(),
				};
			}
			await this.deps.saveSettings();
		}

		return result;
	}

	private needsColdRecovery(result: ExecutionResult): boolean {
		const provider = this.deps.backendProvider();
		return this.failedActionTracker.needsColdRecovery(
			this.deps.getSettings().backendType,
			result,
			(err) => provider?.classifyError?.(err) ?? classifyHttpError(err),
		);
	}
}
