import { describe, it, expect } from "vitest";
import { classifyDropboxError } from "./errors";
import { DropboxApiError } from "./types";
import { AuthError } from "../errors";

describe("classifyDropboxError", () => {
	it("maps insufficient_space 409 → storageFull", () => {
		const err = new DropboxApiError("Dropbox API upload failed: 409 path/insufficient_space/.", 409, "path/insufficient_space/.");
		expect(classifyDropboxError(err).kind).toBe("storageFull");
	});

	it("maps to/insufficient_space → storageFull (move/copy variant)", () => {
		const err = new DropboxApiError("Dropbox API move failed: 409 to/insufficient_space/.", 409, "to/insufficient_space/.");
		expect(classifyDropboxError(err).kind).toBe("storageFull");
	});

	it("maps 507 → storageFull", () => {
		const err = new DropboxApiError("507 Insufficient Storage", 507, "");
		expect(classifyDropboxError(err).kind).toBe("storageFull");
	});

	it("maps no_write_permission → storageFull", () => {
		const err = new DropboxApiError("no_write_permission", 403, "no_write_permission/.");
		expect(classifyDropboxError(err).kind).toBe("storageFull");
	});

	it("passes 401 through to AuthError → auth", () => {
		expect(classifyDropboxError(new AuthError("expired", 401)).kind).toBe("auth");
	});

	it("passes 429 through as rateLimit", () => {
		const err = new DropboxApiError("too_many_requests", 429, "too_many_requests/..");
		expect(classifyDropboxError(err).kind).toBe("rateLimit");
	});

	it("passes path/not_found 409 through as transient (not storageFull)", () => {
		const err = new DropboxApiError("not found", 409, "path/not_found/.");
		expect(classifyDropboxError(err).kind).toBe("transient");
	});

	it("passes unknown errors through as transient", () => {
		expect(classifyDropboxError(new Error("network error")).kind).toBe("transient");
	});
});
