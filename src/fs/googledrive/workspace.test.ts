import "fake-indexeddb/auto";
import { describe, it, expect, vi } from "vitest";
import {
	isGoogleWorkspaceFile,
	googleWorkspaceExtension,
	googleWorkspaceUrl,
	buildWorkspaceStubContent,
	workspaceStubChecksum,
	GOOGLE_WORKSPACE_TYPES,
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
			for (const mimeType of GOOGLE_WORKSPACE_TYPES.keys()) {
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

	describe("googleWorkspaceExtension", () => {
		it("returns expected shortcut extension for each Workspace MIME type", () => {
			expect(googleWorkspaceExtension(docFile)).toBe("gdoc");
			expect(googleWorkspaceExtension(sheetFile)).toBe("gsheet");
			expect(googleWorkspaceExtension(slideFile)).toBe("gslides");
			expect(googleWorkspaceExtension({ id: "x", name: "x", mimeType: "application/vnd.google-apps.drawing" })).toBe("gdraw");
			expect(googleWorkspaceExtension({ id: "x", name: "x", mimeType: "application/vnd.google-apps.form" })).toBe("gform");
			expect(googleWorkspaceExtension({ id: "x", name: "x", mimeType: "application/vnd.google-apps.jam" })).toBe("gjam");
			expect(googleWorkspaceExtension({ id: "x", name: "x", mimeType: "application/vnd.google-apps.script" })).toBe("gscript");
			expect(googleWorkspaceExtension({ id: "x", name: "x", mimeType: "application/vnd.google-apps.site" })).toBe("gsite");
		});

		it("returns null for non-workspace files", () => {
			expect(googleWorkspaceExtension(folderFile)).toBeNull();
			expect(googleWorkspaceExtension(binaryFile)).toBeNull();
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
		it("returns UTF-8 encoded JSON shortcut content compatible with Obsidian GDocs plugin", () => {
			const buf = buildWorkspaceStubContent(docFile);
			const text = new TextDecoder().decode(buf);
			const parsed = JSON.parse(text);

			expect(parsed).toEqual({
				url: "https://docs.google.com/document/d/doc-123/edit",
				doc_id: "doc-123",
				resource_id: "document:doc-123",
			});
		});

		it("returns correct JSON shortcut content for Google Sheets", () => {
			const buf = buildWorkspaceStubContent(sheetFile);
			const parsed = JSON.parse(new TextDecoder().decode(buf));

			expect(parsed).toEqual({
				url: "https://docs.google.com/spreadsheets/d/sheet-456/edit",
				doc_id: "sheet-456",
				resource_id: "spreadsheet:sheet-456",
			});
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
	it("appends native extensions (.gdoc, .gsheet) to workspace files during buildFromFiles", () => {
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
				id: "sheet1",
				name: "Finances.gsheet",
				mimeType: "application/vnd.google-apps.spreadsheet",
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

		// Path should include .gdoc extension for workspace file
		expect(cache.getPathById("doc1")).toBe("Work/Project Brief.gdoc");
		// Should not duplicate extension if already present
		expect(cache.getPathById("sheet1")).toBe("Work/Finances.gsheet");
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

		const entity = cache.toEntity("Project Brief.gdoc", doc);
		const expectedStub = buildWorkspaceStubContent(doc);

		expect(entity.path).toBe("Project Brief.gdoc");
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

describe("GoogleDriveFs workspace operations", () => {
	it("returns synthesized .gsheet JSON content for workspace files without calling downloadFile", async () => {
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

		const content = await fs.read("Q1 Results.gsheet");
		const parsed = JSON.parse(new TextDecoder().decode(content));

		expect(parsed).toEqual({
			url: "https://docs.google.com/spreadsheets/d/sheet1/edit",
			doc_id: "sheet1",
			resource_id: "spreadsheet:sheet1",
		});
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

	it("strips workspace extension (.gdoc) on rename before updating remote Google Drive metadata", async () => {
		const { GoogleDriveFs } = await import("./index");

		const updateFileMetadata = vi.fn().mockResolvedValue({
			id: "doc1",
			name: "New Strategy",
			mimeType: "application/vnd.google-apps.document",
			parents: ["root"],
		});

		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([
				{ id: "root", name: "root", mimeType: FOLDER_MIME },
				{
					id: "doc1",
					name: "Old Strategy",
					mimeType: "application/vnd.google-apps.document",
					parents: ["root"],
				},
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
			updateFileMetadata,
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root");
		await fs.list();

		await fs.rename("Old Strategy.gdoc", "New Strategy.gdoc");

		expect(updateFileMetadata).toHaveBeenCalledWith(
			"doc1",
			{ name: "New Strategy" },
			undefined,
			undefined
		);
	});

	it("refuses to overwrite existing workspace document via write()", async () => {
		const { GoogleDriveFs } = await import("./index");

		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([
				{ id: "root", name: "root", mimeType: FOLDER_MIME },
				{
					id: "doc1",
					name: "Document",
					mimeType: "application/vnd.google-apps.document",
					parents: ["root"],
				},
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root");
		await fs.list();

		await expect(
			fs.write("Document.gdoc", new ArrayBuffer(10), Date.now())
		).rejects.toThrow("Cannot write directly to Google Workspace document");
	});

	it("skips remote deletion for workspace documents to protect cloud docs", async () => {
		const { GoogleDriveFs } = await import("./index");

		const deleteFile = vi.fn();
		const mockClient = {
			listAllFiles: vi.fn().mockResolvedValue([
				{ id: "root", name: "root", mimeType: FOLDER_MIME },
				{
					id: "doc1",
					name: "Critical Notes",
					mimeType: "application/vnd.google-apps.document",
					parents: ["root"],
				},
				{
					id: "file1",
					name: "temp.txt",
					mimeType: "text/plain",
					size: "10",
					parents: ["root"],
					md5Checksum: "123",
				},
			]),
			getChangesStartToken: vi.fn().mockResolvedValue("token1"),
			deleteFile,
		} as never;

		const fs = new GoogleDriveFs(mockClient, "root");
		await fs.list();

		// Deleting a workspace document should be a no-op on Google Drive
		await fs.delete("Critical Notes.gdoc");
		expect(deleteFile).not.toHaveBeenCalled();

		// Deleting a regular file should call deleteFile
		await fs.delete("temp.txt");
		expect(deleteFile).toHaveBeenCalledWith("file1");
	});
});

