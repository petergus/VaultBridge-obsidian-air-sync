import { describe, it, expect } from "vitest";
import { optimizeHeuristicRemoteRenames } from "./optimize-heuristic-renames";
import type { SyncAction, SyncRecord } from "./types";
import type { FileEntity } from "../fs/types";

const md5 = (value: string) => ({ algo: "md5" as const, value });

function remote(path: string, checksum: string, size = 100): FileEntity {
	return { path, isDirectory: false, size, mtime: 5000, hash: "", remoteChecksum: md5(checksum) };
}

function deleteLocal(path: string, checksum: string, size = 100): SyncAction {
	const baseline: SyncRecord = {
		path,
		hash: `sha-${checksum}`,
		localMtime: 1000,
		remoteMtime: 1000,
		localSize: size,
		remoteSize: size,
		remoteChecksum: md5(checksum),
		syncedAt: 900,
	};
	return {
		path,
		action: "delete_local",
		local: { path, isDirectory: false, size, mtime: 1000, hash: "" },
		baseline,
	};
}

describe("optimizeHeuristicRemoteRenames", () => {
	it("turns a delete_local + pull of identical content into a rename_local", () => {
		const actions: SyncAction[] = [
			deleteLocal("notes/a.md", "c1"),
			{ path: "archive/a.md", action: "pull", remote: remote("archive/a.md", "c1") },
		];
		const result = optimizeHeuristicRemoteRenames(actions);
		expect(result.actions).toEqual([
			expect.objectContaining({ path: "archive/a.md", action: "rename_local", oldPath: "notes/a.md" }),
		]);
	});

	it("leaves the pair alone when the content differs", () => {
		const actions: SyncAction[] = [
			deleteLocal("a.md", "c1"),
			{ path: "b.md", action: "pull", remote: remote("b.md", "c2") },
		];
		expect(optimizeHeuristicRemoteRenames(actions).actions).toBe(actions);
	});

	it("skips empty files (every empty file matches every other)", () => {
		const actions: SyncAction[] = [
			deleteLocal("a.md", "empty", 0),
			{ path: "b.md", action: "pull", remote: remote("b.md", "empty", 0) },
		];
		expect(optimizeHeuristicRemoteRenames(actions).actions).toBe(actions);
	});

	it("prefers the same file name among identical candidates", () => {
		const actions: SyncAction[] = [
			deleteLocal("x/template.md", "same"),
			{ path: "y/other.md", action: "pull", remote: remote("y/other.md", "same") },
			{ path: "y/template.md", action: "pull", remote: remote("y/template.md", "same") },
		];
		const result = optimizeHeuristicRemoteRenames(actions);
		expect(result.applied).toEqual([{ oldPath: "x/template.md", newPath: "y/template.md" }]);
		expect(result.actions.find((a) => a.path === "y/other.md")?.action).toBe("pull");
	});

	it("does not guess between several identical candidates with other names", () => {
		const actions: SyncAction[] = [
			deleteLocal("x/a.md", "same"),
			{ path: "y/b.md", action: "pull", remote: remote("y/b.md", "same") },
			{ path: "y/c.md", action: "pull", remote: remote("y/c.md", "same") },
		];
		expect(optimizeHeuristicRemoteRenames(actions).actions).toBe(actions);
	});

	it("never pairs with a pull that has a baseline (a modified existing file)", () => {
		const del = deleteLocal("a.md", "c1");
		const actions: SyncAction[] = [
			del,
			{ path: "b.md", action: "pull", remote: remote("b.md", "c1"), baseline: { ...del.baseline!, path: "b.md" } },
		];
		expect(optimizeHeuristicRemoteRenames(actions).actions).toBe(actions);
	});
});
