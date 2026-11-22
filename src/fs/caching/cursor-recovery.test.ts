import { expect, it, vi } from "vitest";
import { GoogleDriveFs } from "../googledrive";
import type { GoogleDriveClient } from "../googledrive/client";
import type { GoogleDriveFile } from "../googledrive/types";
import { collectChanges } from "../../sync/change-detector";
import { buildSyncRecord } from "../../sync/state-committer";
import { addFile, createMockFs, createMockStateStore } from "../../__mocks__/sync-test-helpers";

it("reevaluates an in-place remote edit after cursor expiry even with no local edits", async () => {
	let expired = false;
	const original: GoogleDriveFile = {
		id: "file", name: "note.md", mimeType: "text/plain", parents: ["root"],
		md5Checksum: "original", size: "8", modifiedTime: "2026-11-21T10:00:00Z",
	};
	const client = {
		getChangesStartToken: vi.fn(() => Promise.resolve(expired ? "replacement" : "old")),
		listAllFiles: vi.fn(() => Promise.resolve([expired
			? { ...original, md5Checksum: "edited", modifiedTime: "2026-11-22T10:00:00Z" }
			: original])),
		listChanges: vi.fn(() => Promise.reject(Object.assign(new Error("expired"), { status: 410 }))),
	} as unknown as GoogleDriveClient;
	const remoteFs = new GoogleDriveFs(client, "root");
	const localFs = createMockFs("local");
	const stateStore = createMockStateStore();
	addFile(localFs, "note.md", "original");
	await remoteFs.list();
	const local = await localFs.stat("note.md");
	const remote = await remoteFs.stat("note.md");
	await stateStore.put(buildSyncRecord(local ?? undefined, remote ?? undefined, "note.md"));
	expired = true;
	const changes = await collectChanges({
		localFs, remoteFs, stateStore,
		changes: { initialized: true, dirtyPaths: new Set(), renamePairs: new Map(), folderRenamePairs: new Map() },
	});
	expect(changes.temperature).toBe("warm");
	expect(changes.entries).toHaveLength(1);
	expect(changes.entries[0]?.remote?.remoteChecksum?.value).toBe("edited");
	expect(remoteFs.changesPageToken).toBe("replacement");
});
