import type { ConflictStrategy } from "./sync/types";

export interface VaultBridgeSettings {
	/** Unique identifier for this vault (used as IndexedDB key) */
	vaultId: string;
	/** Selected backend type (e.g. "googledrive") */
	backendType: string;
	/** Strategy for conflict resolution */
	conflictStrategy: ConflictStrategy;
	/** Gitignore-style patterns to exclude from sync */
	ignorePatterns: string[];
	/** Enable 3-way merge for text files */
	enableThreeWayMerge: boolean;
	/** Dot-prefixed paths to include in sync (e.g. [".templates", ".stversions"]) */
	syncDotPaths: string[];
	/** Maximum file size in MB to sync on mobile */
	mobileMaxFileSizeMB: number;
	/**
	 * Minimum seconds between two resume-triggered remote re-checks. Returning to
	 * the app within this window is acknowledged but does not re-scan the remote —
	 * the battery-saver for mobile, where the app is foregrounded constantly. Local
	 * edits still sync immediately. `0` disables the throttle (re-check on every
	 * resume).
	 */
	foregroundSyncCooldownSec: number;
	/**
	 * Hold automatic sync while the device reports no network connection
	 * (`navigator.onLine === false`). Edits keep accumulating in the in-memory dirty
	 * set and flush automatically on the next `online` event — gating just avoids
	 * waking the radio for doomed network calls + retry backoff while offline. Manual
	 * "Sync now" is never gated. Default on.
	 */
	pauseSyncWhenOffline: boolean;
	/**
	 * Seconds to wait after the last local edit before syncing (the edit debounce). A
	 * longer window means fewer radio wakeups during active editing, at the cost of a
	 * little sync latency. Floored at 1 s in the wiring. Default 5.
	 */
	syncDebounceSec: number;
	/** Hold a screen wake lock while syncing so mobile devices don't sleep mid-sync */
	screenWakeLockOnSync: boolean;
	/** Show a notice summarizing each completed sync cycle (independent of logging) */
	showSyncNotifications: boolean;

	/** Write sync logs to .airsync/logs/{device}/{date}.log */
	enableLogging: boolean;
	/** Minimum log level to write */
	logLevel: "debug" | "info" | "warn" | "error";

	/**
	 * Parameters of the currently-selected backend ONLY (a single flat bag),
	 * not a per-type map. Switching backends clears this; an older per-type map
	 * is normalized on load (see `liftActiveBackendData`). Keeping only the active
	 * backend's params here means another backend's data can never structurally linger.
	 */
	backendData: Record<string, unknown>;

	/**
	 * Identity (`<type>:<remoteVaultFolderId>`) of the backend the sync-state store
	 * was last reconciled against. Persisted so a backend/target change made across
	 * a reload is detected on the next `initBackend` and the stale baselines are
	 * cleared — the state store is keyed by vaultId alone, so without this the new
	 * target would reuse the previous one's baselines. `""` until the first sync.
	 */
	lastSyncedIdentity: string;
}

export const DEFAULT_SETTINGS: VaultBridgeSettings = {
	vaultId: "",
	backendType: "googledrive",
	conflictStrategy: "auto_merge",
	ignorePatterns: [],
	syncDotPaths: [],
	enableThreeWayMerge: true,
	mobileMaxFileSizeMB: 10,
	foregroundSyncCooldownSec: 60,
	pauseSyncWhenOffline: true,
	syncDebounceSec: 5,
	screenWakeLockOnSync: false,
	showSyncNotifications: false,
	enableLogging: false,
	logLevel: "info",
	backendData: {},
	lastSyncedIdentity: "",
};



