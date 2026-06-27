import type { VaultBridgeSettings } from "./settings";
import { DEFAULT_IGNORE_PATTERNS } from "./settings";

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Normalize a possibly-legacy `backendData` to the current single-bag shape.
 *
 * WHY THIS EXISTS: `settings.backendData` used to be a per-type map
 * (`{ "googledrive": {...}, "googledrive-custom": {...} }`) that held every
 * backend's params at once. It is now a single flat bag holding ONLY the active
 * backend's params, so another backend's data can never structurally linger.
 * Vaults saved by an older version still have the old nested shape on disk, so on
 * first load we lift the active backend's entry to the top level and discard every
 * other backend's leftovers. This keeps the currently-active backend connected
 * across the upgrade (its tokens live separately in SecretStorage and are
 * untouched) while honoring the "no foreign backend params persist" guarantee.
 *
 * This is cold-start normalization, NOT data migration: an incompatible old shape
 * is reshaped/discarded rather than transformed field-by-field. It is idempotent —
 * on the already-flat shape it is a no-op (returns false). It is a sanctioned
 * exception to CLAUDE.md's "no migration code" rule, recorded there. Old vs new is told apart
 * by whether `backendData` has a key equal to a REGISTERED backend type whose value
 * is an object; real param names never collide with a backend type, so this
 * discriminator has no false positives in practice.
 *
 * @returns true if `settings.backendData` was changed (caller should persist).
 */
export function liftActiveBackendData(
	settings: VaultBridgeSettings,
	knownTypes: readonly string[],
): boolean {
	const bag = settings.backendData;
	const isNested = knownTypes.some((t) => isObject(bag[t]));
	if (!isNested) return false;

	const active = bag[settings.backendType];
	settings.backendData = isObject(active) ? active : {};
	return true;
}

/**
 * Add any missing default ignore patterns to an existing vault's pattern list.
 *
 * WHY THIS EXISTS: `DEFAULT_IGNORE_PATTERNS` was added after initial release.
 * New installs get these patterns automatically via DEFAULT_SETTINGS, but
 * existing vaults only have whatever they had at first-run — which was [].
 * This migration appends each default pattern that isn't already present (either
 * literally or negated with a leading !) so no user-intentional exclusion is
 * overridden. Safe to run on every load — idempotent when patterns are present.
 *
 * @returns true if `settings.ignorePatterns` was changed (caller should persist).
 */
export function addMissingDefaultIgnorePatterns(settings: VaultBridgeSettings): boolean {
	let changed = false;
	for (const pattern of DEFAULT_IGNORE_PATTERNS) {
		const negated = `!${pattern}`;
		const alreadyPresent =
			settings.ignorePatterns.includes(pattern) ||
			settings.ignorePatterns.includes(negated);
		if (!alreadyPresent) {
			settings.ignorePatterns.push(pattern);
			changed = true;
		}
	}
	return changed;
}

/**
 * Migrate `maxDeletionsPerSync: 0` (the old "disabled" sentinel) to the safe
 * default of 20.
 *
 * WHY THIS EXISTS: the setting's documented meaning was "0 disables the guard",
 * which users set expecting safety and got the opposite — a disabled guard allows
 * unlimited mass deletions. The sentinel is now -1 (or leaving the field absent);
 * 0 is treated as "misconfigured" and silently corrected here. Any positive value
 * is left as-is (the user intentionally configured it).
 *
 * @returns true if `settings.maxDeletionsPerSync` was changed (caller should persist).
 */
export function normalizeDeletionLimit(settings: { maxDeletionsPerSync: number }): boolean {
	if (settings.maxDeletionsPerSync === 0) {
		settings.maxDeletionsPerSync = 20;
		return true;
	}
	return false;
}

/**
 * Coerce a removed/unknown `conflictStrategy` to a valid one.
 *
 * WHY THIS EXISTS: the interactive `"ask"` strategy was removed (it was never
 * reachable — the resolver's modal needs an `app` that the sync pipeline never
 * threads, so `"ask"` always fell back to `"duplicate"`). A vault saved while it
 * was selected still has `conflictStrategy: "ask"` on disk; left as-is it would
 * hit no `switch` case in the resolver. We map it to `"duplicate"` — what it
 * actually did — rather than the default, so the user's effective behavior is
 * preserved. Any other unrecognized value falls back to the default `"auto_merge"`.
 *
 * @returns true if `settings.conflictStrategy` was changed (caller should persist).
 */
export function normalizeConflictStrategy(settings: VaultBridgeSettings): boolean {
	const strategy = settings.conflictStrategy as string;
	if (strategy === "auto_merge" || strategy === "duplicate") return false;
	settings.conflictStrategy = strategy === "ask" ? "duplicate" : "auto_merge";
	return true;
}
