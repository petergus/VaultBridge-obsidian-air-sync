import "fake-indexeddb/auto";
import { describe, it, expect, vi } from "vitest";
import {
	isGoogleWorkspaceFile,
	googleWorkspaceUrl,
	buildWorkspaceStubContent,
	workspaceStubChecksum,
	GOOGLE_WORKSPACE_MIMES,
	FOLDER_MIME,
} from "./types";
import { GoogleDriveMetadataCache } from "./metadata-cache";
import type { GoogleDriveFile } from "./types";

vi.mock("obsidian");

describe("Google Workspace types & helpers", () => {
	const docFile: GoogleDriveFile = {
		id: "doc-123",
		name: "Meeting Notes",
		mimeType: "application/vnd.google-apps.document",
	};

	const sheetFile: GoogleDriveFile = {
		id: "sheet-456",
		name: "Budget 2026",
		mimeType: "application/vnd.google-apps.spreadsheet",
	};

	const slideFile: GoogleDriveFile = {
		id: "slide-789",
		name: "Pitch Deck",
		mimeType: "application/vnd.google-apps.presentation",
	};

	const folderFile: GoogleDriveFile = {
		id: "folder-001",
		name: "Documents",
		mimeType: FOLDER_MIME,
	};

	const binaryFile: GoogleDriveFile = {
		id: "bin-002",
		name: "image.png",
		mimeType: "image/png",
		size: "1024",
		md5Checksum: "abcdef1234567890",
	};

	describe("isGoogleWorkspaceFile", () => {
		it("returns true for all supported Workspace MIME types", () => {
			for (const mimeType of GOOGLE_WORKSPACE_MIMES.keys()) {
				expect(isGoogleWorkspaceFile({ id: "x", name: "x", mimeType })).toBe(true);
			}
		});

		it("returns false for folders", () => {
			expect(isGoogleWorkspaceFile(folderFile)).toBe(false);
		});

		it("returns false for binary/regular files", () => {
			expect(isGoogleWorkspaceFile(binaryFile)).toBe(false);
			expect(isGoogleWorkspaceFile({ id: "x", name: "x.md", mimeType: "text/markdown" })).toBe(false);
		});
	});

	describe("googleWorkspaceUrl", () => {
		it("constructs correct browser URL for Google Docs", () => {
			expect(googleWorkspaceUrl(docFile)).toBe(
				"https://docs.google.com/document/d/doc-123/edit"
			);
		});

		it("constructs correct browser URL for Google Sheets", () => {
			expect(googleWorkspaceUrl(sheetFile)).toBe(
				"https://docs.google.com/spreadsheets/d/sheet-456/edit"
			);
		});

		it("constructs correct browser URL for Google Slides", () => {
			expect(googleWorkspaceUrl(slideFile)).toBe(
				"https://docs.google.com/presentation/d/slide-789/edit"
			);
		});

		it("returns null for non-workspace files", () => {
			expect(googleWorkspaceUrl(folderFile)).toBeNull();
			expect(googleWorkspaceUrl(binaryFile)).toBeNull();
		});
	});

	describe("buildWorkspaceStubContent", () => {
		it("returns UTF-8 encoded Windows .url Internet Shortcut content", () => {
			const buf = buildWorkspaceStubContent(docFile);
			const text = new TextDecoder().decode(buf);
			expect(text).toBe(
				"[InternetShortcut]\r\nURL=https://docs.google.com/document/d/doc-123/edit\r\n"
			);
		});

		it("throws an error for non-workspace files", () => {
			expect(() => buildWorkspaceStubContent(binaryFile)).toThrow(
				"Not a Google Workspace file"
			);
		});
	});

	describe("workspaceStubChecksum", () => {
		it("returns an opaque checksum based on id and mimeType", () => {
			const checksum = workspaceStubChecksum(docFile);
			expect(checksum).toEqual({
				algo: "opaque",
				value: "workspace:doc-123:application/vnd.google-apps.document",
			});
		});
	});
});

describe("GoogleDriveMetadataCache workspace handling", () => {
	it("appends .url extension to workspace files during buildFromFiles", () => {
		const cache = new GoogleDriveMetadataCache("root");
		cache.buildFromFiles([
			{ id: "root", name: "Root", mimeType: FOLDER_MIME },
			{
				id: "folder1",
				name: "Work",
				mimeType: FOLDER_MIME,
				parents: ["root"],
			},
			{
				id: "doc1",
				name: "Project Brief",
				mimeType: "application/vnd.google-apps.document",
				parents: ["folder1"],
				modifiedTime: "2026-03-01T12:00:00.000Z",
			},
			{
				id: "file1",
				name: "notes.md",
				mimeType: "text/markdown",
				parents: ["folder1"],
				size: "500",
				md5Checksum: "md5hash123",
				modifiedTime: "2026-03-01T12:00:00.000Z",
			},
		]);

		// Path should include .url extension for workspace file
		expect(cache.getPathById("doc1")).toBe("Work/Project Brief.url");
		// Regular file retains original extension
		expect(cache.getPathById("file1")).toBe("Work/notes.md");
	});

	it("toEntity returns correct stub size, synthetic checksum, and googleWorkspace meta", () => {
		const cache = new GoogleDriveMetadataCache("root");
		const doc: GoogleDriveFile = {
			id: "doc1",
			name: "Project Brief",
			mimeType: "application/vnd.google-apps.document",
			parents: ["root"],
			modifiedTime: "2026-03-01T12:00:00.000Z",
		};
		cache.buildFromFiles([
			{ id: "root", name: "Root", mimeType: FOLDER_MIME },
			doc,
		]);

		const entity = cache.toEntity("Project Brief.url", doc);
		const expectedStub = buildWorkspaceStubContent(doc);

		expect(entity.path).toBe("Project Brief.url");
		expect(entity.isDirectory).toBe(false);
		expect(entity.size).toBe(expectedStub.byteLength);
		expect(entity.mtime).toBe(new Date("2026-03-01T12:00:00.000Z").getTime());
		expect(entity.remoteChecksum).toEqual({
			algo: "opaque",
			value: "workspace:doc1:application/vnd.google-apps.document",
		});
		expect(entity.backendMeta).toEqual({
			googleDriveId: "doc1",
			googleWorkspace: true,
		});
	});
});

describe("GoogleDriveFs.read workspace handling", () => {
	it("returns synthesized .url content for workspace files without calling downloadFile", async () => {
		const { GoogleDriveFs } = await import("./index");

		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([
				{ id: "root", name: "root", mimeType: FOLDER_MIME },
				{
					id: "sheet1",
					name: "Q1 Results",
					mimeType: "application/vnd.google-apps.spreadsheet",
					parents: ["root"],
				},
				{
					id: "file1",
					name: "readme.txt",
					mimeType: "text/plain",
					size: "12",
					parents: ["root"],
					md5Checksum: "abc",
				},
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
			downloadFile: vi.fn(),
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root");
		await fs.list(); // initialize cache

		const content = await fs.read("Q1 Results.url");
		const text = new TextDecoder().decode(content);

		expect(text).toBe(
			"[InternetShortcut]\r\nURL=https://docs.google.com/spreadsheets/d/sheet1/edit\r\n"
		);
		// Crucially, downloadFile must NOT have been called
		expect((mockClient as { downloadFile: ReturnType<typeof vi.fn> }).downloadFile).not.toHaveBeenCalled();
	});

	it("delegates to super.read for regular files", async () => {
		const { GoogleDriveFs } = await import("./index");

		const regularBuffer = new TextEncoder().encode("Hello World").buffer;
		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([
				{ id: "root", name: "root", mimeType: FOLDER_MIME },
				{
					id: "file1",
					name: "readme.txt",
					mimeType: "text/plain",
					size: "11",
					parents: ["root"],
					md5Checksum: "abc",
				},
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
			downloadFile: vi.fn().mockResolvedValue(regularBuffer),
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root");
		await fs.list();

		const content = await fs.read("readme.txt");
		expect(new TextDecoder().decode(content)).toBe("Hello World");
		expect((mockClient as { downloadFile: ReturnType<typeof vi.fn> }).downloadFile).toHaveBeenCalledWith("file1");
	});
});
