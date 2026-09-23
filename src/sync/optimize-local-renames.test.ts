import { describe, it, expect } from "vitest";
import {
	optimizeLocalFileRenames,
	coalesceLocalFolderRenames,
	optimizeHeuristicRenames,
} from "./optimize-local-renames";
import type { SyncAction, SyncRecord } from "./types";
import type { FileEntity } from "../fs/types";

function entity(path: string, hash: string): FileEntity {
	return { path, isDirectory: false, size: 100, mtime: 1000, hash };
}

function baseline(path: string, hash: string): SyncRecord {
	return {
		path,
		hash,
		localMtime: 1000,
		remoteMtime: 1000,
		localSize: 100,
		remoteSize: 100,
		syncedAt: 900,
	};
}

describe("optimizeLocalFileRenames", () => {
	it("returns actions unchanged when no rename pairs", () => {
		const actions: SyncAction[] = [
			{ path: "a.md", action: "push", local: entity("a.md", "h1") },
		];
		const result = optimizeLocalFileRenames(actions, new Map());
		expect(result.actions).toBe(actions);
		expect(result.applied).toHaveLength(0);
		expect(result.skipped).toHaveLength(0);
	});

	it("replaces push+delete_remote with rename_remote when hashes match", () => {
		const actions: SyncAction[] = [
			{
				path: "old.md",
				action: "delete_remote",
				remote: entity("old.md", "h1"),
				baseline: baseline("old.md", "h1"),
			},
			{ path: "new.md", action: "push", local: entity("new.md", "h1") },
		];
		const pairs = new Map([["new.md", "old.md"]]);
		const result = optimizeLocalFileRenames(actions, pairs);

		expect(result.actions).toHaveLength(1);
		expect(result.actions[0]).toMatchObject({
			path: "new.md",
			action: "rename_remote",
			oldPath: "old.md",
		});
		expect(result.applied).toEqual([
			{ oldPath: "old.md", newPath: "new.md" },
		]);
		expect(result.skipped).toHaveLength(0);
	});

	it("converts push+delete_remote to rename_remote with hasContentChange when hashes differ (content changed)", () => {
		const actions: SyncAction[] = [
			{
				path: "old.md",
				action: "delete_remote",
				remote: entity("old.md", "h1"),
				baseline: baseline("old.md", "h1"),
			},
			{ path: "new.md", action: "push", local: entity("new.md", "h2") },
		];
		const pairs = new Map([["new.md", "old.md"]]);
		const result = optimizeLocalFileRenames(actions, pairs);

		expect(result.actions).toHaveLength(1);
		expect(result.actions[0]).toMatchObject({
			path: "new.md",
			action: "rename_remote",
			oldPath: "old.md",
			hasContentChange: true,
		});
		expect(result.applied).toEqual([
			{ oldPath: "old.md", newPath: "new.md" },
		]);
		expect(result.skipped).toHaveLength(0);
	});

	it("keeps original actions when oldPath action is not delete_remote", () => {
		const actions: SyncAction[] = [
			{
				path: "old.md",
				action: "conflict",
				local: entity("old.md", "h1"),
				remote: entity("old.md", "h2"),
			},
			{ path: "new.md", action: "push", local: entity("new.md", "h1") },
		];
		const pairs = new Map([["new.md", "old.md"]]);
		const result = optimizeLocalFileRenames(actions, pairs);

		expect(result.actions).toHaveLength(2);
		expect(result.skipped).toEqual([
			{
				pair: { oldPath: "old.md", newPath: "new.md" },
				reason: "action_type_mismatch",
			},
		]);
	});

	it("reports hash_missing when baseline hash is empty", () => {
		const actions: SyncAction[] = [
			{
				path: "old.md",
				action: "delete_remote",
				remote: entity("old.md", "h1"),
				baseline: baseline("old.md", ""),
			},
			{ path: "new.md", action: "push", local: entity("new.md", "h1") },
		];
		const pairs = new Map([["new.md", "old.md"]]);
		const result = optimizeLocalFileRenames(actions, pairs);

		expect(result.actions).toHaveLength(2);
		expect(result.skipped).toEqual([
			{
				pair: { oldPath: "old.md", newPath: "new.md" },
				reason: "hash_missing",
			},
		]);
	});

	it("reports hash_missing when local hash is empty", () => {
		const actions: SyncAction[] = [
			{
				path: "old.md",
				action: "delete_remote",
				remote: entity("old.md", "h1"),
				baseline: baseline("old.md", "h1"),
			},
			{ path: "new.md", action: "push", local: entity("new.md", "") },
		];
		const pairs = new Map([["new.md", "old.md"]]);
		const result = optimizeLocalFileRenames(actions, pairs);

		expect(result.actions).toHaveLength(2);
		expect(result.skipped).toEqual([
			{
				pair: { oldPath: "old.md", newPath: "new.md" },
				reason: "hash_missing",
			},
		]);
	});

	it("optimizes some pairs and leaves others unchanged", () => {
		const actions: SyncAction[] = [
			{
				path: "old-a.md",
				action: "delete_remote",
				remote: entity("old-a.md", "h1"),
				baseline: baseline("old-a.md", "h1"),
			},
			{
				path: "new-a.md",
				action: "push",
				local: entity("new-a.md", "h1"),
			},
			{
				path: "old-b.md",
				action: "delete_remote",
				remote: entity("old-b.md", "h2"),
				baseline: baseline("old-b.md", "h2"),
			},
			{
				path: "new-b.md",
				action: "push",
				local: entity("new-b.md", ""),
			},
			{
				path: "other.md",
				action: "pull",
				remote: entity("other.md", "h4"),
			},
		];
		const pairs = new Map([
			["new-a.md", "old-a.md"],
			["new-b.md", "old-b.md"],
		]);
		const result = optimizeLocalFileRenames(actions, pairs);

		expect(result.actions).toHaveLength(4);
		const types = result.actions.map((a) => a.action);
		expect(types).toContain("rename_remote");
		expect(types).toContain("delete_remote");
		expect(types).toContain("push");
		expect(types).toContain("pull");
		expect(result.applied).toHaveLength(1);
		expect(result.skipped).toHaveLength(1);
	});

	it("preserves remote and baseline from delete action in rename_remote", () => {
		const remote = entity("old.md", "h1");
		const bl = baseline("old.md", "h1");
		const local = entity("new.md", "h1");
		const actions: SyncAction[] = [
			{ path: "old.md", action: "delete_remote", remote, baseline: bl },
			{ path: "new.md", action: "push", local },
		];
		const pairs = new Map([["new.md", "old.md"]]);
		const result = optimizeLocalFileRenames(actions, pairs);

		expect(result.actions[0]!.remote).toBe(remote);
		expect(result.actions[0]!.baseline).toBe(bl);
		expect(result.actions[0]!.local).toBe(local);
	});

	it("skips when the pair references paths absent from actions", () => {
		const actions: SyncAction[] = [
			{
				path: "unrelated.md",
				action: "push",
				local: entity("unrelated.md", "h1"),
			},
		];
		const pairs = new Map([["new.md", "old.md"]]);
		const result = optimizeLocalFileRenames(actions, pairs);

		// Neither side of the pair exists as an action — nothing to coalesce.
		expect(result.actions).toBe(actions);
		expect(result.skipped).toEqual([
			{
				pair: { oldPath: "old.md", newPath: "new.md" },
				reason: "action_type_mismatch",
			},
		]);
	});
});

describe("coalesceLocalFolderRenames", () => {
	it("coalesces all child file renames into a single folder rename_remote", () => {
		const actions: SyncAction[] = [
			{
				path: "A/f1.md",
				action: "delete_remote",
				remote: entity("A/f1.md", "h1"),
				baseline: baseline("A/f1.md", "h1"),
			},
			{ path: "B/f1.md", action: "push", local: entity("B/f1.md", "h1") },
			{
				path: "A/f2.md",
				action: "delete_remote",
				remote: entity("A/f2.md", "h2"),
				baseline: baseline("A/f2.md", "h2"),
			},
			{ path: "B/f2.md", action: "push", local: entity("B/f2.md", "h2") },
		];
		const folderPairs = new Map([["B", "A"]]);
		const filePairs = new Map([
			["B/f1.md", "A/f1.md"],
			["B/f2.md", "A/f2.md"],
		]);
		const result = coalesceLocalFolderRenames(
			actions,
			folderPairs,
			filePairs,
		);

		expect(result.actions).toHaveLength(1);
		expect(result.actions[0]).toMatchObject({
			path: "B",
			action: "rename_remote",
			oldPath: "A",
			isFolder: true,
		});
		const renameAction = result.actions[0] as {
			descendants: { oldPath: string; newPath: string }[];
		};
		expect(renameAction.descendants).toHaveLength(2);
		expect(result.remainingFileRenames.size).toBe(0);
		expect(result.applied).toEqual([
			{ oldPath: "A", newPath: "B", isFolder: true },
		]);
		expect(result.skipped).toHaveLength(0);
	});

	it("skips folder coalescing when a child has hash mismatch", () => {
		const actions: SyncAction[] = [
			{
				path: "A/f1.md",
				action: "delete_remote",
				remote: entity("A/f1.md", "h1"),
				baseline: baseline("A/f1.md", "h1"),
			},
			{ path: "B/f1.md", action: "push", local: entity("B/f1.md", "h1") },
			{
				path: "A/f2.md",
				action: "delete_remote",
				remote: entity("A/f2.md", "h2"),
				baseline: baseline("A/f2.md", "h2"),
			},
			{ path: "B/f2.md", action: "push", local: entity("B/f2.md", "h3") },
		];
		const folderPairs = new Map([["B", "A"]]);
		const filePairs = new Map([
			["B/f1.md", "A/f1.md"],
			["B/f2.md", "A/f2.md"],
		]);
		const result = coalesceLocalFolderRenames(
			actions,
			folderPairs,
			filePairs,
		);

		expect(result.actions).toHaveLength(4);
		expect(result.remainingFileRenames.size).toBe(2);
		expect(result.skipped).toEqual([
			{ pair: { oldPath: "A", newPath: "B" }, reason: "hash_mismatch" },
		]);
	});

	it("handles nested folder contents", () => {
		const actions: SyncAction[] = [
			{
				path: "A/f1.md",
				action: "delete_remote",
				remote: entity("A/f1.md", "h1"),
				baseline: baseline("A/f1.md", "h1"),
			},
			{ path: "B/f1.md", action: "push", local: entity("B/f1.md", "h1") },
			{
				path: "A/sub/f2.md",
				action: "delete_remote",
				remote: entity("A/sub/f2.md", "h2"),
				baseline: baseline("A/sub/f2.md", "h2"),
			},
			{
				path: "B/sub/f2.md",
				action: "push",
				local: entity("B/sub/f2.md", "h2"),
			},
		];
		const folderPairs = new Map([["B", "A"]]);
		const filePairs = new Map([
			["B/f1.md", "A/f1.md"],
			["B/sub/f2.md", "A/sub/f2.md"],
		]);
		const result = coalesceLocalFolderRenames(
			actions,
			folderPairs,
			filePairs,
		);

		expect(result.actions).toHaveLength(1);
		expect(result.actions[0]).toMatchObject({
			action: "rename_remote",
			isFolder: true,
		});
	});

	it("skips when no child file rename pairs exist", () => {
		const actions: SyncAction[] = [
			{
				path: "other.md",
				action: "push",
				local: entity("other.md", "h1"),
			},
		];
		const folderPairs = new Map([["B", "A"]]);
		const filePairs = new Map<string, string>();
		const result = coalesceLocalFolderRenames(
			actions,
			folderPairs,
			filePairs,
		);

		expect(result.actions).toHaveLength(1);
		expect(result.actions[0]!.action).toBe("push");
		expect(result.skipped).toEqual([
			{ pair: { oldPath: "A", newPath: "B" }, reason: "no_descendants" },
		]);
	});

	it("preserves unrelated actions", () => {
		const actions: SyncAction[] = [
			{
				path: "A/f1.md",
				action: "delete_remote",
				remote: entity("A/f1.md", "h1"),
				baseline: baseline("A/f1.md", "h1"),
			},
			{ path: "B/f1.md", action: "push", local: entity("B/f1.md", "h1") },
			{
				path: "other.md",
				action: "pull",
				remote: entity("other.md", "h3"),
			},
		];
		const folderPairs = new Map([["B", "A"]]);
		const filePairs = new Map([["B/f1.md", "A/f1.md"]]);
		const result = coalesceLocalFolderRenames(
			actions,
			folderPairs,
			filePairs,
		);

		expect(result.actions).toHaveLength(2);
		expect(result.actions.map((a) => a.action)).toContain("pull");
		expect(result.actions.map((a) => a.action)).toContain("rename_remote");
	});

	it("skips the whole folder when a child rename pair has no matching actions", () => {
		const actions: SyncAction[] = [
			{
				path: "A/f1.md",
				action: "delete_remote",
				remote: entity("A/f1.md", "h1"),
				baseline: baseline("A/f1.md", "h1"),
			},
			{ path: "B/f1.md", action: "push", local: entity("B/f1.md", "h1") },
			// B/f2.md is listed as a rename pair but has no delete_remote/push actions.
		];
		const folderPairs = new Map([["B", "A"]]);
		const filePairs = new Map([
			["B/f1.md", "A/f1.md"],
			["B/f2.md", "A/f2.md"],
		]);
		const result = coalesceLocalFolderRenames(
			actions,
			folderPairs,
			filePairs,
		);

		// Coalescing is all-or-nothing: an unverifiable child aborts the folder,
		// leaving every file rename for optimizeLocalFileRenames to handle.
		expect(result.actions).toHaveLength(2);
		expect(result.skipped).toEqual([
			{
				pair: { oldPath: "A", newPath: "B" },
				reason: "action_type_mismatch",
			},
		]);
		expect(result.remainingFileRenames.size).toBe(2);
	});

	it("coalesces folder rename when fileRenamePairs is empty (Obsidian event model)", () => {
		const actions: SyncAction[] = [
			{
				path: "OldDir/doc1.md",
				action: "delete_remote",
				remote: entity("OldDir/doc1.md", "hash1"),
				baseline: baseline("OldDir/doc1.md", "hash1"),
			},
			{
				path: "NewDir/doc1.md",
				action: "push",
				local: entity("NewDir/doc1.md", "hash1"),
			},
			{
				path: "OldDir/sub/doc2.md",
				action: "delete_remote",
				remote: entity("OldDir/sub/doc2.md", "hash2"),
				baseline: baseline("OldDir/sub/doc2.md", "hash2"),
			},
			{
				path: "NewDir/sub/doc2.md",
				action: "push",
				local: entity("NewDir/sub/doc2.md", "hash2"),
			},
		];
		const folderPairs = new Map([["NewDir", "OldDir"]]);
		const filePairs = new Map<string, string>(); // Empty, as Obsidian does not fire child renames

		const result = coalesceLocalFolderRenames(actions, folderPairs, filePairs);

		expect(result.actions).toHaveLength(1);
		expect(result.actions[0]).toMatchObject({
			path: "NewDir",
			action: "rename_remote",
			oldPath: "OldDir",
			isFolder: true,
		});
		const renameAction = result.actions[0] as {
			descendants: { oldPath: string; newPath: string }[];
		};
		expect(renameAction.descendants).toHaveLength(2);
		expect(renameAction.descendants).toEqual([
			{ oldPath: "OldDir/doc1.md", newPath: "NewDir/doc1.md" },
			{ oldPath: "OldDir/sub/doc2.md", newPath: "NewDir/sub/doc2.md" },
		]);
		expect(result.applied).toEqual([
			{ oldPath: "OldDir", newPath: "NewDir", isFolder: true },
		]);
		expect(result.skipped).toHaveLength(0);
		expect(result.remainingFileRenames.size).toBe(0);
	});

	it("skips whole-folder coalesce when new folder has extra pushed file, but preserves valid file pairs", () => {
		const actions: SyncAction[] = [
			{
				path: "OldDir/doc1.md",
				action: "delete_remote",
				remote: entity("OldDir/doc1.md", "hash1"),
				baseline: baseline("OldDir/doc1.md", "hash1"),
			},
			{
				path: "NewDir/doc1.md",
				action: "push",
				local: entity("NewDir/doc1.md", "hash1"),
			},
			{
				path: "NewDir/brandNew.md",
				action: "push",
				local: entity("NewDir/brandNew.md", "hashBrandNew"),
			},
		];
		const folderPairs = new Map([["NewDir", "OldDir"]]);
		const filePairs = new Map<string, string>();

		const result = coalesceLocalFolderRenames(actions, folderPairs, filePairs);

		expect(result.actions).toHaveLength(3);
		expect(result.skipped).toEqual([
			{ pair: { oldPath: "OldDir", newPath: "NewDir" }, reason: "action_type_mismatch" },
		]);
		// Valid matching file pair is provided for per-file rename optimization
		expect(result.remainingFileRenames.get("NewDir/doc1.md")).toBe("OldDir/doc1.md");
	});

	it("coalesces folder containing subdirectories without hash_missing error", () => {
		const actions: SyncAction[] = [
			{
				path: "OldDir/sub",
				action: "delete_remote",
				remote: { path: "OldDir/sub", isDirectory: true, size: 0, mtime: 0, hash: "" },
			},
			{
				path: "NewDir/sub",
				action: "push",
				local: { path: "NewDir/sub", isDirectory: true, size: 0, mtime: 0, hash: "" },
			},
			{
				path: "OldDir/sub/doc.md",
				action: "delete_remote",
				remote: entity("OldDir/sub/doc.md", "hash1"),
				baseline: baseline("OldDir/sub/doc.md", "hash1"),
			},
			{
				path: "NewDir/sub/doc.md",
				action: "push",
				local: entity("NewDir/sub/doc.md", "hash1"),
			},
		];
		const folderPairs = new Map([["NewDir", "OldDir"]]);
		const filePairs = new Map([["NewDir/sub/doc.md", "OldDir/sub/doc.md"]]);

		const result = coalesceLocalFolderRenames(actions, folderPairs, filePairs);

		expect(result.actions).toHaveLength(1);
		expect(result.actions[0]).toMatchObject({
			path: "NewDir",
			action: "rename_remote",
			oldPath: "OldDir",
			isFolder: true,
		});
		expect(result.applied).toEqual([
			{ oldPath: "OldDir", newPath: "NewDir", isFolder: true },
		]);
		expect(result.skipped).toHaveLength(0);
	});
});

describe("optimizeHeuristicRenames", () => {
	it("pairs unmatched delete_remote and push with identical hash and size", () => {
		const actions: SyncAction[] = [
			{
				path: "folderA/note.md",
				action: "delete_remote",
				remote: entity("folderA/note.md", "hash123"),
				baseline: baseline("folderA/note.md", "hash123"),
			},
			{
				path: "folderB/note.md",
				action: "push",
				local: entity("folderB/note.md", "hash123"),
			},
		];

		const result = optimizeHeuristicRenames(actions);
		expect(result.actions).toHaveLength(1);
		expect(result.actions[0]).toMatchObject({
			path: "folderB/note.md",
			action: "rename_remote",
			oldPath: "folderA/note.md",
		});
		expect(result.applied).toEqual([
			{ oldPath: "folderA/note.md", newPath: "folderB/note.md" },
		]);
	});

	it("does not pair when hashes differ", () => {
		const actions: SyncAction[] = [
			{
				path: "folderA/note.md",
				action: "delete_remote",
				remote: entity("folderA/note.md", "hash1"),
				baseline: baseline("folderA/note.md", "hash1"),
			},
			{
				path: "folderB/note.md",
				action: "push",
				local: entity("folderB/note.md", "hash2"),
			},
		];

		const result = optimizeHeuristicRenames(actions);
		expect(result.actions).toHaveLength(2);
		expect(result.applied).toHaveLength(0);
	});

	it("prefers identical filename when multiple files share the same content hash", () => {
		const actions: SyncAction[] = [
			{
				path: "source/unique-name.md",
				action: "delete_remote",
				remote: entity("source/unique-name.md", "samehash"),
				baseline: baseline("source/unique-name.md", "samehash"),
			},
			{
				path: "dest/other.md",
				action: "push",
				local: entity("dest/other.md", "samehash"),
			},
			{
				path: "dest/unique-name.md",
				action: "push",
				local: entity("dest/unique-name.md", "samehash"),
			},
		];

		const result = optimizeHeuristicRenames(actions);
		expect(result.applied).toEqual([
			{ oldPath: "source/unique-name.md", newPath: "dest/unique-name.md" },
		]);
	});
});

