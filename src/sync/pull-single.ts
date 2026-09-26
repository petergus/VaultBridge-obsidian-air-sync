import type { IFileSystem } from "../fs/interface";
import type { Logger } from "../logging/logger";
import type { LocalChangeTracker } from "./local-tracker";
import type { SyncStateStore } from "./state";
import { hasChanged, hasRemoteChanged } from "./change-compare";
import { buildSyncRecord } from "./state-committer";

export interface PullSingleContext {
	localFs: IFileSystem;
	remoteFs: IFileSystem;
	stateStore: SyncStateStore;
	localTracker: LocalChangeTracker;
	logger?: Logger;
}

/**
 * The priority pull behind opening a file (`SyncOrchestrator.pullSingle`): download
 * one remote-changed file ahead of the next full cycle — but only when it is still a
 * clean fast-forward. Runs under the orchestrator's sync mutex. Never throws: a skipped
 * or failed pull just leaves the path for the next cycle.
 */
export async function pullIfFastForward(path: string, ctx: PullSingleContext): Promise<void> {
	const { localFs, remoteFs, stateStore, localTracker, logger } = ctx;
	try {
		const remote = await remoteFs.stat(path);
		if (!remote || remote.isDirectory) {
			logger?.warn("pullSingle: remote file not found or is a directory", { path });
			return;
		}

		// Re-check under the lock. The file-open handler decided "remote changed,
		// local untouched" BEFORE queueing behind any in-flight sync, and the user
		// may have kept typing into the open file (or deleted it, or that sync
		// already reconciled it) while this waited. Only a clean fast-forward may
		// overwrite: with a baseline, the local file must still exist unchanged
		// while the remote changed; without one, nothing may exist locally.
		// Anything else is left to the next full cycle's conflict handling.
		const [baseline, local] = await Promise.all([
			stateStore.get(path),
			localFs.stat(path),
		]);
		const fastForward = baseline
			? !!local && !hasChanged(local, baseline) && hasRemoteChanged(remote, baseline)
			: !local;
		if (!fastForward) {
			logger?.debug("pullSingle: skipped — not a clean fast-forward any more", { path });
			return;
		}

		const content = await remoteFs.read(path);
		const localEntity = await localFs.write(path, content, remote.mtime);

		const record = buildSyncRecord(localEntity, remote, path);
		await stateStore.put(record);
		// Only a completed pull consumes the dirty mark; a skipped or failed pull
		// leaves it for the next cycle.
		localTracker.acknowledgePath(path);

		logger?.info("pullSingle: completed", { path });
	} catch (err) {
		logger?.error("pullSingle: failed", {
			path,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}
