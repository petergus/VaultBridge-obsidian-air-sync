import { describe, expect, it, vi } from "vitest";
import { AuthError } from "../fs/errors";
import { addFile, createMockFs, createMockStateStore, deferred, flush, readText } from "../__mocks__/sync-test-helpers";
import { executePlan } from "./plan-executor";
import type { ExecutionContext } from "./plan-executor";
import type { SyncAction } from "./types";
import { buildSyncRecord } from "./state-committer";

function setup() {
	const localFs = createMockFs("local");
	const remoteFs = createMockFs("remote");
	const stateStore = createMockStateStore();
	const ctx: ExecutionContext = {
		localFs, remoteFs, committer: { stateStore }, conflictStrategy: "auto_merge",
	};
	return { localFs, remoteFs, stateStore, ctx };
}

describe("deletion execution safety", () => {
	it("preserves edits made while transfers run and keeps their baseline for recovery", async () => {
		const { localFs, remoteFs, stateStore, ctx } = setup();
		addFile(localFs, "note.md", "original");
		const local = await localFs.stat("note.md");
		const upload = addFile(localFs, "upload.md", "upload");
		const baseline = {
			path: "note.md", hash: local?.hash ?? "", localMtime: 1000, remoteMtime: 1000,
			localSize: 8, remoteSize: 8, syncedAt: 900,
		};
		stateStore.records.set("note.md", baseline);
		const gate = deferred();
		const write = remoteFs.write.bind(remoteFs);
		vi.spyOn(remoteFs, "write").mockImplementation(async (...args) => {
			await gate.promise;
			return write(...args);
		});
		const pending = executePlan({ actions: [
			{ action: "push", path: "upload.md", local: upload },
			{ action: "delete_local", path: "note.md", local: local ?? undefined, baseline },
		] }, ctx);
		await flush();
		addFile(localFs, "note.md", "new unsynced work", 2000);
		gate.resolve();
		const result = await pending;
		expect(readText(localFs, "note.md")).toBe("new unsynced work");
		expect(result.failed.map((f) => f.action.path)).toEqual(["note.md"]);
		expect(stateStore.records.get("note.md")).toEqual(baseline);
	});

	it("does not recursively delete a parent after its edited child fails deletion", async () => {
		const { localFs, ctx } = setup();
		addFile(localFs, "folder/note.md", "original");
		const local = await localFs.stat("folder/note.md");
		const folder = await localFs.stat("folder");
		addFile(localFs, "folder/note.md", "new unsynced work", 2000);
		const result = await executePlan({ actions: [
			{ action: "delete_local", path: "folder", local: folder ?? undefined },
			{ action: "delete_local", path: "folder/note.md", local: local ?? undefined },
		] }, ctx);
		expect(result.failed).toHaveLength(2);
		expect(readText(localFs, "folder/note.md")).toBe("new unsynced work");
	});

	it("uses the baseline hash for edits with the same size and timestamp as a listing", async () => {
		const { localFs, ctx } = setup();
		const listed = addFile(localFs, "note.md", "original");
		const original = await localFs.stat("note.md");
		const baseline = buildSyncRecord(original ?? undefined, original ?? undefined, "note.md");
		addFile(localFs, "note.md", "modified"); // same size and mtime
		const result = await executePlan({ actions: [
			{ action: "delete_local", path: "note.md", local: listed, baseline },
		] }, ctx);
		expect(result.failed).toHaveLength(1);
		expect(readText(localFs, "note.md")).toBe("modified");
	});

	it("deletes unchanged children before their parent even when the plan lists parent first", async () => {
		const { localFs, ctx } = setup();
		addFile(localFs, "folder/note.md", "original");
		const result = await executePlan({ actions: [
			{ action: "delete_local", path: "folder", local: (await localFs.stat("folder")) ?? undefined },
			{ action: "delete_local", path: "folder/note.md", local: (await localFs.stat("folder/note.md")) ?? undefined },
		] }, ctx);
		expect(result.failed).toHaveLength(0);
		expect(result.succeeded).toHaveLength(2);
		expect(localFs.files.size).toBe(0);
	});

	it("preserves a new descendant that was absent from the deletion plan", async () => {
		const { localFs, ctx } = setup();
		const folder = await localFs.mkdir("folder");
		addFile(localFs, "folder/new.md", "new work");
		const result = await executePlan({ actions: [
			{ action: "delete_local", path: "folder", local: folder },
		] }, ctx);
		expect(result.failed).toHaveLength(1);
		expect(readText(localFs, "folder/new.md")).toBe("new work");
	});

	it("treats an already disappeared target as successful", async () => {
		const { localFs, ctx } = setup();
		const local = addFile(localFs, "note.md", "original");
		await localFs.delete("note.md");
		const result = await executePlan({ actions: [{ action: "delete_local", path: "note.md", local }] }, ctx);
		expect(result.failed).toHaveLength(0);
		expect(result.succeeded).toHaveLength(1);
	});
});

describe("authentication abort barriers", () => {
	it("stops queued transfers and waits for active transfers before rejecting", async () => {
		const { localFs, remoteFs, stateStore, ctx } = setup();
		const actions: SyncAction[] = ["active.md", "bad.md", "queued.md"].map((path) => ({
			action: "push", path, local: addFile(localFs, path, "content"),
		}));
		const gate = deferred();
		const write = remoteFs.write.bind(remoteFs);
		const authError = new AuthError("expired", 401);
		const calls: string[] = [];
		vi.spyOn(remoteFs, "write").mockImplementation(async (...args) => {
			calls.push(args[0]);
			if (args[0] === "bad.md") throw authError;
			await gate.promise;
			return write(...args);
		});
		let settled = false;
		const pending = executePlan({ actions }, {
			...ctx, transferPool: { min: 2, start: 2, max: 2, rampAfter: 8 },
		}).then(() => { settled = true; return undefined; }, (err: unknown) => { settled = true; return err; });
		await flush();
		expect(settled).toBe(false);
		expect(calls).toEqual(["active.md", "bad.md"]);
		gate.resolve();
		expect(await pending).toBe(authError);
		expect(remoteFs.files.has("active.md")).toBe(true);
		expect(remoteFs.files.has("queued.md")).toBe(false);
		expect(stateStore.records.has("queued.md")).toBe(false);
		const committed = stateStore.records.size;
		await flush();
		expect(stateStore.records.size).toBe(committed);
	});

	it("drains both structural lanes and stops queued deletes on auth failure", async () => {
		const { localFs, remoteFs, ctx } = setup();
		const gate = deferred();
		const local = addFile(localFs, "local.md", "local");
		const localDelete = localFs.delete.bind(localFs);
		vi.spyOn(localFs, "delete").mockImplementation(async (path) => {
			await gate.promise;
			return localDelete(path);
		});
		const paths = ["bad.md", "a.md", "b.md", "c.md", "d.md", "queued.md"];
		for (const path of paths) addFile(remoteFs, path, "remote");
		const authError = new AuthError("expired", 401);
		const remoteDelete = remoteFs.delete.bind(remoteFs);
		const calls: string[] = [];
		vi.spyOn(remoteFs, "delete").mockImplementation(async (path) => {
			calls.push(path);
			if (path === "bad.md") throw authError;
			await gate.promise;
			return remoteDelete(path);
		});
		const actions: SyncAction[] = paths.map((path) => ({ action: "delete_remote", path }));
		actions.push({ action: "delete_local", path: "local.md", local });
		let settled = false;
		const pending = executePlan({ actions }, ctx).then(
			() => { settled = true; return undefined; },
			(err: unknown) => { settled = true; return err; },
		);
		await flush();
		expect(settled).toBe(false);
		expect(calls).not.toContain("queued.md");
		gate.resolve();
		expect(await pending).toBe(authError);
		expect(remoteFs.files.has("queued.md")).toBe(true);
		expect(localFs.files.has("local.md")).toBe(false);
	});
});
