import type { DropboxEntry } from "./types";
import { isDropboxResetError } from "./types";
import type { DropboxMetadataCache } from "./metadata-cache";
import type { DropboxClient } from "./client";
import type { MetadataStore } from "../../store/metadata-store";
import type { RenamePair } from "../../sync/types";
import type { Logger } from "../../logging/logger";
import { INTERNAL_METADATA_PATH } from "../../sync/remote-vault";

/** Context for incremental sync operations. */
export interface DropboxSyncContext {
	cache: DropboxMetadataCache;
	client: DropboxClient;
	metadataStore?: MetadataStore<DropboxEntry>;
	logger?: Logger;
}

export type DropboxDeltaResult =
	| { needsFullScan: false; newCursor: string; changedPaths: Set<string>; renamedPaths: RenamePair[] }
	| { needsFullScan: true; changedPaths: Set<string> };

/** A remote change delta in the shape the sync engine consumes. */
export interface RemoteDelta {
	modified: string[];
	deleted: string[];
	renamed: RenamePair[];
}

type FileRecordTuple = { path: string; file: DropboxEntry; isFolder: boolean };

interface DeltaAccumulator {
	updatedRecords: FileRecordTuple[];
	deletedPaths: string[];
	changedPaths: Set<string>;
	renamedPaths: RenamePair[];
}

/** Split delta-changed paths into modified (still cached) vs deleted (gone). */
export function classifyChangedPaths(
	cache: DropboxMetadataCache,
	changedPaths: Set<string>,
	renamedPaths: RenamePair[],
): RemoteDelta {
	const modified: string[] = [];
	const deleted: string[] = [];
	for (const path of changedPaths) {
		if (cache.hasEntry(path)) modified.push(path);
		else deleted.push(path);
	}
	return { modified, deleted, renamed: renamedPaths };
}

/**
 * Diff a pre-scan snapshot (path-by-id) against the freshly-scanned cache.
 * Used when the cursor is lost (`reset`) and we re-scan to recover a delta.
 * Detects additions, renames, and deletions — but not in-place content edits
 * (same id, same path), which the next delta or WARM mode catches.
 */
export function computeFullScanDelta(
	oldPathById: Map<string, string>,
	cache: DropboxMetadataCache,
): RemoteDelta | null {
	if (oldPathById.size === 0) return null;
	const modified: string[] = [];
	const deleted: string[] = [];
	const renamed: RenamePair[] = [];
	const newIds = new Set<string>();
	for (const [newPath, entry] of cache.entries()) {
		if (!entry.id) continue;
		newIds.add(entry.id);
		const oldPath = oldPathById.get(entry.id);
		if (!oldPath) modified.push(newPath);
		else if (oldPath !== newPath) {
			renamed.push({ oldPath, newPath, isFolder: cache.isFolder(newPath) || undefined });
			modified.push(newPath);
			deleted.push(oldPath);
		}
	}
	for (const [id, oldPath] of oldPathById) {
		if (!newIds.has(id)) deleted.push(oldPath);
	}
	return { modified, deleted, renamed };
}

/** Snapshot a record tuple for the entry currently cached at `path`. */
function recordAt(cache: DropboxMetadataCache, path: string): FileRecordTuple {
	return { path, file: cache.getEntry(path)!, isFolder: cache.isFolder(path) };
}

/**
 * Apply `list_folder/continue` entries to the cache, following Dropbox's
 * official local-cache sync algorithm: process entries in order; `file`/`folder`
 * upsert at their (relativized) path; `deleted` removes the subtree at its path.
 *
 * Rename/move appears as `deleted(old)`+`file/folder(new)` sharing a stable id.
 * When the add is seen while the old path is still cached, it is coalesced into a
 * {@link RenamePair} (folders also rewrite child paths) and the trailing stale
 * `deleted(old)` becomes a no-op (the path is already gone). If the delete is
 * seen first, this degrades to delete+add — correct, but re-downloads.
 */
export async function applyDropboxDelta(ctx: DropboxSyncContext, cursor: string): Promise<DropboxDeltaResult> {
	const acc: DeltaAccumulator = {
		updatedRecords: [],
		deletedPaths: [],
		changedPaths: new Set<string>(),
		renamedPaths: [],
	};

	let cur = cursor;
	// One call may cap the entries; drain until `has_more` is false. The guard
	// caps the pathological case where Dropbox never clears `has_more`.
	for (let guard = 0; guard < 10_000; guard++) {
		let res;
		try {
			res = await ctx.client.listFolderContinue(cur);
		} catch (err) {
			if (isDropboxResetError(err)) return { needsFullScan: true, changedPaths: new Set<string>() };
			throw err;
		}
		for (const entry of res.entries) applyDeltaEntry(ctx, acc, entry);
		cur = res.cursor;
		if (!res.has_more) break;
	}

	if (acc.updatedRecords.length > 0 || acc.deletedPaths.length > 0) {
		ctx.logger?.info("Dropbox delta applied", {
			updated: acc.updatedRecords.length,
			deleted: acc.deletedPaths.length,
		});
		await persistDelta(ctx, acc.updatedRecords, acc.deletedPaths);
	}

	return { needsFullScan: false, newCursor: cur, changedPaths: acc.changedPaths, renamedPaths: acc.renamedPaths };
}

/** Apply a single delta entry to the cache and accumulate the resulting paths. */
function applyDeltaEntry(ctx: DropboxSyncContext, acc: DeltaAccumulator, entry: DropboxEntry): void {
	const cache = ctx.cache;
	const path = cache.relativize(entry);

	// Untrackable destination: outside the vault root, the root folder itself, or
	// the reserved backend metadata path. These are never cached, so never build a
	// record from them (recordAt would deref an absent entry). If a previously
	// tracked entry MOVED here (same id), surface its disappearance from the old
	// location and drop it; otherwise ignore.
	if (path === null || path === "" || path === INTERNAL_METADATA_PATH) {
		const oldPath = entry.id ? cache.getPathById(entry.id) : undefined;
		if (oldPath !== undefined) {
			for (const p of [oldPath, ...cache.collectDescendants(oldPath)]) {
				acc.changedPaths.add(p);
				acc.deletedPaths.push(p);
			}
			cache.removeTree(oldPath);
		}
		return;
	}

	if (entry[".tag"] === "deleted") {
		if (!cache.hasEntry(path)) return; // already gone (or coalesced into a rename) → ignore
		const descendants = cache.collectDescendants(path);
		for (const p of [path, ...descendants]) {
			acc.changedPaths.add(p);
			acc.deletedPaths.push(p);
		}
		cache.removeTree(path);
		return;
	}

	const oldPath = entry.id ? cache.getPathById(entry.id) : undefined;
	if (oldPath !== undefined && oldPath !== path) {
		applyRename(cache, acc, entry, oldPath, path);
		return;
	}

	// New file/folder, or in-place modify (same path).
	cache.setEntry(path, entry);
	acc.changedPaths.add(path);
	acc.updatedRecords.push(recordAt(cache, path));
}

/** Coalesce a `deleted(old)`+`file/folder(new)` pair (same id) into a rename. */
function applyRename(
	cache: DropboxMetadataCache,
	acc: DeltaAccumulator,
	entry: DropboxEntry,
	oldPath: string,
	newPath: string,
): void {
	const wasFolder = cache.isFolder(oldPath);
	const oldDescendants = wasFolder ? cache.collectDescendants(oldPath) : [];

	cache.removeEntry(oldPath);
	cache.setEntry(newPath, entry);
	if (wasFolder) cache.rewriteChildPaths(oldPath, newPath);

	acc.renamedPaths.push({ oldPath, newPath, isFolder: wasFolder || undefined });
	acc.changedPaths.add(newPath);
	acc.updatedRecords.push(recordAt(cache, newPath));
	acc.changedPaths.add(oldPath);
	acc.deletedPaths.push(oldPath);
	for (const d of oldDescendants) {
		acc.changedPaths.add(d);
		acc.deletedPaths.push(d);
	}
	if (wasFolder) {
		for (const nd of cache.collectDescendants(newPath)) {
			acc.changedPaths.add(nd);
			acc.updatedRecords.push(recordAt(cache, nd));
		}
	}
}

/**
 * Persist the delta's file-map changes to IndexedDB. The cursor is NOT stored
 * here — it lives in settings.backendData and is committed only after a
 * fully-successful sync, so an interrupted cycle re-detects the gap next time.
 */
async function persistDelta(
	ctx: DropboxSyncContext,
	updated: FileRecordTuple[],
	deleted: string[],
): Promise<void> {
	if (!ctx.metadataStore) return;
	try {
		if (updated.length > 0) await ctx.metadataStore.putFiles(updated);
		if (deleted.length > 0) await ctx.metadataStore.deleteFiles(deleted);
	} catch (err) {
		ctx.logger?.warn("Failed to persist Dropbox delta to IndexedDB", {
			message: err instanceof Error ? err.message : String(err),
		});
	}
}
