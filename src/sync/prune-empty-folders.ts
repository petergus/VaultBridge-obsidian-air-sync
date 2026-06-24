import type { IFileSystem } from "../fs/interface";
import type { Logger } from "../logging/logger";
import type { SyncAction } from "./types";

/** The two filesystems a prune walks, plus an optional logger. */
export interface PruneContext {
	localFs: IFileSystem;
	remoteFs: IFileSystem;
	logger?: Logger;
}

/**
 * Phase 4 of plan execution: after a cycle's structural mutations, delete parent
 * directories left empty by a delete or rename. Given the cycle's *succeeded*
 * actions, it collects each affected parent on the side that was mutated, then walks
 * upward removing a directory only once it lists empty — deepest paths first, so a
 * child is pruned before its parent is reconsidered. A listing/delete error stops
 * that branch's walk rather than failing the cycle (the prune is best-effort cleanup).
 */
export async function pruneEmptyParentFolders(
	succeededActions: SyncAction[],
	ctx: PruneContext,
): Promise<void> {
	const localCleanups = new Set<string>();
	const remoteCleanups = new Set<string>();

	for (const action of succeededActions) {
		if (action.action === "delete_local" || action.action === "rename_local") {
			const oldPath = action.action === "rename_local" ? action.oldPath : action.path;
			if (oldPath) {
				const parent = oldPath.substring(0, oldPath.lastIndexOf("/"));
				if (parent) localCleanups.add(parent);
			}
		}
		if (action.action === "delete_remote" || action.action === "rename_remote") {
			const oldPath = action.action === "rename_remote" ? action.oldPath : action.path;
			if (oldPath) {
				const parent = oldPath.substring(0, oldPath.lastIndexOf("/"));
				if (parent) remoteCleanups.add(parent);
			}
		}
	}

	const prune = async (fs: IFileSystem, folderPath: string) => {
		let current = folderPath;
		while (current) {
			try {
				const children = await fs.listDir(current);
				if (children.length > 0) break;
				ctx.logger?.debug(`Pruning empty directory: ${current}`);
				await fs.delete(current);
				current = current.substring(0, current.lastIndexOf("/"));
			} catch {
				break;
			}
		}
	};

	// Deepest first so a/b/c is pruned before a/b is reconsidered.
	const sortPaths = (paths: Set<string>) =>
		Array.from(paths).sort((a, b) => b.split("/").length - a.split("/").length);

	for (const path of sortPaths(localCleanups)) {
		await prune(ctx.localFs, path);
	}
	for (const path of sortPaths(remoteCleanups)) {
		await prune(ctx.remoteFs, path);
	}
}
