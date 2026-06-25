import type { SyncPlan } from "./types";

export interface DeletionCounts {
	local: number;
	remote: number;
	total: number;
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

/**
 * Abort a complete sync plan before any action runs when its deletion count
 * exceeds the configured cap. This runs after rename optimization so legitimate
 * renames are counted as renames rather than their pre-optimization delete half.
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
