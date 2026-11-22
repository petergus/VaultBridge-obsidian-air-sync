import { AuthError } from "../fs/errors";

/** Stop queued actions on authentication failure and drain active work before returning. */
export class ExecutionControl {
	private authError: AuthError | undefined;

	async run<T>(task: () => Promise<T>): Promise<T> {
		if (this.authError) throw this.authError;
		try {
			return await task();
		} catch (err) {
			if (err instanceof AuthError) this.authError ??= err;
			throw err;
		}
	}

	async drain(tasks: Promise<unknown>[]): Promise<void> {
		// Promise.all rejects early and leaves sibling pools mutating after the
		// orchestrator releases its cycle lock. Every started task must settle first.
		const results = await Promise.allSettled(tasks);
		if (this.authError) throw this.authError;
		for (const result of results) {
			if (result.status === "rejected") throw result.reason;
		}
	}
}
