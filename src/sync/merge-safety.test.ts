import "fake-indexeddb/auto";
import { App } from "obsidian";
import { expect, it, vi } from "vitest";
import { addFile, createMockFs, readText } from "../__mocks__/sync-test-helpers";
import { LocalFs } from "../fs/local";
import { sha256 } from "../utils/hash";
import { executePlan } from "./plan-executor";
import type { ExecutionContext } from "./plan-executor";
import { SyncStateStore } from "./state";
import { buildSyncRecord } from "./state-committer";

const path = "note.md";
const baselineText = "heading\nbody\n";
const localEdit = "local heading\nbody\n";
const remoteEdit = "heading\nremote body\n";
const lateEdit = "local heading\nbody\nnew work typed during sync\n";
const encode = (text: string) => new TextEncoder().encode(text).buffer;
const decode = (bytes: ArrayBuffer | undefined) => new TextDecoder().decode(bytes);

function setup(id: string, fs?: LocalFs) {
	const localFs = fs ?? createMockFs("local");
	const remoteFs = createMockFs("remote");
	const stateStore = new SyncStateStore(`merge-safety-${id}`);
	const ctx: ExecutionContext = {
		localFs, remoteFs, conflictStrategy: "auto_merge",
		committer: { stateStore, localFs, enableThreeWayMerge: true },
	};
	return { localFs, remoteFs, stateStore, ctx };
}

async function seedConflict(ctx: ExecutionContext, storedBase = baselineText) {
	const local = await ctx.localFs.write(path, encode(localEdit), 2000);
	const remote = await ctx.remoteFs.write(path, encode(remoteEdit), 3000);
	const baseline = {
		...buildSyncRecord(local, remote, path),
		hash: await sha256(encode(baselineText)),
	};
	await ctx.committer.stateStore.putWithMergeBase(baseline, encode(storedBase));
	return { actions: [{ action: "conflict" as const, path, local, remote, baseline }] };
}

it("records the uploaded bytes as the base and keeps an upload-time edit in the next merge", async () => {
	const { localFs, remoteFs, stateStore, ctx } = setup("push");
	const local = await localFs.write(path, encode(baselineText), 1000);
	const write = remoteFs.write.bind(remoteFs);
	vi.spyOn(remoteFs, "write").mockImplementationOnce(async (...args) => {
		const uploaded = await write(...args);
		await localFs.write(path, encode(localEdit), 2000);
		return uploaded;
	});
	await executePlan({ actions: [{ action: "push", path, local }] }, ctx);
	const baseline = await stateStore.get(path);
	expect(baseline?.hash).toBe(await sha256(encode(baselineText)));
	expect(decode(await stateStore.getContent(path))).toBe(baselineText);
	const remote = addFile(remoteFs, path, remoteEdit, 3000);
	const result = await executePlan({ actions: [{
		action: "conflict", path, baseline, local: (await localFs.stat(path)) ?? undefined, remote,
	}] }, ctx);
	expect(result.conflicts[0]?.resolution.action).toBe("merged");
	expect(decode(await localFs.read(path))).toBe("local heading\nremote body\n");
	await stateStore.close();
});

it("preserves both versions when a legacy merge base has the wrong bytes", async () => {
	const { localFs, remoteFs, stateStore, ctx } = setup("legacy");
	const plan = await seedConflict(ctx, localEdit);
	const result = await executePlan(plan, ctx);
	expect(result.conflicts[0]?.resolution.action).toBe("duplicated");
	expect(decode(await localFs.read(path))).toBe(localEdit);
	expect(readText(remoteFs, "note.conflict.md")).toBe(remoteEdit);
	expect(decode(await stateStore.getContent(path))).toBe(localEdit);
	await stateStore.close();
});

it("uses the Obsidian text callback to reject edits even at the point of replacement", async () => {
	const app = new App();
	const fs = new LocalFs(app);
	const { remoteFs, stateStore, ctx } = setup("atomic", fs);
	const plan = await seedConflict(ctx);
	// Exercise the real LocalFs code with the mock Vault implementing process's
	// callback contract and a save arriving just before it supplies the current text.
	const process = vi.fn(async (_file, update: (current: string) => string) => {
		await fs.write(path, encode(lateEdit), 4000);
		const content = update(decode(await fs.read(path)));
		await fs.write(path, encode(content), 5000);
		return content;
	});
	app.vault.process = process;
	const result = await executePlan(plan, ctx);
	expect(process).toHaveBeenCalledOnce();
	expect(result.failed[0]?.error.name).toBe("LocalChangedDuringSyncError");
	expect(decode(await fs.read(path))).toBe(lateEdit);
	expect(readText(remoteFs, path)).toBe(remoteEdit);
	expect(decode(await stateStore.getContent(path))).toBe(baselineText);
	await stateStore.close();
});

it("leaves a new local edit intact when a failed remote upload would trigger rollback", async () => {
	const { localFs, remoteFs, stateStore, ctx } = setup("rollback");
	const plan = await seedConflict(ctx);
	vi.spyOn(remoteFs, "write").mockImplementationOnce(async () => {
		await localFs.write(path, encode(lateEdit), 4000);
		throw new Error("Drive unavailable");
	});
	const result = await executePlan(plan, ctx);
	expect(result.failed[0]?.error.message).toBe("Drive unavailable");
	expect(decode(await localFs.read(path))).toBe(lateEdit);
	expect(readText(remoteFs, path)).toBe(remoteEdit);
	expect(decode(await stateStore.getContent(path))).toBe(baselineText);
	await stateStore.close();
});

it("does not commit an edit made after the merge write as already synced", async () => {
	const { localFs, remoteFs, stateStore, ctx } = setup("merge-commit");
	const plan = await seedConflict(ctx);
	const write = remoteFs.write.bind(remoteFs);
	vi.spyOn(remoteFs, "write").mockImplementationOnce(async (...args) => {
		const uploaded = await write(...args);
		await localFs.write(path, encode(lateEdit), 4000);
		return uploaded;
	});
	const result = await executePlan(plan, ctx);
	expect(result.conflicts[0]?.resolution.action).toBe("merged");
	expect(decode(await localFs.read(path))).toBe(lateEdit);
	const merged = "local heading\nremote body\n";
	expect(decode(await stateStore.getContent(path))).toBe(merged);
	expect((await stateStore.get(path))?.hash).toBe(await sha256(encode(merged)));
	await stateStore.close();
});
