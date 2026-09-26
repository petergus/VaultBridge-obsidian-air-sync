import type { VaultBridgeSettings } from "../settings";
import { isIgnored, isSystemJunkFile } from "../utils/ignore";
import { isDotPathOutOfScope } from "../utils/path";
import { getEffectiveIgnorePatterns, getEffectiveSyncDotPaths, isOwnPluginDataPath } from "../config-sync";
import { INTERNAL_METADATA_PATH } from "../fs/remote-vault-contract";

/**
 * The sync-scope policy: whether a vault-relative path is excluded from sync on both
 * sides. Applied at change detection (`SyncOrchestrator.isExcluded`), so an excluded
 * path is never stat()'d, read, planned, or deleted. The scope-affecting inputs here
 * are exactly what `computeScopeFingerprint` hashes.
 */
export function isExcludedFromSync(
	path: string,
	settings: VaultBridgeSettings,
	configDir: string,
	pluginId: string,
): boolean {
	// The backend's own metadata file is reserved: never sync it from either
	// side, even when `.airsync` is opted into syncDotPaths. The remote FS also
	// hides it; excluding it here keeps the exclusion symmetric (otherwise a
	// local copy would be pushed, then deleted as a phantom remote deletion).
	if (path === INTERNAL_METADATA_PATH) return true;
	// Exclude conflict tracker index
	if (path === "sync-conflicts.md") return true;
	// This plugin's own settings file: safety-critical config must not
	// round-trip through sync/merge. Multi-device settings sync, if wanted, must
	// use a separate explicitly-synced file rather than the active config.
	if (isOwnPluginDataPath(path, configDir, pluginId)) return true;
	// OS-generated junk (desktop.ini, thumbs.db, .DS_Store) is never synced on any
	// backend — treated as non-existent like the reserved metadata path. Beyond
	// being noise, some backends (Dropbox) reject these outright, which would
	// otherwise fail every cycle and block the delta checkpoint.
	if (isSystemJunkFile(path)) return true;
	// A path syncs only if it passes BOTH gates: the dot-path scope
	// (hidden paths are in scope only when opted into syncDotPaths) AND
	// the user's ignore patterns.
	if (isDotPathOutOfScope(path, getEffectiveSyncDotPaths(settings, configDir))) return true;
	return isIgnored(path, getEffectiveIgnorePatterns(settings, configDir, pluginId));
}
