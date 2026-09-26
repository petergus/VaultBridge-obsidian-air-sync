import type { SyncAction, SyncPlan } from "./types";
import {
	DeletionVelocityTracker,
	deletionKey,
	isDeletionAction,
	splitPlanAtLimit,
} from "./deletion-guard";

/** One cycle's outcome of the deletion guards. */
export interface DeletionGate {
	/** The plan to execute now: everything except the held deletions. */
	executionPlan: SyncPlan;
	/** Deletions quarantined this cycle (empty when nothing is held). */
	held: SyncAction[];
	/** The rolling velocity cap tripped, so every unapproved deletion is held. */
	velocityBlocked: boolean;
	/** The held set differs from last cycle's — the user should be told (once). */
	isNewHold: boolean;
}

/**
 * The mass-deletion guard's cross-cycle state: deletions quarantined for review, the
 * user's approvals, and the rolling deletion velocity. Each cycle's FRESH plan is gated
 * through {@link gate}; held deletions are never replayed from the plan that held them.
 */
export class HeldDeletions {
	private readonly velocity = new DeletionVelocityTracker();
	/**
	 * Deletions quarantined by the limit or velocity guard in the latest cycle, awaiting
	 * approval. Re-derived every cycle (their paths are re-evaluated from current state),
	 * so it never goes stale.
	 */
	private held: SyncAction[] = [];
	/**
	 * Keys ({@link deletionKey}) of held deletions the user approved. Consumed by the
	 * next executed cycle: a matching deletion in that cycle's fresh plan bypasses the
	 * limit and velocity guards; any other deletion is still guarded.
	 */
	private approvedKeys = new Set<string>();
	/** Keys of the last held set, so an unchanged hold doesn't re-notify every cycle. */
	private signature = "";

	/** The deletions currently quarantined by the limit or velocity guard. */
	pending(): SyncAction[] {
		return [...this.held];
	}

	/**
	 * Approve `actions` (default: every pending deletion) for the next cycle, and reset
	 * the velocity window so the approved count doesn't immediately re-trip the cap.
	 * Returns how many deletions were approved (0 = nothing to do).
	 */
	approve(actions: readonly SyncAction[] = this.held): number {
		if (actions.length === 0) return 0;
		this.approvedKeys = new Set(actions.map(deletionKey));
		this.velocity.reset();
		return this.approvedKeys.size;
	}

	/**
	 * Split a cycle's plan: over-limit or velocity-exceeding deletions are held, and the
	 * rest (pushes, pulls, renames, merges — and approved deletions) runs now. Records the
	 * deletions about to execute toward the velocity window.
	 */
	gate(plan: SyncPlan, maxDeletionsPerSync: number): DeletionGate {
		const approved = this.approvedKeys;
		const isApproved = (a: SyncAction) => approved.has(deletionKey(a));
		const unapprovedDeleteCount = plan.actions.filter((a) => isDeletionAction(a) && !isApproved(a)).length;
		const velocityBlocked = unapprovedDeleteCount > 0 &&
			this.velocity.wouldExceedVelocityLimit(unapprovedDeleteCount);
		const split = splitPlanAtLimit(plan, maxDeletionsPerSync, { holdAll: velocityBlocked, isApproved });

		this.held = split.held;
		const signature = split.held.map(deletionKey).sort().join("\n");
		const isNewHold = split.hasHeld && signature !== this.signature;
		this.signature = signature;

		const executedDeleteCount = split.safe.actions.filter(isDeletionAction).length;
		if (executedDeleteCount > 0) this.velocity.record(executedDeleteCount);

		return { executionPlan: split.safe, held: split.held, velocityBlocked, isNewHold };
	}

	/** The approval applied to the plan that just ran; later cycles are guarded again. */
	endCycle(): void {
		this.approvedKeys = new Set();
	}
}
