import type { RenamePair, SyncAction } from "./types";
import type { FolderRenameOptResult, RenameOptResult, SkippedRename } from "./rename-optimizer-types";
import type { Logger } from "../logging/logger";
import { replaceConsumed } from "./rename-optimizer";

/**
 * Validate that a delete_remote + push pair represents a pure local rename
 * (content unchanged). Centralises the hash-verification rule for local renames.
 */
function isValidLocalRename(del: SyncAction, push: SyncAction): boolean {
	return (
		del.action === "delete_remote" &&
		push.action === "push" &&
		!!del.baseline?.hash &&
		!!push.local?.hash &&
		push.local.hash === del.baseline.hash
	);
}

function classifySkipReason(del: SyncAction | undefined, push: SyncAction | undefined): SkippedRename["reason"] {
	if (del?.action !== "delete_remote" || push?.action !== "push") return "action_type_mismatch";
	if (!del.baseline?.hash || !push.local?.hash) return "hash_missing";
	return "hash_mismatch";
}

/**
 * Replace matching `delete_remote(oldPath) + push(newPath)` pairs
 * with a single `rename_remote` action when the content hash is unchanged.
 *
 * Local rename events require hash verification to distinguish
 * pure renames from delete-and-re-upload.
 */
export function optimizeLocalFileRenames(
	actions: SyncAction[],
	renamePairs: ReadonlyMap<string, string>,
	logger?: Logger,
): RenameOptResult {
	if (renamePairs.size === 0) return { actions, applied: [], skipped: [] };

	const byPath = new Map<string, SyncAction>();
	for (const a of actions) byPath.set(a.path, a);

	const consumed = new Set<string>();
	const renamed: SyncAction[] = [];
	const applied: RenamePair[] = [];
	const skipped: SkippedRename[] = [];

	for (const [newPath, oldPath] of renamePairs) {
		const del = byPath.get(oldPath);
		const push = byPath.get(newPath);
		if (!del || !push || !isValidLocalRename(del, push)) {
			const reason = classifySkipReason(del, push);
			skipped.push({ pair: { oldPath, newPath }, reason });
			logger?.debug("Local rename optimization skipped", {
				newPath, oldPath, reason,
			});
			continue;
		}
		renamed.push({
			path: newPath,
			action: "rename_remote",
			oldPath,
			local: push.local,
			remote: del.remote,
			baseline: del.baseline,
		});
		consumed.add(oldPath);
		consumed.add(newPath);
		applied.push({ oldPath, newPath });
	}

	if (consumed.size === 0) return { actions, applied, skipped };

	return { actions: replaceConsumed(actions, consumed, renamed), applied, skipped };
}

/**
 * Coalesce individual file renames into a single folder rename action
 * when a folder rename is detected from Obsidian events.
 *
 * Only coalesces when ALL descendant file renames have matching hashes
 * (pure renames with no content changes).
 *
 * Uses the same hash-verification rule as file renames.
 */
export function coalesceLocalFolderRenames(
	actions: SyncAction[],
	folderRenamePairs: ReadonlyMap<string, string>,
	fileRenamePairs: ReadonlyMap<string, string>,
	logger?: Logger,
): FolderRenameOptResult {
	if (folderRenamePairs.size === 0) {
		return { actions, remainingFileRenames: fileRenamePairs, applied: [], skipped: [] };
	}

	const byPath = new Map<string, SyncAction>();
	for (const a of actions) byPath.set(a.path, a);

	const consumed = new Set<string>();
	const consumedFileRenames = new Set<string>();
	const folderRenames: SyncAction[] = [];
	const applied: RenamePair[] = [];
	const skipped: SkippedRename[] = [];

	for (const [newFolder, oldFolder] of folderRenamePairs) {
		const oldPrefix = oldFolder + "/";
		const newPrefix = newFolder + "/";

		// 1. Explicit file rename pairs (if provided by caller/tests)
		const candidatePairs = new Map<string, string>();
		for (const [newFile, oldFile] of fileRenamePairs) {
			if (!oldFile.startsWith(oldPrefix) || !newFile.startsWith(newPrefix)) continue;
			const suffix = oldFile.substring(oldPrefix.length);
			if (newFile !== newPrefix + suffix) continue;
			candidatePairs.set(newFile, oldFile);
		}

		// 2. Discover pairs directly from actions: Obsidian's rename event only fires for
		// TFolder, not for individual child files. When the folder is renamed locally,
		// planSync emits delete_remote under oldPrefix and push under newPrefix.
		for (const a of actions) {
			if (a.action === "delete_remote" && a.path.startsWith(oldPrefix)) {
				const suffix = a.path.substring(oldPrefix.length);
				const expectedNew = newPrefix + suffix;
				if (!candidatePairs.has(expectedNew)) {
					candidatePairs.set(expectedNew, a.path);
				}
			}
		}

		// If there are files being pushed under newPrefix that do not correspond to any
		// file in the old folder (new files added to the new folder), we cannot coalesce
		// the entire directory atomically because uploads must not precede the folder rename.
		let skipReason: SkippedRename["reason"] | null = null;
		const hasExtraNewFiles = actions.some(
			(a) =>
				a.action === "push" &&
				a.path.startsWith(newPrefix) &&
				!candidatePairs.has(a.path),
		);
		if (hasExtraNewFiles) {
			skipReason = "action_type_mismatch";
		}

		const descendants: RenamePair[] = [];
		if (!skipReason) {
			for (const [newFile, oldFile] of candidatePairs) {
				const del = byPath.get(oldFile);
				const push = byPath.get(newFile);
				if (!del || !push || !isValidLocalRename(del, push)) {
					skipReason = classifySkipReason(del, push);
					logger?.debug("Folder rename: validation failed", {
						oldFile, newFile, reason: skipReason,
					});
					break;
				}
				descendants.push({ oldPath: oldFile, newPath: newFile });
			}
		}

		if (skipReason) {
			skipped.push({ pair: { oldPath: oldFolder, newPath: newFolder }, reason: skipReason });
			logger?.debug("Folder rename coalescing skipped", { oldFolder, newFolder, reason: skipReason });
			continue;
		}

		if (descendants.length === 0) {
			skipped.push({ pair: { oldPath: oldFolder, newPath: newFolder }, reason: "no_descendants" });
			logger?.debug("Folder rename coalescing skipped", { oldFolder, newFolder, reason: "no_descendants" });
			continue;
		}

		for (const { oldPath, newPath } of descendants) {
			consumed.add(oldPath);
			consumed.add(newPath);
			consumedFileRenames.add(newPath);
		}

		folderRenames.push({
			path: newFolder,
			action: "rename_remote",
			oldPath: oldFolder,
			isFolder: true,
			descendants,
		});
		applied.push({ oldPath: oldFolder, newPath: newFolder, isFolder: true });
		logger?.debug("Folder rename coalesced", { oldFolder, newFolder, descendants: descendants.length });
	}

	const remaining = new Map<string, string>();
	for (const [newPath, oldPath] of fileRenamePairs) {
		if (!consumedFileRenames.has(newPath)) remaining.set(newPath, oldPath);
	}

	// For skipped folders, provide any discovered candidate pairs that weren't consumed
	// so that optimizeLocalFileRenames can still optimize valid individual files as file renames
	for (const { pair } of skipped) {
		const oldPrefix = pair.oldPath + "/";
		const newPrefix = pair.newPath + "/";
		for (const a of actions) {
			if (a.action === "delete_remote" && a.path.startsWith(oldPrefix)) {
				const suffix = a.path.substring(oldPrefix.length);
				const expectedNew = newPrefix + suffix;
				if (!consumed.has(a.path) && !consumed.has(expectedNew) && !remaining.has(expectedNew)) {
					remaining.set(expectedNew, a.path);
				}
			}
		}
	}

	if (consumed.size === 0) {
		return { actions, remainingFileRenames: remaining, applied, skipped };
	}

	return {
		actions: replaceConsumed(actions, consumed, folderRenames),
		remainingFileRenames: remaining,
		applied,
		skipped,
	};
}
