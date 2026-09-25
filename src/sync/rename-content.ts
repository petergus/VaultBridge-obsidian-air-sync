import type { IFileSystem } from "../fs/interface";
import type { FileEntity } from "../fs/types";
import type { RenameAction } from "./types";
import { localEntityForPushedContent } from "./transfer-guards";

/**
 * Content transfers that ride along a rename: a move whose file content ALSO changed
 * on the source side (Obsidian rewrote links in a moved note, or the other device
 * edited a file it moved). The move is still executed as a move — never degraded to
 * delete + re-create, which would count as a deletion and trip the mass-deletion
 * guard — and the new content is transferred to the destination right after it.
 */

/** Post-transfer entities of one file carried by a rename (for its sync record). */
export interface TransferredEntities {
	path: string;
	localEntity?: FileEntity;
	remoteEntity?: FileEntity;
}

/** Upload the local content at `path` (already moved on the remote) over the remote copy. */
async function upload(localFs: IFileSystem, remoteFs: IFileSystem, path: string): Promise<TransferredEntities | null> {
	const planned = await localFs.stat(path);
	// Gone locally since planning — nothing to upload; the next cycle sees the deletion.
	if (!planned || planned.isDirectory) return null;
	const content = await localFs.read(path);
	const remoteEntity = await remoteFs.write(path, content, planned.mtime);
	const localEntity = await localEntityForPushedContent(localFs, path, content, planned);
	return { path, localEntity, remoteEntity };
}

/** Download the remote content at `path` over the local copy (already moved locally). */
async function download(localFs: IFileSystem, remoteFs: IFileSystem, path: string): Promise<TransferredEntities | null> {
	const remote = await remoteFs.stat(path);
	if (!remote || remote.isDirectory) return null;
	const content = await remoteFs.read(path);
	const localEntity = await localFs.write(path, content, remote.mtime);
	return { path, localEntity, remoteEntity: remote };
}

/**
 * Transfer the content of a completed rename's changed file(s) in the direction the
 * rename propagates: `rename_remote` uploads, `rename_local` downloads.
 *
 * A single-file rename's transfer error propagates (the action fails; nothing is
 * committed). A folder rename's descendants are best-effort: a failed one keeps its
 * old baseline under the new path — rewritten with the folder — so the next cycle
 * sees it as changed and transfers it then; the first such error is returned so the
 * caller can fail the action AFTER committing the move.
 */
export async function transferRenamedContent(
	action: RenameAction,
	localFs: IFileSystem,
	remoteFs: IFileSystem,
): Promise<{ transferred: TransferredEntities[]; error?: Error }> {
	const transfer = action.action === "rename_remote" ? upload : download;
	if (!action.isFolder) {
		if (!action.hasContentChange) return { transferred: [] };
		const one = await transfer(localFs, remoteFs, action.path);
		return { transferred: one ? [one] : [] };
	}
	const transferred: TransferredEntities[] = [];
	let error: Error | undefined;
	for (const path of action.changedDescendants ?? []) {
		try {
			const one = await transfer(localFs, remoteFs, path);
			if (one) transferred.push(one);
		} catch (err) {
			error ??= err instanceof Error ? err : new Error(String(err));
		}
	}
	return { transferred, error };
}
