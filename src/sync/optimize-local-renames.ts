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
		if (!del || !push) {
			const reason = classifySkipReason(del, push);
			skipped.push({ pair: { oldPath, newPath }, reason });
			logger?.debug("Local rename optimization skipped", {
				newPath, oldPath, reason,
			});
			continue;
		}

		if (del.action !== "delete_remote" || push.action !== "push") {
			const reason = classifySkipReason(del, push);
			skipped.push({ pair: { oldPath, newPath }, reason });
			logger?.debug("Local rename optimization skipped", {
				newPath, oldPath, reason,
			});
			continue;
		}

		if (push.local?.isDirectory && (del.remote?.isDirectory || del.baseline)) {
			renamed.push({
				path: newPath,
				action: "rename_remote",
				oldPath,
				isFolder: true,
				local: push.local,
				remote: del.remote,
				baseline: del.baseline,
			});
			consumed.add(oldPath);
			consumed.add(newPath);
			applied.push({ oldPath, newPath, isFolder: true });
			continue;
		}

		if (!del.baseline?.hash || !push.local?.hash) {
			const reason = classifySkipReason(del, push);
			skipped.push({ pair: { oldPath, newPath }, reason });
			logger?.debug("Local rename optimization skipped", {
				newPath, oldPath, reason,
			});
			continue;
		}

		const isPure = isValidLocalRename(del, push);
		if (isPure) {
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
			continue;
		}

		// Content was modified during/after rename (e.g. Obsidian updated internal links):
		// Execute rename_remote with hasContentChange: true so the remote file is moved
		// and then updated with new content, avoiding deletion and re-upload.
		renamed.push({
			path: newPath,
			action: "rename_remote",
			oldPath,
			hasContentChange: true,
			local: push.local,
			remote: del.remote,
			baseline: del.baseline,
		});
		consumed.add(oldPath);
		consumed.add(newPath);
		applied.push({ oldPath, newPath });
		logger?.info("Local rename with content update optimized", { oldPath, newPath });
	}

	if (consumed.size === 0) return { actions, applied, skipped };

	return { actions: replaceConsumed(actions, consumed, renamed), applied, skipped };
}

/**
 * The folder's OWN endpoint actions for a folder move: `push(newFolder)` (a mkdir) and
 * `delete_remote(oldFolder)` (a recursive delete). Folders carry sync records, so the
 * planner emits both next to the descendants' delete/push pairs. They MUST be consumed
 * together with the move: left in the plan, the mkdir (Phase 1) occupies the
 * destination so the rename (Phase 3) fails "Destination already exists", and the
 * recursive delete then trashes every file that should have moved — which the other
 * device receives as a mass deletion.
 */
function localFolderEndpoints(
	byPath: ReadonlyMap<string, SyncAction>,
	oldFolder: string,
	newFolder: string,
): string[] {
	const endpoints: string[] = [];
	const del = byPath.get(oldFolder);
	if (del?.action === "delete_remote" && del.remote?.isDirectory) endpoints.push(oldFolder);
	const mk = byPath.get(newFolder);
	if (mk?.action === "push" && mk.local?.isDirectory) endpoints.push(newFolder);
	return endpoints;
}

/**
 * Coalesce individual file renames into a single folder rename action
 * when a folder rename is detected from Obsidian events.
 *
 * The folder rename event is authoritative (Obsidian moved the folder), so each
 * descendant `delete_remote(A/x) + push(B/x)` pair IS the moved file. A descendant
 * whose content also changed (Obsidian rewrote its links, or it was edited before
 * the sync ran) — or whose content can't be verified (no hash) — still moves with
 * the folder and is listed in `changedDescendants`, so its new content is uploaded
 * right after the move instead of the whole folder degrading to delete + re-upload.
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

		// 2. Discover pairs directly from actions: a descendant's own rename event may
		// not have been recorded (or not fire at all), but the folder move makes the
		// planner emit delete_remote under oldPrefix and push under newPrefix.
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
		const changedDescendants: string[] = [];
		if (!skipReason) {
			for (const [newFile, oldFile] of candidatePairs) {
				const del = byPath.get(oldFile);
				const push = byPath.get(newFile);
				if (del?.action !== "delete_remote" || push?.action !== "push") {
					skipReason = "action_type_mismatch";
					break;
				}
				const isDirectory = !!push.local?.isDirectory || !!del.remote?.isDirectory;
				if (isDirectory) {
					descendants.push({ oldPath: oldFile, newPath: newFile, isFolder: true });
					continue;
				}
				if (!isValidLocalRename(del, push)) {
					logger?.debug("Folder rename: descendant content changed, re-uploading after move", {
						oldFile, newFile, reason: classifySkipReason(del, push),
					});
					changedDescendants.push(newFile);
				}
				descendants.push({ oldPath: oldFile, newPath: newFile });
			}
		}

		const endpoints = skipReason ? [] : localFolderEndpoints(byPath, oldFolder, newFolder);
		if (!skipReason && descendants.length === 0 && endpoints.length < 2) {
			skipReason = "no_descendants";
		}

		if (skipReason) {
			skipped.push({ pair: { oldPath: oldFolder, newPath: newFolder }, reason: skipReason });
			logger?.debug("Folder rename coalescing skipped", { oldFolder, newFolder, reason: skipReason });
			continue;
		}

		for (const { oldPath, newPath } of descendants) {
			consumed.add(oldPath);
			consumed.add(newPath);
			consumedFileRenames.add(newPath);
		}
		for (const p of endpoints) consumed.add(p);

		const folderAction = byPath.get(newFolder);
		folderRenames.push({
			path: newFolder,
			action: "rename_remote",
			oldPath: oldFolder,
			isFolder: true,
			descendants,
			...(changedDescendants.length > 0 ? { changedDescendants } : {}),
			...(folderAction?.local ? { local: folderAction.local } : {}),
		});
		applied.push({ oldPath: oldFolder, newPath: newFolder, isFolder: true });
		logger?.debug("Folder rename coalesced", {
			oldFolder, newFolder, descendants: descendants.length, changed: changedDescendants.length,
		});
	}

	const remaining = new Map<string, string>();
	for (const [newPath, oldPath] of fileRenamePairs) {
		if (!consumedFileRenames.has(newPath)) remaining.set(newPath, oldPath);
	}

	// For skipped folders, provide any discovered candidate FILE pairs that weren't
	// consumed so that optimizeLocalFileRenames can still move each file individually.
	// Sub-folders are left to their own mkdir/delete: a per-file rename_remote of a
	// sub-folder would move its children on the remote before their own file renames
	// run, which then fail on the vanished source.
	for (const { pair } of skipped) {
		const oldPrefix = pair.oldPath + "/";
		const newPrefix = pair.newPath + "/";
		for (const a of actions) {
			if (a.action === "delete_remote" && a.path.startsWith(oldPrefix) && !a.remote?.isDirectory) {
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
