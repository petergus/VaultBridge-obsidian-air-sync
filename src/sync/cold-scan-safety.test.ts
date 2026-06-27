import { describe, it, expect, vi } from "vitest";
import { collectChanges } from "./change-detector";
import { planSync } from "./decision-engine";
import { LocalChangeTracker } from "./local-tracker";
import { createMockFs, createMockStateStore, addFile } from "../__mocks__/sync-test-helpers";
import { sha256 } from "../utils/hash";

const CONTENT = "content";

async function contentHash(): Promise<string> {
	return sha256(new TextEncoder().encode(CONTENT).buffer as ArrayBuffer);
}

function baselineRecord(path: string, hash: string) {
	return {
		path,
		hash,
		localMtime: 1000,
		remoteMtime: 1000,
		localSize: CONTENT.length,
		remoteSize: CONTENT.length,
		syncedAt: 900,
	};
}

/**
 * Cold-scan safety: a truncated remote listing must not drive delete_local.
 *
 * This is the symmetric fix to the existing "phantom warm deletion" test.
 * In the Jun-23 incident, a cold scan (forced by upload failures) saw 1,566
 * files on Dropbox that weren't in the local listing — and deleted them all
 * from the remote. The fix: confirmRemoteDeletions() re-stat()s each
 * "looks remotely absent" candidate before treating it as deleted.
 */
describe("cold scan: truncated remote listing does not drive delete_local", () => {
	it("a cold sync whose remote listing is empty does not plan delete_local for files still on remote", async () => {
		const localFs = createMockFs("local");
		const remoteFs = createMockFs("remote");
		const stateStore = createMockStateStore();
		const localTracker = new LocalChangeTracker();

		const hash = await contentHash();
		for (let i = 0; i < 20; i++) {
			const p = `note-${i}.md`;
			addFile(localFs, p, CONTENT, 1000);
			addFile(remoteFs, p, CONTENT, 1000);
			await stateStore.put(baselineRecord(p, hash));
		}

		// Simulate a truncated/empty remote listing — files are still there on stat()
		vi.spyOn(remoteFs, "list").mockResolvedValueOnce([]);

		const changeSet = await collectChanges(
			{ localFs, remoteFs, stateStore, changes: localTracker.snapshot() },
			{ forceFullScan: true },
		);

		expect(changeSet.temperature).toBe("cold");

		const actions = planSync(changeSet.entries).actions;
		const deleteLocals = actions.filter((a) => a.action === "delete_local");
		expect(deleteLocals).toHaveLength(0);
		// Files are unchanged vs baseline so the scan should produce no actions at all
		expect(actions).toHaveLength(0);
	});

	it("a genuinely deleted remote file (gone on stat too) is still planned as delete_local", async () => {
		const localFs = createMockFs("local");
		const remoteFs = createMockFs("remote");
		const stateStore = createMockStateStore();
		const localTracker = new LocalChangeTracker();

		const hash = await contentHash();
		addFile(localFs, "gone.md", CONTENT, 1000);
		// gone.md is NOT in remoteFs — it was genuinely deleted remotely
		await stateStore.put(baselineRecord("gone.md", hash));

		const changeSet = await collectChanges(
			{ localFs, remoteFs, stateStore, changes: localTracker.snapshot() },
			{ forceFullScan: true },
		);

		const action = planSync(changeSet.entries).actions.find(
			(a) => a.path === "gone.md",
		);
		expect(action?.action).toBe("delete_local");
	});
});

/**
 * Cold scan: confirmLocalDeletions also runs in cold mode (not just warm).
 * A cold scan after a failed cycle must not delete remote files just because
 * the local listing was incomplete.
 */
describe("cold scan: truncated local listing does not drive delete_remote", () => {
	it("a cold sync whose local listing is empty does not plan delete_remote for files still on disk", async () => {
		const localFs = createMockFs("local");
		const remoteFs = createMockFs("remote");
		const stateStore = createMockStateStore();
		const localTracker = new LocalChangeTracker();

		const hash = await contentHash();
		for (let i = 0; i < 20; i++) {
			const p = `note-${i}.md`;
			addFile(localFs, p, CONTENT, 1000);
			addFile(remoteFs, p, CONTENT, 1000);
			await stateStore.put(baselineRecord(p, hash));
		}

		// Simulate an incomplete local listing — files still present on disk via stat()
		vi.spyOn(localFs, "list").mockResolvedValueOnce([]);

		const changeSet = await collectChanges(
			{ localFs, remoteFs, stateStore, changes: localTracker.snapshot() },
			{ forceFullScan: true },
		);

		expect(changeSet.temperature).toBe("cold");

		const actions = planSync(changeSet.entries).actions;
		const deleteRemotes = actions.filter((a) => a.action === "delete_remote");
		expect(deleteRemotes).toHaveLength(0);
		expect(actions).toHaveLength(0);
	});
});
