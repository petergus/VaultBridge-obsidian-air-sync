import type { FileEntity } from "../fs/types";
import type { SyncAction, SyncRecord } from "./types";
import type { SyncStateStore } from "./state";
import type { Logger } from "../logging/logger";
import { isMergeEligible } from "./merge";
import { sha256 } from "../utils/hash";

export interface StateCommitterContext {
	stateStore: SyncStateStore;
	localFs?: { read(path: string): Promise<ArrayBuffer> };
	enableThreeWayMerge?: boolean;
	logger?: Logger;
}

/**
 * Build a SyncRecord from a local and remote FileEntity.
 * Centralised record construction for the sync pipeline.
 */
export function buildSyncRecord(local: FileEntity | undefined, remote: FileEntity | undefined, path: string): SyncRecord {
	return {
		path,
		hash: local?.hash || remote?.hash || "",
		localMtime: local?.mtime ?? 0,
		remoteMtime: remote?.mtime ?? 0,
		localSize: local?.size ?? 0,
		remoteSize: remote?.size ?? 0,
		remoteChecksum: remote?.remoteChecksum,
		backendMeta: remote?.backendMeta,
		syncedAt: Date.now(),
	};
}

/**
 * Verify the merge base against the same content hash we commit in the record.
 * Transfers supply their exact bytes. Other actions may read the file again,
 * but an intervening edit must never be saved as the common ancestor.
 */
async function commitRecord(
	ctx: StateCommitterContext,
	record: SyncRecord,
	syncedContent: ArrayBuffer | undefined,
): Promise<void> {
	const { stateStore, localFs, enableThreeWayMerge, logger } = ctx;
	let base: ArrayBuffer | undefined;
	if (enableThreeWayMerge && isMergeEligible(record.path, record.localSize)) {
		try {
			const content = syncedContent ?? await localFs?.read(record.path);
			if (content && record.hash && await sha256(content) === record.hash) base = content;
		} catch (err) {
			logger?.warn("Failed to store content for 3-way merge", {
				path: record.path,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	await stateStore.putWithMergeBase(record, base);
}

/**
 * Commit the state change for a single successfully-executed action.
 *
 * - push/pull/match/conflict → upsert SyncRecord (+ optionally store merge-base content)
 * - delete_local/delete_remote → delete SyncRecord
 * - cleanup → delete SyncRecord
 *
 * Note: this function is only called for successful actions.
 * Failed actions are skipped by the caller; they will be re-detected on the next sync cycle.
 */
export async function commitAction(
	action: SyncAction,
	localEntity: FileEntity | undefined,
	remoteEntity: FileEntity | undefined,
	ctx: StateCommitterContext,
	syncedContent?: ArrayBuffer,
): Promise<void> {
	const { path } = action;
	const { stateStore } = ctx;

	switch (action.action) {
		case "push":
		case "pull":
		case "match":
		case "conflict": {
			const record = buildSyncRecord(localEntity, remoteEntity, path);
			await commitRecord(ctx, record, syncedContent);
			break;
		}

		case "rename_remote":
		case "rename_local": {
			if (action.isFolder && action.descendants) {
				await stateStore.rewritePaths([
					...action.descendants,
					{ oldPath: action.oldPath, newPath: action.path },
				]);
			} else {
				await stateStore.delete(action.oldPath);
				const renameRecord = buildSyncRecord(localEntity, remoteEntity, path);
				await commitRecord(ctx, renameRecord, syncedContent);
			}
			break;
		}

		case "delete_local":
		case "delete_remote":
		case "cleanup":
			await stateStore.delete(path);
			break;

		default: {
			// Exhaustive check: if a new SyncActionType is added, TypeScript will error here
			const _exhaustive: never = action;
			void _exhaustive;
			break;
		}
	}
}
