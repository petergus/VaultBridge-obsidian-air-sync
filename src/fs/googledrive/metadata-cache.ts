import type { FileEntity } from "../types";
import type { GoogleDriveFile } from "./types";
import {
	FOLDER_MIME,
	toRemoteChecksum,
	isGoogleWorkspaceFile,
	workspaceStubChecksum,
	buildWorkspaceStubContent,
} from "./types";
import { AbstractMetadataCache } from "../caching/metadata-cache";

export type { FileChangeResult } from "../caching/metadata-cache";

/**
 * Google Drive's metadata cache. All the data structures and path/tree logic
 * live in {@link AbstractMetadataCache}; this subclass only reads Google Drive's file
 * shape (multi-parent `parents[]`, `mimeType` folders) and projects a
 * `FileEntity` with Google Drive's md5 checksum and `googleDriveId`.
 *
 * Google Workspace files (Docs, Sheets, Slides, …) are stored in the cache
 * with a `.url` extension appended to their name — the path key itself is
 * `"Meeting Notes.url"`, not `"Meeting Notes"`. This means stat/read/list all
 * see consistent `.url` paths without needing a path-translation layer.
 */
export class GoogleDriveMetadataCache extends AbstractMetadataCache<GoogleDriveFile> {
	protected extractId(file: GoogleDriveFile): string {
		return file.id;
	}

	protected extractParentIds(file: GoogleDriveFile): string[] {
		return file.parents ?? [];
	}

	/**
	 * The entry's own name. Google Workspace files get a `.url` suffix so the
	 * cache path matches the local stub filename (e.g. "Meeting Notes.url").
	 */
	protected extractName(file: GoogleDriveFile): string {
		if (isGoogleWorkspaceFile(file)) {
			return `${file.name}.url`;
		}
		return file.name;
	}

	protected isFolderEntry(file: GoogleDriveFile): boolean {
		return file.mimeType === FOLDER_MIME;
	}

	/**
	 * Build a FileEntity from cached GoogleDriveFile metadata (no download).
	 * hash is always "" because computing it would require downloading the
	 * file content. The sync engine uses remoteChecksum instead.
	 *
	 * Google Workspace files use a synthetic identity-based checksum (they have
	 * no md5 from the API) and their size is the stub content byte length.
	 * The path already has `.url` appended (see {@link extractName}).
	 */
	toEntity(path: string, googleDriveFile: GoogleDriveFile): FileEntity {
		if (this.isFolder(path)) {
			return { path, isDirectory: true, size: 0, mtime: 0, hash: "" };
		}

		const parsedMtime = googleDriveFile.modifiedTime
			? new Date(googleDriveFile.modifiedTime).getTime()
			: 0;

		// Google Workspace files → .url shortcut stubs
		if (isGoogleWorkspaceFile(googleDriveFile)) {
			const stubContent = buildWorkspaceStubContent(googleDriveFile);
			return {
				path,
				isDirectory: false,
				size: stubContent.byteLength,
				mtime: Number.isNaN(parsedMtime) ? 0 : parsedMtime,
				hash: "",
				remoteChecksum: workspaceStubChecksum(googleDriveFile),
				backendMeta: {
					googleDriveId: googleDriveFile.id,
					googleWorkspace: true,
				},
			};
		}

		return {
			path,
			isDirectory: false,
			size: parseInt(googleDriveFile.size || "0", 10),
			mtime: Number.isNaN(parsedMtime) ? 0 : parsedMtime,
			hash: "",
			remoteChecksum: toRemoteChecksum(googleDriveFile),
			backendMeta: { googleDriveId: googleDriveFile.id },
		};
	}
}
