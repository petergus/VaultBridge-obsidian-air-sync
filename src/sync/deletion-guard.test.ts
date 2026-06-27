import { describe, it, expect } from "vitest";
import {
	enforceListingCompleteness,
	SuspiciousListingError,
	splitPlanAtLimit,
	DeletionVelocityTracker,
	VELOCITY_LIMIT,
	VELOCITY_WINDOW_MS,
} from "./deletion-guard";
import type { SyncPlan } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function plan(...actions: Array<{ path: string; action: string }>): SyncPlan {
	return { actions: actions as SyncPlan["actions"] };
}

// ---------------------------------------------------------------------------
// enforceListingCompleteness
// ---------------------------------------------------------------------------

describe("enforceListingCompleteness", () => {
	it("passes when both sides are fully populated", () => {
		expect(() => enforceListingCompleteness(100, 100, 100)).not.toThrow();
	});

	it("passes when baseline is below the minimum floor (< 10)", () => {
		// 0 local of 9 known — would trip the threshold but floor saves it
		expect(() => enforceListingCompleteness(0, 0, 9)).not.toThrow();
	});

	it("passes when baseline is exactly 10 but counts are above threshold", () => {
		// threshold = floor(10 * 0.5) = 5; local=6 passes
		expect(() => enforceListingCompleteness(6, 6, 10)).not.toThrow();
	});

	it("throws SuspiciousListingError for a sparse local listing", () => {
		// 20 baseline, threshold=10; local=9 < 10
		expect(() => enforceListingCompleteness(9, 20, 20))
			.toThrowError(SuspiciousListingError);
	});

	it("names the correct side when local is sparse", () => {
		try {
			enforceListingCompleteness(4, 20, 20);
		} catch (err) {
			expect(err).toBeInstanceOf(SuspiciousListingError);
			expect((err as SuspiciousListingError).side).toBe("local");
			expect((err as SuspiciousListingError).listedCount).toBe(4);
			expect((err as SuspiciousListingError).baselineCount).toBe(20);
		}
	});

	it("throws SuspiciousListingError for a sparse remote listing", () => {
		expect(() => enforceListingCompleteness(20, 4, 20))
			.toThrowError(SuspiciousListingError);
	});

	it("names the correct side when remote is sparse", () => {
		try {
			enforceListingCompleteness(20, 4, 20);
		} catch (err) {
			expect((err as SuspiciousListingError).side).toBe("remote");
		}
	});

	it("passes exactly at the threshold boundary", () => {
		// threshold = floor(20 * 0.5) = 10; local=10 passes (not strictly less than)
		expect(() => enforceListingCompleteness(10, 10, 20)).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// splitPlanAtLimit — partitioning behaviour
// ---------------------------------------------------------------------------

describe("splitPlanAtLimit", () => {
	it("returns the full plan unchanged when deletions are within the limit", () => {
		const p = plan(
			{ path: "a.md", action: "delete_local" },
			{ path: "b.md", action: "push" },
		);
		const result = splitPlanAtLimit(p, 5);
		expect(result.hasHeld).toBe(false);
		expect(result.held).toHaveLength(0);
		expect(result.safe.actions).toHaveLength(2);
	});

	it("returns the full plan unchanged when deletions exactly equal the limit", () => {
		const p = plan(
			{ path: "a.md", action: "delete_local" },
			{ path: "b.md", action: "delete_remote" },
		);
		const result = splitPlanAtLimit(p, 2);
		expect(result.hasHeld).toBe(false);
		expect(result.safe.actions).toHaveLength(2);
	});

	it("quarantines all deletions and keeps safe actions when over the limit", () => {
		const p = plan(
			{ path: "note.md", action: "push" },
			{ path: "a.md", action: "delete_local" },
			{ path: "b.md", action: "delete_remote" },
			{ path: "c.md", action: "delete_local" },
			{ path: "new.md", action: "pull" },
		);
		const result = splitPlanAtLimit(p, 2);

		expect(result.hasHeld).toBe(true);
		expect(result.held).toHaveLength(3);
		expect(result.held.every((a) => a.action === "delete_local" || a.action === "delete_remote")).toBe(true);
		// Safe plan retains pushes and pulls
		expect(result.safe.actions).toHaveLength(2);
		expect(result.safe.actions.map((a) => a.action)).toEqual(["push", "pull"]);
	});

	it("treats limit ≤ 0 as disabled — no quarantine", () => {
		const p = plan(
			{ path: "a.md", action: "delete_local" },
			{ path: "b.md", action: "delete_remote" },
			{ path: "c.md", action: "delete_local" },
		);
		// 0 = disabled; all deletions execute
		expect(splitPlanAtLimit(p, 0).hasHeld).toBe(false);
	});

	it("does not count renames or cleanup as deletions", () => {
		const p = plan(
			{ path: "renamed.md", action: "rename_local" },
			{ path: "stale.md", action: "cleanup" },
			{ path: "gone.md", action: "delete_remote" },
		);
		// 1 real deletion, limit 1 → no quarantine
		expect(splitPlanAtLimit(p, 1).hasHeld).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// DeletionVelocityTracker
// ---------------------------------------------------------------------------

describe("DeletionVelocityTracker", () => {
	it("starts with a zero window total", () => {
		const tracker = new DeletionVelocityTracker();
		expect(tracker.windowTotal()).toBe(0);
	});

	it("accumulates counts within the window", () => {
		const tracker = new DeletionVelocityTracker();
		const now = Date.now();
		tracker.record(10, now);
		tracker.record(15, now + 1000);
		expect(tracker.windowTotal(VELOCITY_WINDOW_MS, now + 2000)).toBe(25);
	});

	it("excludes events older than the window", () => {
		const tracker = new DeletionVelocityTracker();
		const now = Date.now();
		tracker.record(50, now - VELOCITY_WINDOW_MS - 1); // expired
		tracker.record(10, now);
		expect(tracker.windowTotal(VELOCITY_WINDOW_MS, now)).toBe(10);
	});

	it("ignores zero-count records", () => {
		const tracker = new DeletionVelocityTracker();
		tracker.record(0);
		expect(tracker.windowTotal()).toBe(0);
	});

	it("wouldExceedVelocityLimit returns false when under limit", () => {
		const tracker = new DeletionVelocityTracker();
		const now = Date.now();
		tracker.record(VELOCITY_LIMIT - 10, now);
		expect(tracker.wouldExceedVelocityLimit(9, now)).toBe(false);
	});

	it("wouldExceedVelocityLimit returns true when pending would push over limit", () => {
		const tracker = new DeletionVelocityTracker();
		const now = Date.now();
		tracker.record(VELOCITY_LIMIT - 5, now);
		expect(tracker.wouldExceedVelocityLimit(6, now)).toBe(true);
	});

	it("reset clears all events so window total returns zero", () => {
		const tracker = new DeletionVelocityTracker();
		tracker.record(50);
		tracker.reset();
		expect(tracker.windowTotal()).toBe(0);
	});
});
