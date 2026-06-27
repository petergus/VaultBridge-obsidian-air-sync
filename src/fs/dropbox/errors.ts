import { classifyHttpError } from "../errors";
import type { ErrorClassification } from "../errors";
import { DropboxApiError } from "./types";

/**
 * Classify a Dropbox error into a backend-neutral kind.
 *
 * The neutral HTTP classifier already handles 401 (auth), 404 (notFound), and 429
 * (rateLimit). On top of that, Dropbox uses a 409 status for several distinct endpoint
 * errors that the neutral classifier would misread as transient:
 * - `path/insufficient_space` → `storageFull` (abort; the account is over quota, retrying
 *   won't help until the user frees space or upgrades their plan).
 * - `to/insufficient_space` — same, from a move/copy operation.
 *
 * Dropbox also returns 507 from some endpoints for quota exhaustion; handled here too.
 */
export function classifyDropboxError(err: unknown): ErrorClassification {
	if (err instanceof DropboxApiError) {
		const s = err.summary;
		if (
			s.includes("insufficient_space") ||
			s.includes("no_write_permission") ||
			err.status === 507
		) {
			return { kind: "storageFull" };
		}
	}
	return classifyHttpError(err);
}
