import type { RemoteChecksum } from "../types";

/** Google Drive folder MIME type */
export const FOLDER_MIME = "application/vnd.google-apps.folder";

/**
 * Native Google Workspace MIME types that have no downloadable binary body.
 * These files live entirely in the cloud; `files.get?alt=media` returns 403.
 * The map value is the URL-base used to open the file in the browser.
 */
export const GOOGLE_WORKSPACE_MIMES: ReadonlyMap<string, string> = new Map([
	["application/vnd.google-apps.document", "https://docs.google.com/document/d/"],
	["application/vnd.google-apps.spreadsheet", "https://docs.google.com/spreadsheets/d/"],
	["application/vnd.google-apps.presentation", "https://docs.google.com/presentation/d/"],
	["application/vnd.google-apps.drawing", "https://docs.google.com/drawings/d/"],
	["application/vnd.google-apps.form", "https://docs.google.com/forms/d/"],
	["application/vnd.google-apps.site", "https://sites.google.com/d/"],
	["application/vnd.google-apps.jam", "https://jamboard.google.com/d/"],
]);

/** Returns true when the file is a cloud-native Google Workspace document (not a folder). */
export function isGoogleWorkspaceFile(file: GoogleDriveFile): boolean {
	return GOOGLE_WORKSPACE_MIMES.has(file.mimeType);
}

/**
 * Build the browser-open URL for a Google Workspace file.
 * Returns `null` for non-workspace files.
 */
export function googleWorkspaceUrl(file: GoogleDriveFile): string | null {
	const base = GOOGLE_WORKSPACE_MIMES.get(file.mimeType);
	if (!base) return null;
	return `${base}${file.id}/edit`;
}

/**
 * Generate the content of a `.url` Internet Shortcut stub file for a Google
 * Workspace file. Returns the content as a UTF-8 encoded ArrayBuffer so it can
 * be returned from `read()` / written by the sync engine as-is.
 */
export function buildWorkspaceStubContent(file: GoogleDriveFile): ArrayBuffer {
	const url = googleWorkspaceUrl(file);
	if (!url) throw new Error(`Not a Google Workspace file: ${file.mimeType}`);
	const text = `[InternetShortcut]\r\nURL=${url}\r\n`;
	return new TextEncoder().encode(text).buffer.slice(0);
}

/**
 * Derive a synthetic remote checksum for a Google Workspace file stub.
 * Content changes don't alter the stub (it's just a URL), but the file's
 * identity (id + mimeType) determines whether the stub needs to be created
 * or updated. Using `opaque` algo since this isn't reproducible from local
 * file content.
 */
export function workspaceStubChecksum(file: GoogleDriveFile): RemoteChecksum {
	return { algo: "opaque", value: `workspace:${file.id}:${file.mimeType}` };
}

/**
 * Hard cap on pagination drain loops (full list and changes.list). At pageSize
 * 1000 this is 10M entries — beyond any real vault — so reaching it means the
 * server isn't clearing its page token; we throw instead of looping forever.
 * Lives here (a leaf) so the client and the listing helper can both import it
 * without a cycle.
 */
export const LIST_PAGE_CAP = 10_000;

/**
 * Map a Google Drive file's md5Checksum to a typed RemoteChecksum.
 * Returns undefined when absent (e.g. Google Docs have no md5Checksum).
 */
export function toRemoteChecksum(file: GoogleDriveFile): RemoteChecksum | undefined {
	return file.md5Checksum ? { algo: "md5", value: file.md5Checksum } : undefined;
}

/** Google Drive file metadata from API response */
export interface GoogleDriveFile {
	id: string;
	name: string;
	mimeType: string;
	size?: string;
	modifiedTime?: string;
	parents?: string[];
	trashed?: boolean;
	md5Checksum?: string;
}

/** Response from files.list API */
export interface GoogleDriveFileList {
	files: GoogleDriveFile[];
	nextPageToken?: string;
}

/** A single change from changes.list */
export interface GoogleDriveChange {
	type: string;
	fileId: string;
	removed: boolean;
	file?: GoogleDriveFile;
}

/** Response from changes.list API */
export interface GoogleDriveChangeList {
	changes: GoogleDriveChange[];
	nextPageToken?: string;
	newStartPageToken?: string;
}

/** Build the metadata object for file upload requests */
export function buildUploadMetadata(
	name: string,
	parentId: string | undefined,
	modifiedTime: number,
	existingFileId: string | undefined,
): Record<string, unknown> {
	const metadata: Record<string, unknown> = { name };
	if (!existingFileId) {
		metadata.parents = [parentId];
	}
	metadata.modifiedTime = new Date(modifiedTime).toISOString();
	return metadata;
}

/** OAuth token response */
export interface TokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in: number;
	token_type: string;
}

/** Response from changes.getStartPageToken */
export interface StartPageTokenResponse {
	startPageToken: string;
}

/** Assert that obj is a valid TokenResponse (has required fields) */
export function assertTokenResponse(
	obj: unknown
): asserts obj is TokenResponse {
	if (
		!obj ||
		typeof obj !== "object" ||
		!("access_token" in obj) ||
		typeof (obj as Record<string, unknown>).access_token !== "string" ||
		!("expires_in" in obj) ||
		typeof (obj as Record<string, unknown>).expires_in !== "number"
	) {
		throw new Error("Invalid token response from server");
	}
}

/** Assert that obj is a valid GoogleDriveFile (has required id and name) */
export function assertGoogleDriveFile(obj: unknown): asserts obj is GoogleDriveFile {
	if (
		!obj ||
		typeof obj !== "object" ||
		!("id" in obj) ||
		typeof (obj as Record<string, unknown>).id !== "string" ||
		!("name" in obj) ||
		typeof (obj as Record<string, unknown>).name !== "string" ||
		!("mimeType" in obj) ||
		typeof (obj as Record<string, unknown>).mimeType !== "string"
	) {
		throw new Error("Invalid file metadata from Google Drive API");
	}
}

/** Assert that obj has a files array (GoogleDriveFileList response) */
export function assertGoogleDriveFileList(
	obj: unknown
): asserts obj is GoogleDriveFileList {
	if (
		!obj ||
		typeof obj !== "object" ||
		!("files" in obj) ||
		!Array.isArray((obj as Record<string, unknown>).files)
	) {
		throw new Error("Invalid file list response from Google Drive API");
	}
	for (const item of (obj as GoogleDriveFileList).files) {
		assertGoogleDriveFile(item);
	}
}

/** Assert that obj is a valid StartPageTokenResponse */
export function assertStartPageTokenResponse(
	obj: unknown
): asserts obj is StartPageTokenResponse {
	if (
		!obj ||
		typeof obj !== "object" ||
		!("startPageToken" in obj) ||
		typeof (obj as Record<string, unknown>).startPageToken !== "string"
	) {
		throw new Error("Invalid start page token response from Google Drive API");
	}
}

/** Assert that obj has a changes array (GoogleDriveChangeList response) */
export function assertGoogleDriveChangeList(
	obj: unknown
): asserts obj is GoogleDriveChangeList {
	if (
		!obj ||
		typeof obj !== "object" ||
		!("changes" in obj) ||
		!Array.isArray((obj as Record<string, unknown>).changes)
	) {
		throw new Error("Invalid change list response from Google Drive API");
	}
	for (const item of (obj as GoogleDriveChangeList).changes) {
		if (
			!item ||
			typeof item !== "object" ||
			typeof item.fileId !== "string" ||
			typeof item.removed !== "boolean" ||
			typeof item.type !== "string"
		) {
			throw new Error("Invalid change entry in Google Drive API response");
		}
		if (item.file) {
			assertGoogleDriveFile(item.file);
		}
	}
}
