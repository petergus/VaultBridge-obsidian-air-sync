import type { SyncAction, SyncPlan } from "./types";
import type { Logger } from "../logging/logger";

export interface DeletionCounts {
	local: number;
	remote: number;
	total: number;
}

/**
 * The minimum fraction of baseline-tracked files that must appear in a listing
 * before we trust it. A cold scan returning fewer than this fraction of known
 * files is treated as an incomplete or truncated listing — acting on it would
 * drive mass deletions on the other side. 0.5 = abort when ≥50% of known files
 * are missing from the scan.
 */
const LISTING_COMPLETENESS_THRESHOLD = 0.5;

/**
 * Rolling window for cumulative deletion velocity. If the total number of
 * deletions executed across multiple cycles within this window exceeds
 * VELOCITY_LIMIT, the next cycle's deletions are quarantined.
 */
const VELOCITY_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const VELOCITY_LIMIT = 100;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SuspiciousListingError extends Error {
	readonly side: "local" | "remote";
	readonly listedCount: number;
	readonly baselineCount: number;

	constructor(side: "local" | "remote", listedCount: number, baselineCount: number) {
		super(
			`Suspicious ${side} listing: only ${listedCount} of ${baselineCount} known files appeared in the scan. ` +
			`Sync aborted to prevent mass deletions on the other side. ` +
			`Try "Rescan" once the ${side === "remote" ? "remote backend" : "vault"} is accessible.`,
		);
		this.name = "SuspiciousListingError";
		this.side = side;
		this.listedCount = listedCount;
		this.baselineCount = baselineCount;
	}
}

export class MassDeletionBlockedError extends Error {
	readonly counts: DeletionCounts;
	readonly limit: number;

	constructor(counts: DeletionCounts, limit: number) {
		super(
			`Planned ${counts.total} deletions (${counts.local} local, ${counts.remote} remote), exceeding the limit of ${limit}`,
		);
		this.name = "MassDeletionBlockedError";
		this.counts = counts;
		this.limit = limit;
	}
}

// ---------------------------------------------------------------------------
// Reporters
// ---------------------------------------------------------------------------

interface DeletionBlockReporter {
	onStatusChange: (status: "error") => void;
	notify: (message: string, durationMs?: number) => void;
	logger?: Logger;
}

export async function reportMassDeletionBlock(
	err: MassDeletionBlockedError,
	reporter: DeletionBlockReporter,
): Promise<null> {
	reporter.onStatusChange("error");
	reporter.notify(
		`Sync stopped: ${err.counts.total} deletions were planned (${err.counts.local} local, ${err.counts.remote} remote), above your limit of ${err.limit}. Review the affected devices, then change "Maximum deletions per sync" in Advanced settings if this was intentional.`,
		15_000,
	);
	reporter.logger?.warn("Mass deletion plan blocked", {
		limit: err.limit,
		localDeletions: err.counts.local,
		remoteDeletions: err.counts.remote,
	});
	await reporter.logger?.flush();
	return null;
}

// ---------------------------------------------------------------------------
// Plan splitting
// ---------------------------------------------------------------------------

export interface SplitPlan {
	/** Actions that are safe to execute immediately (no deletions). */
	safe: SyncPlan;
	/** Deletion actions quarantined because they exceeded the limit or velocity. */
	held: SyncAction[];
	/** Whether the held set is non-empty (convenience flag). */
	hasHeld: boolean;
}

/**
 * Split a sync plan into safe (non-deletion) actions and held (deletion) actions
 * when the deletion count exceeds the configured limit.
 *
 * Unlike the old `enforceDeletionLimit` (which threw and aborted everything),
 * this lets pushes, pulls, renames, and merges proceed while quarantining only
 * the over-limit deletions. The caller surfaces the held list to the user.
 *
 * When the deletion count is within the limit, `held` is empty and `safe`
 * contains the full plan — no change in behaviour.
 */
export function splitPlanAtLimit(plan: SyncPlan, configuredLimit: number): SplitPlan {
	const limit = Math.floor(configuredLimit);
	const limitActive = Number.isFinite(limit) && limit > 0;

	let local = 0;
	let remote = 0;
	for (const action of plan.actions) {
		if (action.action === "delete_local") local++;
		else if (action.action === "delete_remote") remote++;
	}

	const total = local + remote;
	if (!limitActive || total <= limit) {
		return { safe: plan, held: [], hasHeld: false };
	}

	const safe: SyncAction[] = [];
	const held: SyncAction[] = [];
	for (const action of plan.actions) {
		if (action.action === "delete_local" || action.action === "delete_remote") {
			held.push(action);
		} else {
			safe.push(action);
		}
	}
	return { safe: { actions: safe }, held, hasHeld: true };
}

/**
 * @deprecated Use `splitPlanAtLimit` instead. Kept for tests that reference
 * the old throwing behaviour; will be removed once all callers migrate.
 */
export function enforceDeletionLimit(plan: SyncPlan, configuredLimit: number): void {
	const limit = Math.floor(configuredLimit);
	if (!Number.isFinite(limit) || limit <= 0) return;

	let local = 0;
	let remote = 0;
	for (const action of plan.actions) {
		if (action.action === "delete_local") local++;
		else if (action.action === "delete_remote") remote++;
	}

	const total = local + remote;
	if (total > limit) {
		throw new MassDeletionBlockedError({ local, remote, total }, limit);
	}
}

// ---------------------------------------------------------------------------
// Listing completeness guard
// ---------------------------------------------------------------------------

/**
 * Abort a cold-scan cycle when either side's listing is suspiciously sparse
 * relative to the known baseline. A cold scan that returns far fewer files than
 * the store knows about is almost certainly incomplete (post-failure cursor
 * stale, truncated API response, network error mid-listing) — acting on it
 * would delete the "missing" files from the other side.
 *
 * Only meaningful for cold scans (warm uses a delta cursor; hot operates on a
 * known-dirty subset). Call BEFORE planSync.
 */
export function enforceListingCompleteness(
	localCount: number,
	remoteCount: number,
	baselineCount: number,
): void {
	if (baselineCount < 10) return;

	const threshold = Math.floor(baselineCount * LISTING_COMPLETENESS_THRESHOLD);
	if (localCount < threshold) {
		throw new SuspiciousListingError("local", localCount, baselineCount);
	}
	if (remoteCount < threshold) {
		throw new SuspiciousListingError("remote", remoteCount, baselineCount);
	}
}

// ---------------------------------------------------------------------------
// Velocity tracker
// ---------------------------------------------------------------------------

interface DeletionEvent {
	count: number;
	ts: number;
}

/**
 * Tracks deletions executed across sync cycles within a rolling time window.
 * Used to detect slow-drip deletion: repeated small batches that individually
 * stay under `maxDeletionsPerSync` but together would constitute a mass deletion.
 *
 * The tracker is in-memory only (survives the plugin session, not app restarts).
 * It intentionally does not use IndexedDB — its purpose is to catch a runaway
 * sync session, not to accumulate history. A fresh app start clears the slate.
 */
export class DeletionVelocityTracker {
	private events: DeletionEvent[] = [];

	/** Record that `count` deletions were executed right now. */
	record(count: number, now = Date.now()): void {
		if (count <= 0) return;
		this.events.push({ count, ts: now });
	}

	/**
	 * Sum of deletions recorded within `windowMs` of `now`.
	 * Prunes expired events as a side-effect.
	 */
	windowTotal(windowMs = VELOCITY_WINDOW_MS, now = Date.now()): number {
		const cutoff = now - windowMs;
		this.events = this.events.filter((e) => e.ts >= cutoff);
		return this.events.reduce((sum, e) => sum + e.count, 0);
	}

	/** True when the pending deletions, added to the window total, would exceed the limit. */
	wouldExceedVelocityLimit(pendingCount: number, now = Date.now()): boolean {
		return this.windowTotal(VELOCITY_WINDOW_MS, now) + pendingCount > VELOCITY_LIMIT;
	}

	/** Reset all recorded events (e.g. after user explicitly approves held deletions). */
	reset(): void {
		this.events = [];
	}
}

export { VELOCITY_LIMIT, VELOCITY_WINDOW_MS };
