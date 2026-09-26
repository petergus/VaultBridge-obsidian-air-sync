/**
 * VaultBridge intercepts `fileManager.trashFile` so a user's delete can offer
 * "delete from vault & cloud" (see `ui/delete-hooks.ts`). The plugin's own deletions —
 * a sync applying a remote deletion, or the confirm modal finishing a delete — must pass
 * straight through that interception. They run inside {@link withTrashModalSuppressed}.
 *
 * A depth counter rather than a boolean: local deletions run pooled, so overlapping
 * calls must not clear each other's suppression when the first one finishes.
 */
let suppressionDepth = 0;

export async function withTrashModalSuppressed<T>(fn: () => Promise<T>): Promise<T> {
	suppressionDepth++;
	try {
		return await fn();
	} finally {
		suppressionDepth--;
	}
}

export function isTrashModalSuppressed(): boolean {
	return suppressionDepth > 0;
}
