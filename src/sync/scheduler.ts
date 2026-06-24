import { debounce, TFolder } from "obsidian";
import type { EventRef, Workspace, Vault, TAbstractFile, TFile } from "obsidian";
import type { IFileSystem } from "../fs/interface";
import type { SyncStateStore } from "./state";
import type { LocalChangeTracker } from "./local-tracker";
import { hasChanged, hasRemoteChanged } from "./change-compare";

/**
 * Default edit-debounce window (ms): a vault change schedules a sync this long after
 * the last edit, coalescing a burst of edits into one cycle. Used as the fallback
 * when no `debounceMs` dep is supplied (e.g. tests). The live value is
 * user-configurable (`syncDebounceSec`) — a longer window means fewer radio wakeups
 * during active editing, at the cost of a little sync latency. Because Obsidian's
 * `debounce()` bakes its timeout in at creation, the live override is applied by
 * recreating the debouncer when the value changes (see `scheduleDebouncedSync`).
 *
 * Automatic triggers are additionally OFFLINE-GATED: when `pauseWhenOffline()` is on
 * and `isOnline()` is false, the debounced-sync callback, the foreground-resume
 * signals, and the file-open priority pull early-return so the device doesn't burn the
 * radio on doomed network calls + retry backoff while offline. Edits keep accumulating
 * in the dirty set and flush on the next `online` event (`triggerSync`, never gated —
 * the device is online there by definition). Manual "Sync now" is not gated.
 */
const DEBOUNCE_MS = 5000;

/**
 * Default minimum gap between two FOREGROUND-triggered remote re-checks, used when
 * no `cooldownMs` dep is supplied (e.g. tests). A genuine return (background→
 * foreground on mobile, app-switch on desktop/tablet) normally fires a sync, but on
 * mobile the app is backgrounded and resumed constantly — each resume would
 * otherwise wake the radio for a full remote delta fetch, draining battery for no
 * real change. Within this window a resume is acknowledged but does NOT re-scan the
 * remote; `departed` is left set so the first return AFTER the window still syncs
 * (never a stale miss). Local edits are unaffected — they sync through the
 * independent debounced vault-change path. The live value is user-configurable
 * (`foregroundSyncCooldownSec`); `0` disables the throttle. See ADR 0007.
 */
const DEFAULT_FOREGROUND_SYNC_COOLDOWN_MS = 60_000;

export interface SyncOrchestrator {
	runSync(): Promise<void>;
	pullSingle(path: string): Promise<void>;
	isSyncing(): boolean;
}

export interface SyncSchedulerDeps {
	workspace: Workspace;
	vault: Vault;
	localFs: () => IFileSystem | null;
	remoteFs: () => IFileSystem | null;
	stateStore: SyncStateStore;
	localTracker: LocalChangeTracker;
	orchestrator: SyncOrchestrator;
	isExcluded: (path: string) => boolean;
	registerEvent: (ref: EventRef) => void;
	registerWindowEvent: (type: keyof WindowEventMap, cb: () => void) => void;
	registerDocumentEvent: (type: keyof DocumentEventMap, cb: () => void) => void;
	/** Injectable clock for the foreground-sync cooldown; defaults to Date.now. */
	now?: () => number;
	/**
	 * Live foreground-sync cooldown in milliseconds (read per signal so a settings
	 * change applies without re-wiring). `0` disables the throttle. Defaults to
	 * DEFAULT_FOREGROUND_SYNC_COOLDOWN_MS when omitted.
	 */
	cooldownMs?: () => number;
	/** Whether the device reports a network connection. Defaults to navigator.onLine. */
	isOnline?: () => boolean;
	/** Whether automatic sync should be held while offline. Defaults to off. */
	pauseWhenOffline?: () => boolean;
	/**
	 * Live edit-debounce window in milliseconds (read per scheduled edit so a settings
	 * change applies without re-wiring). Defaults to DEBOUNCE_MS when omitted.
	 */
	debounceMs?: () => number;
}

export class SyncScheduler {
	private deps: SyncSchedulerDeps;
	private debouncedSync: ReturnType<typeof debounce>;
	private destroyed = false;
	/**
	 * Whether the app has left the foreground since it was last in sync. A
	 * foreground signal (focus / visibilitychange→visible) re-checks the remote
	 * only when this is true — a genuine background→foreground (mobile) or
	 * app-switch (desktop/tablet) return. It starts false: at cold start the
	 * onLayoutReady catch-up sync already covers the initial foreground, so the
	 * trailing foreground signal — the deferred-to-first-touch `focus` on mobile —
	 * is NOT a return and must not fire a second, redundant sync. See ADR 0007.
	 */
	private departed = false;
	/** Monotonic-ish timestamp of the last foreground-triggered sync (cooldown). */
	private lastForegroundSyncAt = 0;
	private readonly now: () => number;
	private readonly cooldownMs: () => number;
	private readonly isOnline: () => boolean;
	private readonly pauseWhenOffline: () => boolean;
	private readonly debounceMs: () => number;
	/** Timeout baked into the current `debouncedSync` instance (live override tracking). */
	private currentDebounceMs: number;

	constructor(deps: SyncSchedulerDeps) {
		this.deps = deps;
		this.now = deps.now ?? (() => Date.now());
		this.cooldownMs = deps.cooldownMs ?? (() => DEFAULT_FOREGROUND_SYNC_COOLDOWN_MS);
		this.isOnline = deps.isOnline ?? (() => navigator.onLine);
		this.pauseWhenOffline = deps.pauseWhenOffline ?? (() => false);
		this.debounceMs = deps.debounceMs ?? (() => DEBOUNCE_MS);
		this.currentDebounceMs = this.debounceMs();
		this.debouncedSync = this.makeDebouncedSync(this.currentDebounceMs);
	}

	private makeDebouncedSync(ms: number): ReturnType<typeof debounce> {
		return debounce(
			() => {
				// A debounce that fires while offline-gated is a no-op: leave the dirty
				// set intact so the next `online` event flushes the accumulated edits.
				if (this.isOfflineGated()) return;
				if (!this.deps.remoteFs()) return;
				void this.deps.orchestrator.runSync();
			},
			ms,
			true,
		);
	}

	/** True when automatic sync should be held because the device is offline. */
	private isOfflineGated(): boolean {
		return this.pauseWhenOffline() && !this.isOnline();
	}

	/**
	 * Route every edit-driven debounce through here so the live `debounceMs()` override
	 * takes effect: Obsidian's `debounce()` bakes its timeout in at creation, so when
	 * the configured window changes we cancel the stale instance and recreate it at the
	 * new interval before invoking.
	 */
	private scheduleDebouncedSync(): void {
		const ms = this.debounceMs();
		if (ms !== this.currentDebounceMs) {
			this.debouncedSync.cancel();
			this.currentDebounceMs = ms;
			this.debouncedSync = this.makeDebouncedSync(ms);
		}
		this.debouncedSync();
	}

	start(): void {
		if (this.deps.workspace.layoutReady) {
			this.wireAll();
		} else {
			// Defer event wiring until the vault index is loaded, so an early
			// focus/visibility/online/vault event cannot trigger a sync against
			// an incomplete local listing (getAllLoadedFiles under-reports).
			this.deps.workspace.onLayoutReady(() => this.wireAll());
		}
	}

	private wireAll(): void {
		// onLayoutReady may fire after the plugin unloads; do not wire then.
		if (this.destroyed) return;
		this.wireVaultEvents();
		this.wireOnlineEvent();
		this.wireVisibilityEvent();
		this.wireFocusEvent();
		this.wireDepartureEvents();
		this.wireFileOpenEvent();
	}

	destroy(): void {
		this.destroyed = true;
		this.debouncedSync.cancel();
	}

	/**
	 * The NETWORK signal path (online): re-check now, unless no backend or a sync
	 * is already running. The `isSyncing()` guard discards the request while a
	 * sync is in flight — the in-flight cycle already performs the full re-scan a
	 * signal asks for. It is load-bearing, NOT redundant with runSync's own lock
	 * check: runSync's check sets `syncPending` (a re-run), this one suppresses it
	 * for signals (ADR 0004). Foreground signals use triggerForegroundSync instead.
	 */
	private triggerSync(): void {
		if (!this.deps.remoteFs()) return;
		if (this.deps.orchestrator.isSyncing()) return;
		void this.deps.orchestrator.runSync();
	}

	/**
	 * The FOREGROUND signal path (focus / visibilitychange→visible). Re-checks the
	 * remote only on a genuine return — after the app actually left the foreground
	 * (`departed`). This drops the redundant cold-start signal (no departure since
	 * the onLayoutReady catch-up sync) while still syncing every real resume, with
	 * no timing window. If a sync is already in flight, return WITHOUT clearing
	 * `departed`: that cycle may predate the departure, so a later signal must
	 * still re-check — never miss a return (ADR 0007). The `departed` flag is
	 * cleared only here, when we actually run the resume sync.
	 */
	private triggerForegroundSync(): void {
		if (!this.deps.remoteFs()) return;
		// Offline: skip the doomed remote re-scan but leave `departed` set so the
		// first return after connectivity is back still syncs.
		if (this.isOfflineGated()) return;
		if (this.deps.orchestrator.isSyncing()) return;
		if (!this.departed) return;
		// Battery: a resume within the cooldown window is acknowledged but does NOT
		// re-scan the remote. Leave `departed` SET so the first return after the
		// window still syncs — skipping the scan must never become skipping the
		// return. Local edits during the window still sync via the debounced
		// vault-change path. See FOREGROUND_SYNC_COOLDOWN_MS.
		if (this.now() - this.lastForegroundSyncAt < this.cooldownMs()) return;
		this.departed = false;
		this.lastForegroundSyncAt = this.now();
		void this.deps.orchestrator.runSync();
	}

	// `focus` and `visibilitychange→visible` are BOTH wired on every platform —
	// not redundant. `focus` is the only return signal for a desktop alt-tab AND
	// a tablet split-view / Stage Manager app-switch: both keep the document
	// `visible`, so visibilitychange never fires there. On a phone background,
	// window focus is unreliable, so visibilitychange→visible is the dependable
	// return signal. Each covers a case the other misses across iOS/Android/
	// desktop, so neither can be dropped or platform-gated without losing a
	// resume somewhere. The cost — a real resume firing both — is absorbed by
	// triggerForegroundSync: the first clears `departed`, so the second is a
	// no-op (and a sync in flight blocks both via isSyncing). See ADR 0007.
	private wireFocusEvent(): void {
		this.deps.registerWindowEvent("focus", () => this.triggerForegroundSync());
	}

	private wireVaultEvents(): void {
		const { vault, localTracker, isExcluded } = this.deps;

		const onVaultChange = (file: TAbstractFile) => {
			if (!isExcluded(file.path)) {
				localTracker.markDirty(file.path);
				this.scheduleDebouncedSync();
			}
		};

		const onRename = (file: TAbstractFile, oldPath: string) => {
			if (!isExcluded(file.path) && !isExcluded(oldPath)) {
				if (file instanceof TFolder) {
					localTracker.markFolderRenamed(file.path, oldPath);
				} else {
					localTracker.markRenamed(file.path, oldPath);
				}
			} else {
				if (!isExcluded(file.path)) localTracker.markDirty(file.path);
				if (!isExcluded(oldPath)) localTracker.markDirty(oldPath);
			}
			if (!isExcluded(file.path) || !isExcluded(oldPath)) {
				this.scheduleDebouncedSync();
			}
		};

		this.deps.registerEvent(vault.on("create", onVaultChange));
		this.deps.registerEvent(vault.on("modify", onVaultChange));
		this.deps.registerEvent(vault.on("delete", onVaultChange));
		this.deps.registerEvent(vault.on("rename", onRename));
	}

	private wireOnlineEvent(): void {
		this.deps.registerWindowEvent("online", () => this.triggerSync());
	}

	// Paired with wireFocusEvent above (see that comment for why both exist).
	private wireVisibilityEvent(): void {
		this.deps.registerDocumentEvent("visibilitychange", () => {
			// App-level visibility: read the main document (matching the focus/
			// online listeners), not activeDocument — we want "Obsidian is
			// foreground", not whichever popout happens to be focused.
			if (document.visibilityState === "visible") {
				this.triggerForegroundSync();
			} else {
				// Backgrounding (phone/tablet) is a departure — the next foreground
				// signal is then a genuine return that should re-check.
				this.departed = true;
			}
		});
	}

	// Departure boundary, OR'd with visibilitychange→hidden so a genuine return is
	// never missed (a spurious departure only costs one extra re-check, never a
	// stale miss). `blur` is the ONLY departure signal for a desktop alt-tab AND a
	// tablet split-view / Stage Manager app-switch: both keep the document
	// `visible`, so visibilitychange→hidden never fires there. Window-level blur
	// fires on app focus loss — not on element focus or the soft keyboard — so it
	// does not mark spurious departures during normal editing. (Focusing an
	// Obsidian popout window does blur the main window → one harmless extra
	// re-check on return; not worth distinguishing.) See ADR 0007.
	private wireDepartureEvents(): void {
		this.deps.registerWindowEvent("blur", () => {
			this.departed = true;
		});
	}

	private wireFileOpenEvent(): void {
		const { workspace, stateStore, localFs, remoteFs, orchestrator } = this.deps;

		this.deps.registerEvent(
			workspace.on("file-open", async (file: TFile | null) => {
				if (!file) return;
				// Offline: don't wake the radio for the remote stat() priority pull.
				if (this.isOfflineGated()) return;
				const record = await stateStore.get(file.path);
				if (!record) return;
				const lFs = localFs();
				const rFs = remoteFs();
				if (!lFs || !rFs) return;
				const [localStat, remote] = await Promise.all([
					lFs.stat(file.path),
					rFs.stat(file.path),
				]);
				if (!remote || remote.isDirectory) return;
				if (!hasRemoteChanged(remote, record)) return;
				if (localStat && hasChanged(localStat, record)) return;
				await orchestrator.pullSingle(file.path);
			}),
		);
	}
}
