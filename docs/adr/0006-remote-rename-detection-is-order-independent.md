# ADR 0006 — Remote rename detection is order-independent; Dropbox's path-addressed delta reorders before applying

**Status:** Accepted · 2026-06-14
**Context area:** `fs/` backends — incremental sync / delta application (`fs/dropbox/incremental-sync.ts`, `fs/caching/id-delta.ts`)
**Related:** [ADR 0001](0001-metadata-cache-is-subordinate-to-commit-last.md) (convergence — a missed rename is an efficiency bug, not a correctness one), [ADR 0002](0002-backends-verified-by-shared-behaviour-contracts.md) (the shared crash-safety contract this extends), [ADR 0003](0003-opt-in-e2e-validates-fakes-against-real-backends.md) (the opt-in e2e that backstops the delta SHAPE against live Dropbox), [dropbox-backend.md](../dropbox-backend.md)

## Context

A remote rename/move must surface from `IFileSystem.checkpoint.getChangedPaths()` as a
single `RenamePair` so the engine can replay it as one `rename_local` (or `rename_remote`),
instead of deleting and re-downloading every affected file. For a folder that is the
difference between one `localFs.rename(A→B)` and a delete+pull of the entire subtree.

How a backend encodes a rename in its delta depends on how it addresses files:

- **Id-addressed backends (Google Drive, OneDrive).** A rename is a **single id-keyed
  change**: the same file id reappears with a new name/parent. The shared
  `applyIdDeltaPage` (`fs/caching/id-delta.ts`) detects the move by looking the id up in
  the cache (`getPathById`) and rewrites the descendants. No path-keyed tombstone is
  involved, and the page is sorted folders-shallow-first, so detection is **inherently
  order-independent**. Google Drive doesn't even re-emit a renamed folder's children
  (their metadata is unchanged); OneDrive may, but they resolve against the
  already-renamed parent.

- **Path-addressed backend (Dropbox).** `list_folder/continue` encodes a rename as a
  **pair**: `deleted(oldPath)` + `file/folder(newPath)` sharing a stable `id`. Coalescing
  back into a rename requires the old `id→path` mapping to still be present when the new
  entry is applied — but **Dropbox does not guarantee the add precedes the delete.** If
  the `deleted(old)` is applied first, `cache.removeTree(old)` drops the id mapping (and
  every descendant's), so the later same-id upsert can no longer reverse-resolve the old
  path. Detection fails and the rename degrades to delete+add — for a folder, a
  file-by-file re-pull of the whole subtree. This was a real, user-reported bug; the
  earlier code applied entries in raw receive order and the source even acknowledged the
  degradation.

This is the "path↔id resolution difference" that made the same remote action behave
differently per backend.

## Decision

**Make remote rename detection order-independent on every backend, and bring Dropbox's
path-addressed delta up to that bar by reordering before applying.**

Concretely, `applyDropboxDelta` (`fs/dropbox/incremental-sync.ts`):

1. **Drain the whole delta first, then apply upserts before deletes.** A rename's
   `deleted(old)` and `add(new)` can land on different pages, so the reorder spans the
   full drained delta, not one page. Applying every `file`/`folder` upsert first means the
   old `id→path` mapping is still present, so `getPathById` coalesces the move into one
   `RenamePair` (folders also rewrite child paths); the trailing `deleted(old)` then finds
   the path already vacated and is a no-op.

2. **Sort upserts folders-then-shallow-first** (parity with `applyIdDeltaPage`), so a
   parent folder's rename is applied — rewriting child paths — before any child entry, and
   a nested rename collapses to one pair instead of emitting redundant per-child pairs.

3. **Guard the delete pass against a reclaimed path.** A `deleted(path)` removes the
   subtree **only if** the entry now at `path` was *not* upserted in this same delta
   (`upsertIds`). If it was, the path is a rename target or a delete-then-recreate at the
   same path with a **different** id (the upsert already evicted the old occupant) — the
   upsert is authoritative and removing it would drop the live file. This guard is what
   keeps the legitimate "delete P, then create a new file at P" case correct; a naive
   "upserts-before-deletes" reorder without it would wrongly delete the recreated file.

Bounding (from ADR 0001): a *missed* rename is never data loss — it degrades to delete+add,
which still converges (the file is re-downloaded). So this is an **efficiency/quality**
fix, not a correctness patch; the guard above exists to avoid *introducing* a correctness
bug while making the common case efficient.

## Consequences

- **Dropbox folder/file renames now replay as a single `rename_local`**, regardless of the
  order Dropbox lists the delete vs the add — matching Google Drive and OneDrive.

- **Order-independence is now a cross-backend contract, run against the REAL FS.** The
  shared crash-safety contract (`fs/caching/remote-fs-contract.ts`, ADR 0002) gained a
  `stageRemoteRename` seam and two rename cases; each backend's harness emits its own
  faithful delta and the **Dropbox harness lists `deleted(old)` FIRST** so the contract
  pins exactly the ordering that used to break.

- **The delta SHAPE is backstopped by the opt-in e2e (ADR 0003), not the fakes.** The unit
  contracts prove "given this delta, the FS coalesces"; only the live e2e proves real
  Dropbox actually emits a folder rename as a same-id `deleted`+`add` (the
  `getChangedPaths` surface was previously unexercised against any live backend).

- **Prohibited:** applying Dropbox delta entries in raw receive order; "fixing" this by
  merely sorting upserts ahead of deletes without the `upsertIds` guard (re-breaks
  delete-then-recreate-at-the-same-path); assuming a `deleted` tombstone always means
  "remove the subtree" without checking whether the path was reclaimed this delta.

**Pinned by tests** (keep green; extend, don't weaken):
- `fs/dropbox/incremental-sync.test.ts` — DELETE-FIRST file & folder rename, child-before-parent
  ordering, and delete-then-recreate-same-path-different-id ⇒ NOT a rename.
- `fs/caching/remote-fs-contract.ts` — the cross-backend "remote FILE/FOLDER rename ⇒ one
  renamed pair" cases, run against the real Dropbox/Google Drive/OneDrive FS.
- `sync/convergence.test.ts` — remote folder/file rename collapses to one `rename_local` and
  reaches a fixed point on re-sync.
- `e2e/dropbox.e2e.ts` — out-of-band folder rename via `getChangedPaths` against live Dropbox.
