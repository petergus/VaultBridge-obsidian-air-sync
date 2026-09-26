import type { ErrorClassification } from "../fs/errors";
import type { ExecutionResult, FailedAction } from "./plan-executor";
import type { SyncAction, SyncActionType } from "./types";

interface FailedActionEntry {
	key: string;
	actionFingerprint: string;
	consecutiveFailures: number;
	blockedUntil: number;
}

const FAILED_ACTION_BLOCK_THRESHOLD = 2;
const FAILED_ACTION_BLOCK_TTL_MS = 5 * 60 * 1000;
const BLOCKABLE_LOCAL_ORIGIN_ACTIONS = new Set<SyncActionType>(["push", "delete_remote", "rename_remote"]);

/**
 * Quarantine for local-origin actions (push / delete_remote / rename_remote) that keep
 * failing with the same PERMANENT error (e.g. a backend rejecting a file name). After
 * {@link FAILED_ACTION_BLOCK_THRESHOLD} identical failures the action is blocked for
 * {@link FAILED_ACTION_BLOCK_TTL_MS}, so one poison file can't fail — and force a cold
 * reconcile — every cycle. A changed action (new content/metadata) is a new attempt.
 */
export class FailedActionTracker {
	private readonly entries = new Map<string, FailedActionEntry>();

	isBlocked(backendType: string, action: SyncAction, now = Date.now()): string | null {
		if (!isBlockableLocalOriginAction(action)) return null;
		this.expire(now);
		const prefix = this.actionPrefix(backendType, action);
		const fingerprint = actionFingerprint(action);
		for (const entry of this.entries.values()) {
			if (!entry.key.startsWith(prefix)) continue;
			if (entry.actionFingerprint !== fingerprint) {
				this.entries.delete(entry.key);
				continue;
			}
			if (entry.blockedUntil > now) {
				return `blocked after ${entry.consecutiveFailures} repeated failures; retry after ${new Date(entry.blockedUntil).toISOString()}`;
			}
		}
		return null;
	}

	recordSuccess(backendType: string, action: SyncAction): void {
		this.clearAction(backendType, action);
	}

	recordFailure(
		backendType: string,
		failed: FailedAction,
		classification: ErrorClassification,
		now = Date.now(),
	): void {
		if (!isBlockableLocalOriginAction(failed.action)) return;
		this.expire(now);
		const failureCode = quarantineFailureCode(classification);
		if (!failureCode) {
			this.clearAction(backendType, failed.action);
			return;
		}
		const key = this.key(backendType, failed.action, failureCode);
		const fingerprint = actionFingerprint(failed.action);
		const existing = this.entries.get(key);
		const consecutiveFailures = existing?.actionFingerprint === fingerprint
			? existing.consecutiveFailures + 1
			: 1;
		this.clearAction(backendType, failed.action);
		this.entries.set(key, {
			key,
			actionFingerprint: fingerprint,
			consecutiveFailures,
			blockedUntil: consecutiveFailures >= FAILED_ACTION_BLOCK_THRESHOLD
				? now + FAILED_ACTION_BLOCK_TTL_MS
				: 0,
		});
	}

	isBlockingFailure(
		backendType: string,
		failed: FailedAction,
		classification: ErrorClassification,
		now = Date.now(),
	): boolean {
		if (!isBlockableLocalOriginAction(failed.action)) return false;
		const failureCode = quarantineFailureCode(classification);
		if (!failureCode) return false;
		const entry = this.entries.get(this.key(backendType, failed.action, failureCode));
		return !!entry && entry.actionFingerprint === actionFingerprint(failed.action) && entry.blockedUntil > now;
	}

	/** Record a finished cycle: successes clear their entries, failures count toward a block. */
	recordCycle(
		backendType: string,
		result: ExecutionResult,
		classifyError: (err: unknown) => ErrorClassification,
	): void {
		for (const succeeded of result.succeeded) {
			this.recordSuccess(backendType, succeeded.action);
		}
		for (const failed of result.failed) {
			this.recordFailure(backendType, failed, classifyError(failed.error));
		}
	}

	/**
	 * A failed cycle forces the next one cold — unless every failure is an action this
	 * tracker is already blocking (re-scanning cannot fix a quarantined poison file).
	 */
	needsColdRecovery(
		backendType: string,
		result: ExecutionResult,
		classifyError: (err: unknown) => ErrorClassification,
	): boolean {
		return result.failed.some((failed) =>
			!this.isBlockingFailure(backendType, failed, classifyError(failed.error)),
		);
	}

	private expire(now: number): void {
		for (const [key, entry] of this.entries) {
			if (entry.blockedUntil > 0 && entry.blockedUntil <= now) this.entries.delete(key);
		}
	}

	private actionPrefix(backendType: string, action: SyncAction): string {
		return `${backendType}\u0000${action.action}\u0000${action.path}\u0000`;
	}

	private clearAction(backendType: string, action: SyncAction): void {
		const prefix = this.actionPrefix(backendType, action);
		for (const key of [...this.entries.keys()]) {
			if (key.startsWith(prefix)) this.entries.delete(key);
		}
	}

	private key(backendType: string, action: SyncAction, failureCode: string): string {
		return `${this.actionPrefix(backendType, action)}permanent\u0000${failureCode}`;
	}
}

function isBlockableLocalOriginAction(action: SyncAction): boolean {
	return BLOCKABLE_LOCAL_ORIGIN_ACTIONS.has(action.action);
}

function quarantineFailureCode(classification: ErrorClassification): string | null {
	return classification.kind === "permanent" && classification.permanentCode
		? classification.permanentCode
		: null;
}

function actionFingerprint(action: SyncAction): string {
	return JSON.stringify({
		action: action.action,
		path: action.path,
		oldPath: "oldPath" in action ? action.oldPath : undefined,
		local: entityFingerprint(action.local),
		remote: entityFingerprint(action.remote),
		baseline: action.baseline
			? {
				hash: action.baseline.hash,
				localMtime: action.baseline.localMtime,
				remoteMtime: action.baseline.remoteMtime,
				localSize: action.baseline.localSize,
				remoteSize: action.baseline.remoteSize,
			}
			: undefined,
	});
}

function entityFingerprint(entity: SyncAction["local"]): unknown {
	if (!entity) return undefined;
	return {
		isDirectory: entity.isDirectory,
		size: entity.size,
		mtime: entity.mtime,
		hash: entity.hash,
	};
}
