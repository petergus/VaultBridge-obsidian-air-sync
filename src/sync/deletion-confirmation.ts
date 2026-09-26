import type { IFileSystem } from "../fs/interface";
import type { MixedEntity } from "./types";
import { AsyncPool } from "../queue/async-queue";

/*
 * Never derive a deletion from listing-absence alone. A listing can under-report —
 * the vault index before it settles, a truncated or failed remote scan — and a path
 * missing from it is indistinguishable from a deleted one. Each "looks deleted"
 * candidate is re-stat()'d against the authoritative filesystem before the planner
 * sees it; only a confirmed absence stays a deletion.
 */

/**
 * Confirm warm-mode local deletions against the authoritative filesystem.
 * A baseline path absent from localFs.list() (the in-memory vault index) but
 * present on disk was simply not indexed — it was NOT deleted. Re-stat each such
 * candidate; if it exists, set entry.local so an incomplete listing cannot drive
 * an erroneous delete_remote. (When the remote is also gone, the file is then
 * compared as a genuine remote deletion rather than a no-op cleanup.)
 */
export async function confirmLocalDeletions(
	entries: MixedEntity[],
	localFs: IFileSystem,
): Promise<void> {
	const candidates = entries.filter((e) => !e.local && e.prevSync);
	if (candidates.length === 0) return;

	const pool = new AsyncPool(10);
	await Promise.all(
		candidates.map((entry) =>
			pool.run(async () => {
				try {
					const stat = await localFs.stat(entry.path);
					if (stat) {
						entry.local = stat;
					}
				} catch {
					// Skip — a genuinely missing file returns null/throws → stays a deletion
				}
			})
		)
	);
}

/**
 * Confirm cold-mode remote deletions against the authoritative remote filesystem.
 * A baseline path absent from remoteFs.list() but still present on the remote was
 * simply missing from the listing (truncated scan, post-error cursor stale, etc.) —
 * it was NOT deleted. Re-stat each such candidate; if the remote file exists, set
 * entry.remote so an incomplete listing cannot drive an erroneous delete_local.
 */
export async function confirmRemoteDeletions(
	entries: MixedEntity[],
	remoteFs: IFileSystem,
): Promise<void> {
	const candidates = entries.filter((e) => !e.remote && e.prevSync);
	if (candidates.length === 0) return;

	const pool = new AsyncPool(10);
	await Promise.all(
		candidates.map((entry) =>
			pool.run(async () => {
				try {
					const stat = await remoteFs.stat(entry.path);
					if (stat) {
						entry.remote = stat;
					}
				} catch {
					// Skip — a genuinely missing remote file returns null/throws → stays a deletion
				}
			})
		)
	);
}
