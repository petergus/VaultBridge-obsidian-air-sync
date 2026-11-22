import type { IFileSystem } from "../fs/interface";
import type { FileEntity } from "../fs/types";
import type { SyncAction } from "./types";
import { sha256 } from "../utils/hash";

/**
 * Guards for the race between planning a transfer and executing it: the user can
 * keep editing while an action waits for a transfer slot or its upload/download
 * runs. Without them a pull overwrites that edit, and a push baselines it as
 * already synced.
 */

/**
 * A pull or deletion found the local file different from what the plan saw — the user edited,
 * created, or deleted it while the action waited for a slot or downloaded. Marked
 * `permanent` so the per-action retry doesn't spin on it; the failed cycle holds the
 * checkpoint back and the next (cold) cycle re-plans the path as a conflict.
 */
export class LocalChangedDuringSyncError extends Error {
	readonly permanent = true;

	constructor(path: string) {
		super(`Local file changed during sync; left untouched until the next sync: ${path}`);
		this.name = "LocalChangedDuringSyncError";
	}
}

/**
 * Compare-and-swap guard run immediately before a pull overwrites the local file. The
 * plan decided "remote changed, local did not" at detection time; overwriting after a
 * later local edit would silently discard that edit.
 */
export async function assertLocalUnchangedSincePlan(localFs: IFileSystem, action: SyncAction): Promise<void> {
	const planned = action.local;
	const current = await localFs.stat(action.path);
	assertLocalMatchesPlan(action.path, planned, current);
}

/** A disappeared deletion target is already safe; an edited/replaced target is not. */
export async function assertLocalUnchangedBeforeDelete(localFs: IFileSystem, action: SyncAction): Promise<FileEntity | null> {
	const current = await localFs.stat(action.path);
	// A delete_local plan means local content matched the baseline. Use that hash
	// when list() omitted it, so same-size edits with preserved mtimes are protected.
	const planned = action.local && !action.local.hash && action.baseline?.hash
		? { ...action.local, hash: action.baseline.hash }
		: action.local;
	if (current) assertLocalMatchesPlan(action.path, planned, current);
	return current;
}

function assertLocalMatchesPlan(path: string, planned: FileEntity | undefined, current: FileEntity | null): void {
	let changed: boolean;
	if (!planned || !current) {
		changed = (planned === undefined) !== (current === null);
	} else if (planned.isDirectory || current.isDirectory) {
		changed = planned.isDirectory !== current.isDirectory;
	} else if (planned.hash && current.hash) {
		changed = planned.hash !== current.hash;
	} else {
		changed = planned.mtime !== current.mtime || planned.size !== current.size;
	}
	if (changed) throw new LocalChangedDuringSyncError(path);
}

/**
 * The local side of a push's baseline must describe the bytes actually uploaded. If
 * an edit lands between the read and the post-upload stat, baselining the stat would
 * mark that edit as already synced — it would never be pushed, and a later remote
 * edit would be pulled straight over it. On a mismatch, record the uploaded hash with
 * an unknown mtime (0) so both the hash and the mtime change checks see the newer edit.
 */
export async function localEntityForPushedContent(
	localFs: IFileSystem,
	path: string,
	content: ArrayBuffer,
	planned: FileEntity,
): Promise<FileEntity> {
	// stat() may return null if the file was deleted after the read; fall back to the
	// planned metadata (the next cycle then sees a genuine local deletion).
	const current = await localFs.stat(path);
	return localEntityForSyncedContent(content, path, current ?? undefined, planned);
}

export async function localEntityForSyncedContent(
	content: ArrayBuffer,
	path: string,
	current: FileEntity | undefined,
	planned?: FileEntity,
): Promise<FileEntity> {
	const hash = await sha256(content);
	if (current && current.hash === hash) return current;
	return { ...planned, path, isDirectory: false, hash, size: content.byteLength, mtime: 0 };
}
