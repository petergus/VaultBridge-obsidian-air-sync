import type { RemoteChecksum } from "../types";

/** Google Drive folder MIME type */
export const FOLDER_MIME = "application/vnd.google-apps.folder";

/**
 * Native Google Workspace metadata definitions.
 * These files live entirely in the cloud; `files.get?alt=media` returns 403.
 * They are saved locally as shortcut files (.gdoc, .gsheet, etc.) with a JSON
 * payload containing the browser edit URL, doc_id, and resource_id so plugins
 * like Obsidian GDocs can embed and render them.
 */
export interface GoogleWorkspaceMeta {
	readonly extension: string;
	readonly baseUrl: string;
	readonly urlSuffix: string;
	readonly resourceType: string;
}

export const GOOGLE_WORKSPACE_TYPES: ReadonlyMap<string, GoogleWorkspaceMeta> = new Map([
	["application/vnd.google-apps.document", {
		extension: "gdoc",
		baseUrl: "https://docs.google.com/document/d/",
		urlSuffix: "/edit",
		resourceType: "document",
	}],
	["application/vnd.google-apps.spreadsheet", {
		extension: "gsheet",
		baseUrl: "https://docs.google.com/spreadsheets/d/",
		urlSuffix: "/edit",
		resourceType: "spreadsheet",
	}],
	["application/vnd.google-apps.presentation", {
		extension: "gslides",
		baseUrl: "https://docs.google.com/presentation/d/",
		urlSuffix: "/edit",
		resourceType: "presentation",
	}],
	["application/vnd.google-apps.drawing", {
		extension: "gdraw",
		baseUrl: "https://docs.google.com/drawings/d/",
		urlSuffix: "/edit",
		resourceType: "drawing",
	}],
	["application/vnd.google-apps.form", {
		extension: "gform",
		baseUrl: "https://docs.google.com/forms/d/",
		urlSuffix: "/edit",
		resourceType: "form",
	}],
	["application/vnd.google-apps.site", {
		extension: "gsite",
		baseUrl: "https://sites.google.com/d/",
		urlSuffix: "/edit",
		resourceType: "site",
	}],
	["application/vnd.google-apps.jam", {
		extension: "gjam",
		baseUrl: "https://jamboard.google.com/d/",
		urlSuffix: "",
		resourceType: "jam",
	}],
	["application/vnd.google-apps.script", {
		extension: "gscript",
		baseUrl: "https://script.google.com/home/projects/",
		urlSuffix: "/edit",
		resourceType: "script",
	}],
]);

/** Backward-compatible map for MIME to base URL */
export const GOOGLE_WORKSPACE_MIMES: ReadonlyMap<string, string> = new Map(
	Array.from(GOOGLE_WORKSPACE_TYPES.entries()).map(([mime, meta]) => [mime, meta.baseUrl])
);

/** Returns true when the file is a cloud-native Google Workspace document (not a folder). */
export function isGoogleWorkspaceFile(file: GoogleDriveFile): boolean {
	return GOOGLE_WORKSPACE_TYPES.has(file.mimeType);
}

/** Returns the local shortcut file extension (e.g. "gdoc", "gsheet") or null for non-workspace files. */
export function googleWorkspaceExtension(file: GoogleDriveFile): string | null {
	return GOOGLE_WORKSPACE_TYPES.get(file.mimeType)?.extension ?? null;
}

/**
 * Build the browser-open URL for a Google Workspace file.
 * Returns `null` for non-workspace files.
 */
export function googleWorkspaceUrl(file: GoogleDriveFile): string | null {
	const meta = GOOGLE_WORKSPACE_TYPES.get(file.mimeType);
	if (!meta) return null;
	return `${meta.baseUrl}${file.id}${meta.urlSuffix}`;
}

/**
 * Generate the content of a Google Drive shortcut file (.gdoc, .gsheet, etc.)
 * for a Google Workspace file. The content is formatted as standard JSON
 * containing `url`, `doc_id`, and `resource_id`, which is recognized by Google Drive
 * desktop and parsed by the Obsidian GDocs plugin to embed the document.
 */
export function buildWorkspaceStubContent(file: GoogleDriveFile): ArrayBuffer {
	const meta = GOOGLE_WORKSPACE_TYPES.get(file.mimeType);
	if (!meta) throw new Error(`Not a Google Workspace file: ${file.mimeType}`);
	const url = `${meta.baseUrl}${file.id}${meta.urlSuffix}`;
	const payload = {
		url,
		doc_id: file.id,
		resource_id: `${meta.resourceType}:${file.id}`,
	};
	const text = JSON.stringify(payload, null, "\t") + "\n";
	return new TextEncoder().encode(text).buffer.slice(0);
}

/**
 * Derive a synthetic remote checksum for a Google Workspace file stub.
 * Content changes don't alter the stub (it's just a pointer), but the file's
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
