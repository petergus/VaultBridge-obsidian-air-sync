import type { RenamePair, SyncAction } from "./types";
import type { RenameOptResult } from "./rename-optimizer-types";
import type { Logger } from "../logging/logger";
import { replaceConsumed } from "./rename-optimizer";
import { checksumsEqual } from "./content-identity";

/*
 * Content-match rename heuristics — the fallback for moves that arrive WITHOUT rename
 * information (no Obsidian rename event on the local side; no backend rename pair on
 * the remote side). Each pairs an unmatched delete with an unmatched create whose
 * content provably equals the deleted file's last-synced content, and replaces the pair
 * with a single rename — so a move is never planned as a deletion plus a new file.
 */

/**
 * Heuristic rename optimization for external moves (e.g. in Finder, Git, or while Obsidian was closed).
 * Matches unmatched `delete_remote` and `push` actions that share identical content hash and file size.
 */
export function optimizeHeuristicRenames(
	actions: SyncAction[],
	logger?: Logger,
): RenameOptResult {
	const delCandidates: SyncAction[] = [];
	for (const a of actions) {
		if (
			a.action === "delete_remote" &&
			!a.remote?.isDirectory &&
			!a.local?.isDirectory &&
			!!a.baseline?.hash &&
			(a.baseline?.localSize ?? 0) > 0
		) {
			delCandidates.push(a);
		}
	}

	if (delCandidates.length === 0) {
		return { actions, applied: [], skipped: [] };
	}

	const pushCandidates: SyncAction[] = [];
	for (const a of actions) {
		if (
			a.action === "push" &&
			!a.local?.isDirectory &&
			!!a.local?.hash &&
			(a.local?.size ?? 0) > 0
		) {
			pushCandidates.push(a);
		}
	}

	if (pushCandidates.length === 0) {
		return { actions, applied: [], skipped: [] };
	}

	const pushesByHash = new Map<string, SyncAction[]>();
	for (const p of pushCandidates) {
		const hash = p.local!.hash;
		let list = pushesByHash.get(hash);
		if (!list) {
			list = [];
			pushesByHash.set(hash, list);
		}
		list.push(p);
	}

	const consumed = new Set<string>();
	const renamed: SyncAction[] = [];
	const applied: RenamePair[] = [];

	for (const del of delCandidates) {
		const hash = del.baseline!.hash;
		const matches = pushesByHash.get(hash);
		if (!matches || matches.length === 0) continue;

		const available = matches.filter(
			(p) => !consumed.has(p.path) && p.local!.size === del.baseline!.localSize,
		);
		if (available.length === 0) continue;

		const delName = del.path.split("/").pop();
		let bestMatch = available.find((p) => p.path.split("/").pop() === delName);
		if (!bestMatch && available.length === 1) {
			bestMatch = available[0];
		}

		if (bestMatch) {
			consumed.add(del.path);
			consumed.add(bestMatch.path);
			renamed.push({
				path: bestMatch.path,
				action: "rename_remote",
				oldPath: del.path,
				local: bestMatch.local,
				remote: del.remote,
				baseline: del.baseline,
			});
			applied.push({ oldPath: del.path, newPath: bestMatch.path });
			logger?.info("Heuristic content-match rename optimized", {
				oldPath: del.path,
				newPath: bestMatch.path,
			});
		}
	}

	if (consumed.size === 0) {
		return { actions, applied: [], skipped: [] };
	}

	return {
		actions: replaceConsumed(actions, consumed, renamed),
		applied,
		skipped: [],
	};
}

/**
 * Does the remote file at the pull's path provably hold the bytes last synced at the
 * delete's path? Same-algorithm checksum (or sha256 hash) equality plus equal size.
 */
function remoteMatchesBaseline(del: SyncAction, pull: SyncAction): boolean {
	const base = del.baseline;
	const remote = pull.remote;
	if (!base || !remote || remote.size !== base.remoteSize) return false;
	if (base.remoteChecksum && remote.remoteChecksum) {
		return checksumsEqual(base.remoteChecksum, remote.remoteChecksum);
	}
	return !!base.hash && !!remote.hash && base.hash === remote.hash;
}

/**
 * Heuristic rename detection for remote moves the backend did not report as renames
 * (a cold full-scan reconcile, which has no delta, or a backend delta that surfaced
 * the move as delete + add). Mirror of the local `optimizeHeuristicRenames`: pairs an
 * unmatched `delete_local(old)` with a no-baseline `pull(new)` whose remote content
 * provably equals the old file's last-synced content, and replaces them with a single
 * `rename_local` — so moving files on one device never lands on the other as a burst
 * of deletions plus fresh downloads. The local copy is known unchanged (the planner
 * only emits `delete_local` when local still matches its baseline). Empty files are
 * skipped (every empty file matches every other), and an ambiguous match is only taken
 * when the file name is unchanged.
 */
export function optimizeHeuristicRemoteRenames(
	actions: SyncAction[],
	logger?: Logger,
): RenameOptResult {
	const dels = actions.filter(
		(a) => a.action === "delete_local" && !a.local?.isDirectory && (a.baseline?.remoteSize ?? 0) > 0,
	);
	if (dels.length === 0) return { actions, applied: [], skipped: [] };
	const pulls = actions.filter(
		(a) => a.action === "pull" && !a.baseline && !a.local && !a.remote?.isDirectory && (a.remote?.size ?? 0) > 0,
	);
	if (pulls.length === 0) return { actions, applied: [], skipped: [] };

	// Index by size so a large cold-scan pull set isn't rescanned for every delete.
	const pullsBySize = new Map<number, SyncAction[]>();
	for (const p of pulls) {
		const size = p.remote!.size;
		const bucket = pullsBySize.get(size);
		if (bucket) bucket.push(p);
		else pullsBySize.set(size, [p]);
	}

	const consumed = new Set<string>();
	const renamed: SyncAction[] = [];
	const applied: RenamePair[] = [];

	for (const del of dels) {
		const sameSize = pullsBySize.get(del.baseline!.remoteSize) ?? [];
		const available = sameSize.filter((p) => !consumed.has(p.path) && remoteMatchesBaseline(del, p));
		if (available.length === 0) continue;
		const name = del.path.split("/").pop();
		const match = available.find((p) => p.path.split("/").pop() === name)
			?? (available.length === 1 ? available[0] : undefined);
		if (!match) continue;
		consumed.add(del.path);
		consumed.add(match.path);
		renamed.push({
			path: match.path,
			action: "rename_local",
			oldPath: del.path,
			local: del.local,
			remote: match.remote,
			baseline: del.baseline,
		});
		applied.push({ oldPath: del.path, newPath: match.path });
		logger?.info("Heuristic content-match remote rename optimized", {
			oldPath: del.path,
			newPath: match.path,
		});
	}

	if (consumed.size === 0) return { actions, applied: [], skipped: [] };
	return { actions: replaceConsumed(actions, consumed, renamed), applied, skipped: [] };
}
