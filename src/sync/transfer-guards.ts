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
 * A pull found the local file different from what the plan saw — the user edited,
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
	if (changed) throw new LocalChangedDuringSyncError(action.path);
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
	const pushedHash = await sha256(content);
	// stat() may return null if the file was deleted after the read; fall back to the
	// planned metadata (the next cycle then sees a genuine local deletion).
	const current = await localFs.stat(path);
	if (current && current.hash === pushedHash) return current;
	return { ...(current ?? planned), hash: pushedHash, mtime: 0 };
}
