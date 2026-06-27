import type { IFileSystem } from "../fs/interface";
import type { MixedEntity, RenamePair, SyncRecord } from "./types";
import type { SyncStateStore } from "./state";
import type { TrackerSnapshot } from "./local-tracker";
import { hasChanged, hasRemoteChanged } from "./change-compare";
import { sha256, digest, isLocallyComputable } from "../utils/hash";
import { AsyncPool } from "../queue/async-queue";

export interface ChangeSet {
	entries: MixedEntity[];
	temperature: "hot" | "warm" | "cold";
	remoteRenamePairs: RenamePair[];
}

export interface ChangeDetectorDeps {
	localFs: IFileSystem;
	remoteFs: IFileSystem;
	stateStore: SyncStateStore;
	changes: TrackerSnapshot;
	/**
	 * Drop excluded paths at the SOURCE — before any per-path `stat()` (network on
	 * the remote side) or content-read enrichment. An excluded file that exists on
	 * both sides never gets a sync record (it must not sync), so without this it
	 * re-enters detection every cycle and is re-read + re-hashed by
	 * `enrichHashesForInitialMatch` forever — a fixed per-sync cost the orchestrator
	 * used to absorb only by filtering AFTER detection. Optional; defaults to
	 * "exclude nothing" so callers/tests opt in.
	 */
	isExcluded?: (path: string) => boolean;
}

export interface CollectChangesOptions {
	/**
	 * Force a COLD full join regardless of tracker/store state. Used for crash
	 * recovery: after an interrupted or partial sync the delta-based hot/warm
	 * path can't rediscover remote files that were reported but never baselined
	 * (the cursor has moved past them). A full remote list vs records can.
	 */
	forceFullScan?: boolean;
}

/**
 * Collect changes using the appropriate temperature mode.
 *
 * hot  (O(delta)): tracker initialized + dirty paths → stat() + cache + getMany()
 * warm (O(n) local + O(delta) remote): list() + getAll() diff + remote delta
 * cold (O(n)): both list() + full join (equivalent to buildMixedEntities)
 *
 * `forceFullScan` overrides the hot/warm choice and always runs COLD.
 */
export async function collectChanges(
	deps: ChangeDetectorDeps,
	opts: CollectChangesOptions = {},
): Promise<ChangeSet> {
	const { changes, stateStore } = deps;

	let changeSet: ChangeSet;

	// Determine temperature
	if (!opts.forceFullScan && changes.initialized && changes.dirtyPaths.size > 0) {
		changeSet = await collectHot(deps);
	} else {
		const allRecords = await stateStore.getAll();
		changeSet = opts.forceFullScan || allRecords.length === 0
			? await collectCold(deps, allRecords)
			: await collectWarm(deps, allRecords);
	}

	// Enrich empty hashes for entries without baseline (all temperature modes)
	await enrichHashesForInitialMatch(changeSet.entries, deps.localFs);

	// Ensure rename-related local entries have hashes (WARM/COLD use list() → hash:"")
	await enrichHashesForRenames(changeSet.entries, deps.localFs, changes.renamePairs);

	// Both warm and cold infer local deletions from absence in list(), which can
	// under-report (warm: vault index; cold: post-error full scan that may be
	// truncated). Confirm each "looks locally deleted" candidate against the
	// authoritative filesystem so an under-reported listing can't drive a wrongful
	// delete_remote. Cold mode is the post-failure recovery path — running this
	// guard there is especially important.
	if (changeSet.temperature === "warm" || changeSet.temperature === "cold") {
		await confirmLocalDeletions(changeSet.entries, deps.localFs);
	}

	// Mirror guard for the remote side: confirm "looks remotely deleted" candidates
	// via stat() so a partial or truncated remote list() can't drive a wrongful
	// delete_local. Applies to cold mode (the post-failure full-scan) only — warm
	// already has a delta cursor so remote absences are authoritative there.
	if (changeSet.temperature === "cold") {
		await confirmRemoteDeletions(changeSet.entries, deps.remoteFs);
	}

	return changeSet;
}

async function collectHot(deps: ChangeDetectorDeps): Promise<ChangeSet> {
	const { localFs, remoteFs, stateStore, changes } = deps;

	const dirtyPaths = changes.dirtyPaths;

	// Get remote changed paths if supported
	const remoteChanges = await getRemoteChanges(remoteFs);

	// Union of local dirty and remote changed paths
	const changedPaths = new Set<string>(dirtyPaths);
	for (const p of remoteChanges.paths) {
		changedPaths.add(p);
	}

	const isExcluded = deps.isExcluded ?? (() => false);
	const pathArray = Array.from(changedPaths).filter((p) => !isExcluded(p));

	// Fetch local stats, remote stats, and sync records in parallel
	const [localStats, remoteStats, syncRecords] = await Promise.all([
		Promise.all(pathArray.map((p) => localFs.stat(p))),
		Promise.all(pathArray.map((p) => remoteFs.stat(p))),
		stateStore.getMany(pathArray),
	]);

	const entries: MixedEntity[] = pathArray.map((path, i) => {
		const local = localStats[i] ?? undefined;
		const remote = remoteStats[i] ?? undefined;
		const prevSync = syncRecords.get(path);
		return {
			path,
			local,
			remote,
			prevSync,
		};
	});

	// Keep only entries that actually changed vs baseline (prune no-ops). This also
	// subsumes the "has any side" existence check: an entry with neither local nor
	// remote nor a prevSync can't have changed, so the predicate's branches drop it
	// (the first branch returns `!!prev` === false for the all-absent case).
	const changed = entries.filter((e) => {
		const prev = e.prevSync;
		// Both deleted — include if previously synced (cleanup)
		if (!e.local && !e.remote) return !!prev;
		// New file: no prev record
		if (!prev) return true;
		// Local deleted but remote still exists (e.g. rename source)
		if (!e.local && e.remote) return true;
		// Local changed
		if (e.local && hasChanged(e.local, prev)) return true;
		// Remote changed
		if (e.remote && hasRemoteChanged(e.remote, prev)) return true;
		return false;
	});

	return { entries: changed, temperature: "hot", remoteRenamePairs: remoteChanges.renamed };
}

async function collectWarm(deps: ChangeDetectorDeps, allRecords: SyncRecord[]): Promise<ChangeSet> {
	const { localFs, remoteFs } = deps;

	const [localFiles, remoteChanges] = await Promise.all([
		localFs.list(),
		getRemoteChanges(remoteFs),
	]);

	const recordMap = new Map(allRecords.map((r) => [r.path, r]));
	const changedPaths = new Set<string>();

	// Compare local listing against sync records
	for (const file of localFiles) {
		const record = recordMap.get(file.path);
		if (!record || hasChanged(file, record)) {
			changedPaths.add(file.path);
		}
	}

	// Include paths that existed in records but are no longer in local listing (local deletions)
	const localPathSet = new Set(localFiles.map((f) => f.path));
	for (const record of allRecords) {
		if (!localPathSet.has(record.path)) {
			changedPaths.add(record.path);
		}
	}

	// Add remote changed paths
	for (const p of remoteChanges.paths) {
		changedPaths.add(p);
	}

	// Include rename pair paths so warm mode can optimize renames
	const renamePairs = deps.changes.renamePairs;
	for (const [newPath, oldPath] of renamePairs) {
		changedPaths.add(newPath);
		changedPaths.add(oldPath);
	}

	const isExcluded = deps.isExcluded ?? (() => false);
	const pathArray = Array.from(changedPaths).filter((p) => !isExcluded(p));
	const remoteStats = await Promise.all(pathArray.map((p) => remoteFs.stat(p)));

	const localFileMap = new Map(localFiles.map((f) => [f.path, f]));

	const entries: MixedEntity[] = pathArray.map((path, i) => {
		const remote = remoteStats[i] ?? undefined;
		return {
			path,
			local: localFileMap.get(path),
			remote,
			prevSync: recordMap.get(path),
		};
	});

	return { entries, temperature: "warm", remoteRenamePairs: remoteChanges.renamed };
}

async function collectCold(deps: ChangeDetectorDeps, allRecords: SyncRecord[]): Promise<ChangeSet> {
	const { localFs, remoteFs } = deps;

	const [localFiles, remoteFiles] = await Promise.all([
		localFs.list(),
		remoteFs.list(),
	]);
	const syncRecords = allRecords;
	const isExcluded = deps.isExcluded ?? (() => false);

	const pathMap = new Map<string, MixedEntity>();

	const getOrCreate = (path: string): MixedEntity => {
		let entity = pathMap.get(path);
		if (!entity) {
			entity = { path };
			pathMap.set(path, entity);
		}
		return entity;
	};

	for (const file of localFiles) {
		if (isExcluded(file.path)) continue;
		getOrCreate(file.path).local = file;
	}

	for (const file of remoteFiles) {
		if (isExcluded(file.path)) continue;
		getOrCreate(file.path).remote = file;
	}

	for (const record of syncRecords) {
		if (isExcluded(record.path)) continue;
		getOrCreate(record.path).prevSync = record;
	}

	return { entries: Array.from(pathMap.values()), temperature: "cold", remoteRenamePairs: [] };
}

/**
 * Enrich empty hashes for entries without baseline by comparing the local
 * digest with the remote's backend-provided checksum. Runs for all temperature
 * modes to handle partial initial syncs and simultaneous file creation.
 *
 * Only fires when the remote checksum's algorithm is locally computable
 * (everything except `"opaque"` — md5/sha1/sha256/dropbox/quickxor). Backends
 * whose checksum is "opaque" (e.g. pCloud's internal content hash) cannot be
 * matched against local content, so their entries are skipped here and left to
 * the normal conflict path.
 */
async function enrichHashesForInitialMatch(
	entries: MixedEntity[],
	localFs: IFileSystem,
): Promise<void> {
	const candidates = entries.filter(
		(e) => e.local && e.remote && !e.prevSync &&
			!e.local.hash && !e.remote.hash &&
			e.local.size === e.remote.size &&
			e.remote.remoteChecksum !== undefined &&
			isLocallyComputable(e.remote.remoteChecksum.algo)
	);
	if (candidates.length === 0) return;

	const pool = new AsyncPool(10);
	await Promise.all(
		candidates.map((entry) =>
			pool.run(async () => {
				try {
					const remoteChecksum = entry.remote!.remoteChecksum!;
					const content = await localFs.read(entry.path);
					const localDigest = await digest(content, remoteChecksum.algo);
					if (localDigest === remoteChecksum.value) {
						const contentHash = await sha256(content);
						entry.local = { ...entry.local!, hash: contentHash };
						entry.remote = { ...entry.remote!, hash: contentHash };
					}
				} catch {
					// Skip failed reads — entry stays unenriched (conflict, safe side)
				}
			})
		)
	);
}

/**
 * Ensure rename destination entries have hashes via stat().
 * In WARM/COLD mode, list() returns hash:"" — the rename optimizer
 * needs a real hash to verify content equivalence.
 */
export async function enrichHashesForRenames(
	entries: MixedEntity[],
	localFs: IFileSystem,
	renamePairs: ReadonlyMap<string, string>,
): Promise<void> {
	if (renamePairs.size === 0) return;

	const newPaths = new Set(renamePairs.keys());
	const candidates = entries.filter(
		(e) => newPaths.has(e.path) && e.local && !e.local.hash,
	);
	if (candidates.length === 0) return;

	await Promise.all(
		candidates.map(async (entry) => {
			try {
				const stat = await localFs.stat(entry.path);
				if (stat && !stat.isDirectory && stat.hash) {
					entry.local = { ...entry.local!, hash: stat.hash };
				}
			} catch {
				// Skip — rename optimizer falls back to push+delete
			}
		})
	);
}

/**
 * Confirm warm-mode local deletions against the authoritative filesystem.
 * A baseline path absent from localFs.list() (the in-memory vault index) but
 * present on disk was simply not indexed — it was NOT deleted. Re-stat each such
 * candidate; if it exists, set entry.local so an incomplete listing cannot drive
 * an erroneous delete_remote. (When the remote is also gone, the file is then
 * compared as a genuine remote deletion rather than a no-op cleanup.)
 */
async function confirmLocalDeletions(
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
async function confirmRemoteDeletions(
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

interface RemoteChanges {
	paths: string[];
	renamed: RenamePair[];
}

async function getRemoteChanges(remoteFs: IFileSystem): Promise<RemoteChanges> {
	if (!remoteFs.checkpoint) return { paths: [], renamed: [] };
	const result = await remoteFs.checkpoint.getChangedPaths();
	if (!result) return { paths: [], renamed: [] };
	return {
		paths: [...result.modified, ...result.deleted],
		renamed: result.renamed ?? [],
	};
}
