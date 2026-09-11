/**
 * Regression tests for data-safety bugs: deletions that were silently dropped (and
 * later resurrected), deletion guards that switched themselves off, and conflict /
 * merge / pull paths that could overwrite or corrupt user content.
 */
import { describe, it, expect, vi } from "vitest";
import "fake-indexeddb/auto";
import { SyncOrchestrator } from "./orchestrator";
import type { SyncOrchestratorDeps } from "./orchestrator";
import { LocalChangeTracker } from "./local-tracker";
import { collectChanges } from "./change-detector";
import { planSync } from "./decision-engine";
import { threeWayMerge } from "./merge";
import { splitPlanAtLimit, protectFoldersWithSurvivors } from "./deletion-guard";
import { executePlan, LocalChangedDuringSyncError, DESKTOP_TRANSFER_POOL } from "./plan-executor";
import type { ExecutionContext } from "./plan-executor";
import { resolveWithStrategy } from "./conflict";
import { classifyHttpError } from "../fs/errors";
import { sha256 } from "../utils/hash";
import {
	createMockFs,
	createMockStateStore,
	addFile,
	readText,
	mockSettings,
} from "../__mocks__/sync-test-helpers";
import type { SyncAction, SyncRecord } from "./types";
import type { SyncStateStore } from "./state";

function encode(s: string): ArrayBuffer {
	return new TextEncoder().encode(s).buffer as ArrayBuffer;
}

/** A baseline matching `addFile(fs, path, "body", 1000)`. */
function baseline(path: string, overrides: Partial<SyncRecord> = {}): SyncRecord {
	return {
		path,
		hash: "",
		localMtime: 1000,
		remoteMtime: 1000,
		localSize: 4,
		remoteSize: 4,
		syncedAt: 900,
		...overrides,
	};
}

function createOrchestrator(overrides: Partial<SyncOrchestratorDeps> = {}) {
	const localFs = createMockFs("local");
	const remoteFs = createMockFs("remote");
	const settings = mockSettings({ backendType: "none", vaultId: `safety-${Math.random()}` });
	const deps: SyncOrchestratorDeps = {
		getSettings: () => settings,
		saveSettings: vi.fn().mockResolvedValue(undefined),
		configDir: () => ".cfg",
		pluginId: () => "test-plugin",
		localFs: () => localFs,
		remoteFs: () => remoteFs,
		backendProvider: () => null,
		onStatusChange: vi.fn(),
		onProgress: vi.fn(),
		notify: vi.fn(),
		isMobile: () => false,
		localTracker: new LocalChangeTracker(),
		...overrides,
	};
	return { orchestrator: new SyncOrchestrator(deps), deps, localFs, remoteFs, settings };
}

function makeCtx(): ExecutionContext & {
	localFs: ReturnType<typeof createMockFs>;
	remoteFs: ReturnType<typeof createMockFs>;
	stateStore: ReturnType<typeof createMockStateStore>;
} {
	const localFs = createMockFs("local");
	const remoteFs = createMockFs("remote");
	const stateStore = createMockStateStore();
	return {
		localFs,
		remoteFs,
		stateStore,
		committer: { stateStore: stateStore as unknown as SyncStateStore },
		conflictStrategy: "auto_merge",
		classifyError: classifyHttpError,
		transferPool: DESKTOP_TRANSFER_POOL,
		sleep: () => Promise.resolve(),
		rng: () => 0,
	};
}

describe("hot change detection keeps remote deletions", () => {
	it("keeps a remotely deleted file whose local copy is unchanged, so it plans delete_local", async () => {
		const localFs = createMockFs("local");
		const remoteFs = createMockFs("remote");
		const stateStore = createMockStateStore();
		addFile(localFs, "gone-remotely.md", "body", 1000);
		await stateStore.put(baseline("gone-remotely.md"));
		addFile(localFs, "edited.md", "edited", 2000);
		remoteFs.checkpoint!.getChangedPaths = () =>
			Promise.resolve({ modified: [], deleted: ["gone-remotely.md"] });
		const tracker = new LocalChangeTracker();
		tracker.acknowledge(tracker.snapshot());
		tracker.markDirty("edited.md");

		const changeSet = await collectChanges({ localFs, remoteFs, stateStore, changes: tracker.snapshot() });

		expect(changeSet.temperature).toBe("hot");
		const actions = planSync(changeSet.entries).actions;
		expect(actions).toContainEqual(expect.objectContaining({ path: "gone-remotely.md", action: "delete_local" }));
	});

	it("re-evaluates extraPaths in hot mode even when neither side reports them", async () => {
		const localFs = createMockFs("local");
		const remoteFs = createMockFs("remote");
		const stateStore = createMockStateStore();
		addFile(localFs, "held.md", "body", 1000);
		await stateStore.put(baseline("held.md"));
		addFile(localFs, "edited.md", "edited", 2000);
		const tracker = new LocalChangeTracker();
		tracker.acknowledge(tracker.snapshot());
		tracker.markDirty("edited.md");

		const changeSet = await collectChanges(
			{ localFs, remoteFs, stateStore, changes: tracker.snapshot() },
			{ extraPaths: ["held.md"] },
		);

		expect(changeSet.temperature).toBe("hot");
		expect(changeSet.entries.map((e) => e.path)).toContain("held.md");
	});
});

describe("deletion guards", () => {
	const del = (path: string): SyncAction => ({ path, action: "delete_remote" });

	it("holds every deletion when the velocity guard trips, instead of treating it as limit 0 (disabled)", () => {
		const split = splitPlanAtLimit({ actions: [del("a"), del("b"), del("c")] }, 20, { holdAll: true });
		expect(split.hasHeld).toBe(true);
		expect(split.held).toHaveLength(3);
		expect(split.safe.actions).toHaveLength(0);
	});

	it("does not count approved deletions against the limit", () => {
		const split = splitPlanAtLimit(
			{ actions: [del("a"), del("b"), del("c")] },
			2,
			{ isApproved: (a) => a.path === "a" },
		);
		expect(split.hasHeld).toBe(false);
	});

	it("holds only the unapproved deletions", () => {
		const split = splitPlanAtLimit(
			{ actions: [del("a"), del("b"), del("c")] },
			1,
			{ isApproved: (a) => a.path === "a" },
		);
		expect(split.held.map((a) => a.path)).toEqual(["b", "c"]);
		expect(split.safe.actions.map((a) => a.path)).toEqual(["a"]);
	});

	it("drops a folder deletion when something beneath it survives the plan", () => {
		const dir = { path: "P", isDirectory: true, size: 0, mtime: 0, hash: "" };
		const { plan, protectedFolders } = protectFoldersWithSurvivors({
			actions: [
				{ path: "P", action: "delete_local", local: dir },
				{ path: "P/new.md", action: "push" },
				{ path: "Q", action: "delete_local", local: { ...dir, path: "Q" } },
				{ path: "Q/old.md", action: "delete_local" },
				{ path: "P2/x.md", action: "push" },
			],
		});
		expect(protectedFolders).toEqual(["P"]);
		expect(plan.actions.map((a) => a.path)).toEqual(["P/new.md", "Q", "Q/old.md", "P2/x.md"]);
	});
});

describe("orchestrator deletion safety", () => {
	it("holds a mass deletion above the velocity cap instead of executing all of it", async () => {
		const { orchestrator, remoteFs } = createOrchestrator();
		for (let i = 0; i < 120; i++) {
			addFile(remoteFs, `n${i}.md`, "body", 1000);
			await orchestrator.state.put(baseline(`n${i}.md`));
		}

		await orchestrator.runSync();

		expect(remoteFs.files.size).toBe(120);
		expect(orchestrator.getPendingDeletions()).toHaveLength(120);
		await orchestrator.close();
	});

	it("keeps held remote-origin deletions pending across cycles and does not commit the checkpoint", async () => {
		const { orchestrator, deps, localFs, remoteFs, settings } = createOrchestrator();
		settings.maxDeletionsPerSync = 2;
		const commitCheckpoint = vi.fn().mockResolvedValue(undefined);
		remoteFs.checkpoint!.commitCheckpoint = commitCheckpoint;
		let deltaCalls = 0;
		remoteFs.checkpoint!.getChangedPaths = () => Promise.resolve(
			deltaCalls++ === 0
				? { modified: [], deleted: ["a.md", "b.md", "c.md"] }
				: { modified: [], deleted: [] },
		);
		for (const path of ["a.md", "b.md", "c.md"]) {
			addFile(localFs, path, "body", 1000);
			await orchestrator.state.put(baseline(path));
		}

		await orchestrator.runSync();
		await orchestrator.runSync(); // the delta no longer reports them

		expect(orchestrator.getPendingDeletions()).toHaveLength(3);
		expect(localFs.files.has("a.md")).toBe(true);
		expect(commitCheckpoint).not.toHaveBeenCalled();
		// Unchanged hold → notified once, not every cycle.
		expect(deps.notify).toHaveBeenCalledTimes(1);

		await orchestrator.approvePendingDeletions();

		expect(localFs.files.has("a.md")).toBe(false);
		expect(localFs.files.has("c.md")).toBe(false);
		expect(orchestrator.getPendingDeletions()).toHaveLength(0);
		expect(commitCheckpoint).toHaveBeenCalled();
		await orchestrator.close();
	});

	it("approval re-checks current state and does not delete a file restored after it was held", async () => {
		const { orchestrator, localFs, remoteFs, settings } = createOrchestrator();
		settings.maxDeletionsPerSync = 1;
		for (const path of ["a.md", "b.md"]) {
			addFile(remoteFs, path, "body", 1000);
			await orchestrator.state.put(baseline(path));
		}
		await orchestrator.runSync();
		expect(orchestrator.getPendingDeletions()).toHaveLength(2);

		addFile(localFs, "a.md", "body", 1000); // the user restores a.md before approving
		await orchestrator.approvePendingDeletions();

		expect(remoteFs.files.has("a.md")).toBe(true);
		expect(remoteFs.files.has("b.md")).toBe(false);
		await orchestrator.close();
	});

	it("does not trash a new local note inside a folder the other device deleted", async () => {
		const { orchestrator, localFs, remoteFs } = createOrchestrator();
		addFile(localFs, "P/new.md", "brand new note", 2000);
		await orchestrator.state.put(baseline("P", { localMtime: 0, remoteMtime: 0, localSize: 0, remoteSize: 0 }));
		remoteFs.checkpoint!.getChangedPaths = () => Promise.resolve({ modified: [], deleted: ["P"] });

		await orchestrator.runSync();

		expect(readText(localFs, "P/new.md")).toBe("brand new note");
		expect(readText(remoteFs, "P/new.md")).toBe("brand new note");
		await orchestrator.close();
	});
});

describe("pullSingle", () => {
	it("does not overwrite a local edit made while the priority pull was queued", async () => {
		const { orchestrator, localFs, remoteFs } = createOrchestrator();
		await orchestrator.state.put(baseline("note.md"));
		addFile(localFs, "note.md", "typed while waiting", 1500);
		addFile(remoteFs, "note.md", "remote edit", 2000);

		await orchestrator.pullSingle("note.md");

		expect(readText(localFs, "note.md")).toBe("typed while waiting");
		await orchestrator.close();
	});

	it("does not resurrect a file the user deleted while the priority pull was queued", async () => {
		const { orchestrator, localFs, remoteFs } = createOrchestrator();
		await orchestrator.state.put(baseline("note.md"));
		addFile(remoteFs, "note.md", "remote edit", 2000);

		await orchestrator.pullSingle("note.md");

		expect(localFs.files.has("note.md")).toBe(false);
		await orchestrator.close();
	});
});

describe("executor races", () => {
	it("fails a pull instead of overwriting a local edit made after planning", async () => {
		const ctx = makeCtx();
		addFile(ctx.localFs, "a.md", "edited during sync", 3000);
		addFile(ctx.remoteFs, "a.md", "remote", 2000);
		const readSpy = vi.spyOn(ctx.remoteFs, "read");

		const result = await executePlan({
			actions: [{
				path: "a.md",
				action: "pull",
				local: { path: "a.md", isDirectory: false, size: 4, mtime: 1000, hash: "" },
				remote: { path: "a.md", isDirectory: false, size: 6, mtime: 2000, hash: "" },
				baseline: baseline("a.md"),
			}],
		}, ctx);

		expect(readText(ctx.localFs, "a.md")).toBe("edited during sync");
		expect(result.failed).toHaveLength(1);
		expect(result.failed[0]!.error).toBeInstanceOf(LocalChangedDuringSyncError);
		expect(readSpy).toHaveBeenCalledTimes(1); // not retried in-cycle
		expect(ctx.stateStore.records.has("a.md")).toBe(false);
	});

	it("baselines the pushed bytes, not an edit that landed during the upload", async () => {
		const ctx = makeCtx();
		addFile(ctx.localFs, "a.md", "v1", 1000);
		const originalWrite = ctx.remoteFs.write.bind(ctx.remoteFs);
		vi.spyOn(ctx.remoteFs, "write").mockImplementation(async (path, content, mtime) => {
			addFile(ctx.localFs, "a.md", "v2 typed during upload", 2000);
			return originalWrite(path, content, mtime);
		});

		await executePlan({
			actions: [{
				path: "a.md",
				action: "push",
				local: { path: "a.md", isDirectory: false, size: 2, mtime: 1000, hash: "" },
			}],
		}, ctx);

		const record = ctx.stateStore.records.get("a.md")!;
		expect(record.hash).toBe(await sha256(encode("v1")));
		expect(record.localMtime).toBe(0);
	});
});

describe("conflict resolution never discards a version", () => {
	it("keep_newer saves the older version as a .conflict copy on both sides", async () => {
		const localFs = createMockFs("local");
		const remoteFs = createMockFs("remote");
		const local = addFile(localFs, "f.md", "older local", 1000);
		const remote = addFile(remoteFs, "f.md", "newer remote", 2000);

		const r = await resolveWithStrategy({ path: "f.md", localFs, remoteFs, local, remote }, "keep_newer");

		expect(r).toEqual({ action: "kept_remote", duplicatePath: "f.conflict.md" });
		expect(readText(localFs, "f.md")).toBe("newer remote");
		expect(readText(localFs, "f.conflict.md")).toBe("older local");
		expect(readText(remoteFs, "f.conflict.md")).toBe("older local");
	});

	it("keep_newer makes no copy when both sides hold identical bytes", async () => {
		const localFs = createMockFs("local");
		const remoteFs = createMockFs("remote");
		const local = addFile(localFs, "f.md", "same", 1000);
		const remote = addFile(remoteFs, "f.md", "same", 2000);

		const r = await resolveWithStrategy({ path: "f.md", localFs, remoteFs, local, remote }, "keep_newer");

		expect(r).toEqual({ action: "kept_remote" });
		expect(localFs.files.has("f.conflict.md")).toBe(false);
	});

	it.each([
		["f.css", "duplicated"],
		["main.js", "duplicated"],
		["f.md", "merged"],
	])("an overlapping merge of %s resolves as %s", async (path, expected) => {
		const localFs = createMockFs("local");
		const remoteFs = createMockFs("remote");
		const base = "a\nb\nc";
		const local = addFile(localFs, path, "a\nLOCAL\nc", 2000);
		const remote = addFile(remoteFs, path, "a\nREMOTE\nc", 2000);
		const stateStore = createMockStateStore();
		stateStore.contents.set(path, encode(base));

		const r = await resolveWithStrategy({
			path, localFs, remoteFs, local, remote,
			prevSync: baseline(path, { localSize: base.length, remoteSize: base.length }),
			stateStore: stateStore as unknown as SyncStateStore,
		}, "auto_merge");

		expect(r.action).toBe(expected);
		if (expected === "duplicated") {
			expect(readText(localFs, path)).toBe("a\nLOCAL\nc");
			expect(readText(remoteFs, path)).toBe("a\nLOCAL\nc");
			expect(readText(remoteFs, r.duplicatePath!)).toBe("a\nREMOTE\nc");
		}
	});
});

describe("threeWayMerge applies an edit made identically on both sides once", () => {
	it("does not duplicate an identical insertion", () => {
		const r = threeWayMerge("a\nb\nc\nd\ne", "a\nX\nb\nc\nd\nE", "a\nX\nb\nC\nd\ne");
		expect(r).toEqual({ success: true, content: "a\nX\nb\nC\nd\nE", hasConflicts: false });
	});

	it("does not delete extra lines for an identical deletion", () => {
		const r = threeWayMerge("a\nb\nc\nd\ne\nf", "a\nb\nd\ne\nF", "A\nb\nd\ne\nf");
		expect(r).toEqual({ success: true, content: "A\nb\nd\ne\nF", hasConflicts: false });
	});
});
