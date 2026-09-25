import { describe, it, expect, vi } from "vitest";
import "fake-indexeddb/auto";
import { SyncOrchestrator } from "./orchestrator";
import { LocalChangeTracker } from "./local-tracker";
import {
	createMockFs,
	addFile,
	readText,
	mockSettings,
} from "../__mocks__/sync-test-helpers";
import type { IFileSystem } from "../fs/interface";
import type { RenamePair } from "./types";

/**
 * End-to-end: moving files/folders on one device must propagate as MOVES — on the
 * remote and on every other device — never as deletions plus new files. A move that
 * degrades to deletions trips the mass-deletion guard on the receiving device (and,
 * for a folder move, used to trash the moved files outright).
 */

type MockFs = ReturnType<typeof createMockFs>;

/**
 * A remote shared by several devices. Each device gets its own view with its own
 * delta cursor: `getChangedPaths` diffs the remote against what that device last saw,
 * and reports renames (when `reportRenames`) the way id-based backends do — the moved
 * item as a pair, plus the old and new paths of it and every descendant.
 */
function sharedRemote() {
	const remote = createMockFs("remote");
	const renameLog: RenamePair[] = [];
	const origRename = remote.rename.bind(remote);
	remote.rename = async (oldPath: string, newPath: string) => {
		const isFolder = remote.files.get(oldPath)?.entity.isDirectory || undefined;
		await origRename(oldPath, newPath);
		renameLog.push({ oldPath, newPath, isFolder });
	};
	const snapshot = () => new Map([...remote.files].map(([p, f]) => [p, f.content]));

	function viewFor(opts: { reportRenames: boolean }): IFileSystem {
		let seen = snapshot();
		let logIndex = renameLog.length;
		return {
			...remote,
			// A full listing (cold scan) re-bases the cursor, like a backend's full scan.
			list: () => {
				seen = snapshot();
				logIndex = renameLog.length;
				return remote.list();
			},
			checkpoint: {
				...remote.checkpoint!,
				getChangedPaths: () => {
					const now = snapshot();
					const modified = [...now].filter(([p, c]) => seen.get(p) !== c).map(([p]) => p);
					const deleted = [...seen.keys()].filter((p) => !now.has(p));
					const renamed = opts.reportRenames ? renameLog.slice(logIndex) : [];
					seen = now;
					logIndex = renameLog.length;
					return Promise.resolve({ modified, deleted, renamed });
				},
			},
		};
	}
	return { remote, viewFor };
}

function device(remoteView: IFileSystem) {
	const localFs = createMockFs("local");
	const tracker = new LocalChangeTracker();
	const settings = mockSettings({ backendType: "none", vaultId: `move-${Math.random()}` });
	const onDeletionsHeld = vi.fn();
	const orchestrator = new SyncOrchestrator({
		getSettings: () => settings,
		saveSettings: vi.fn().mockResolvedValue(undefined),
		configDir: () => ".cfg",
		pluginId: () => "test-plugin",
		localFs: () => localFs,
		remoteFs: () => remoteView,
		backendProvider: () => null,
		onStatusChange: vi.fn(),
		onProgress: vi.fn(),
		notify: vi.fn(),
		isMobile: () => false,
		localTracker: tracker,
		onDeletionsHeld,
	});
	return { localFs, tracker, orchestrator, onDeletionsHeld };
}

/** Move a folder in the vault the way Obsidian reports it: the folder + each child. */
async function moveFolderLocally(dev: ReturnType<typeof device>, from: string, to: string): Promise<void> {
	const children = [...dev.localFs.files.keys()].filter((p) => p.startsWith(from + "/"));
	await dev.localFs.rename(from, to);
	dev.tracker.markFolderRenamed(to, from);
	for (const p of children) dev.tracker.markRenamed(to + p.substring(from.length), p);
}

const N = 30; // comfortably above the default maxDeletionsPerSync (20)
const noteNames = Array.from({ length: N }, (_, i) => `n${i}.md`);

function paths(fs: MockFs, prefix: string): string[] {
	return [...fs.files.keys()].filter((p) => p === prefix || p.startsWith(prefix + "/")).sort();
}

describe("moves propagate as moves, not deletions", () => {
	it("folder move with nested sub-folder and link-rewritten notes", async () => {
		const { remote, viewFor } = sharedRemote();
		const a = device(viewFor({ reportRenames: true }));
		const b = device(viewFor({ reportRenames: true }));

		for (const n of noteNames) addFile(a.localFs, `notes/${n}`, `body of ${n}`);
		addFile(a.localFs, "notes/sub/deep.md", "deep");
		await a.orchestrator.runSync();
		await b.orchestrator.runSync();
		expect(readText(b.localFs, "notes/n0.md")).toBe("body of n0.md");

		await moveFolderLocally(a, "notes", "archive/notes");
		// Obsidian rewrites links inside some of the moved notes.
		for (const n of noteNames.slice(0, 5)) {
			addFile(a.localFs, `archive/notes/${n}`, `body of ${n} [[archive/notes/x]]`, 2000);
			a.tracker.markDirty(`archive/notes/${n}`);
		}
		const removeSpy = vi.spyOn(remote, "delete");
		await a.orchestrator.runSync();

		expect(a.onDeletionsHeld).not.toHaveBeenCalled();
		// Nothing was deleted from the remote except (at most) the emptied old folder.
		expect(removeSpy.mock.calls.every(([p]) => p === "notes")).toBe(true);
		expect(paths(remote, "notes")).toEqual([]);
		expect(paths(remote, "archive/notes")).toHaveLength(N + 3); // folder, sub, sub/deep, N notes
		expect(readText(remote, "archive/notes/n0.md")).toBe("body of n0.md [[archive/notes/x]]");
		expect(readText(remote, "archive/notes/n9.md")).toBe("body of n9.md");

		await b.orchestrator.runSync();
		expect(b.onDeletionsHeld).not.toHaveBeenCalled();
		expect(paths(b.localFs, "notes")).toEqual([]);
		expect(readText(b.localFs, "archive/notes/n0.md")).toBe("body of n0.md [[archive/notes/x]]");
		expect(readText(b.localFs, "archive/notes/n29.md")).toBe("body of n29.md");
		expect(readText(b.localFs, "archive/notes/sub/deep.md")).toBe("deep");

		// Both devices converge: a further cycle on each plans nothing.
		const bRemote = vi.spyOn(remote, "write");
		await a.orchestrator.runSync();
		await b.orchestrator.runSync();
		expect(bRemote).not.toHaveBeenCalled();
		await a.orchestrator.close();
		await b.orchestrator.close();
	});

	it("many files moved individually into a new folder", async () => {
		const { remote, viewFor } = sharedRemote();
		const a = device(viewFor({ reportRenames: true }));
		const b = device(viewFor({ reportRenames: true }));
		for (const n of noteNames) addFile(a.localFs, n, `body of ${n}`);
		await a.orchestrator.runSync();
		await b.orchestrator.runSync();

		for (const n of noteNames) {
			await a.localFs.rename(n, `inbox/${n}`);
			a.tracker.markRenamed(`inbox/${n}`, n);
		}
		a.tracker.markDirty("inbox");
		await a.orchestrator.runSync();
		expect(a.onDeletionsHeld).not.toHaveBeenCalled();
		expect(paths(remote, "inbox")).toHaveLength(N + 1);

		await b.orchestrator.runSync();
		expect(b.onDeletionsHeld).not.toHaveBeenCalled();
		expect(readText(b.localFs, "inbox/n3.md")).toBe("body of n3.md");
		expect(b.localFs.files.has("n3.md")).toBe(false);
		await a.orchestrator.close();
		await b.orchestrator.close();
	});

	it("a remote move without rename info (delete + add delta) is matched by content", async () => {
		const { remote, viewFor } = sharedRemote();
		const a = device(viewFor({ reportRenames: true }));
		const b = device(viewFor({ reportRenames: false }));
		for (const n of noteNames) addFile(a.localFs, `notes/${n}`, `body of ${n}`);
		await a.orchestrator.runSync();
		await b.orchestrator.runSync();

		await moveFolderLocally(a, "notes", "projects");
		await a.orchestrator.runSync();
		expect(paths(remote, "projects")).toHaveLength(N + 1);

		const trash = vi.spyOn(b.localFs, "delete");
		await b.orchestrator.runSync();
		expect(b.onDeletionsHeld).not.toHaveBeenCalled();
		// Only the emptied old folder is removed — no note is deleted and re-downloaded.
		expect(trash.mock.calls.every(([p]) => p === "notes")).toBe(true);
		expect(readText(b.localFs, "projects/n7.md")).toBe("body of n7.md");
		expect(paths(b.localFs, "notes")).toEqual([]);
		await a.orchestrator.close();
		await b.orchestrator.close();
	});

	it("a folder moved on the remote side with edited notes delivers the edits", async () => {
		const { remote, viewFor } = sharedRemote();
		const a = device(viewFor({ reportRenames: true }));
		for (const n of noteNames) addFile(remote, `notes/${n}`, `body of ${n}`);
		await a.orchestrator.runSync();

		await remote.rename("notes", "done");
		addFile(remote, "done/n1.md", "edited remotely", 5000);
		await a.orchestrator.runSync();

		expect(a.onDeletionsHeld).not.toHaveBeenCalled();
		expect(paths(a.localFs, "notes")).toEqual([]);
		expect(readText(a.localFs, "done/n1.md")).toBe("edited remotely");
		expect(readText(a.localFs, "done/n2.md")).toBe("body of n2.md");
		await a.orchestrator.close();
	});
});
