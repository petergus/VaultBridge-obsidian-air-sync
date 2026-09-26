import { describe, it, expect, vi, beforeEach } from "vitest";
import type { App, TAbstractFile } from "obsidian";
import { DirectDeleteConfirmModal } from "./direct-delete-modal";
import type { SyncOrchestrator } from "../sync/orchestrator";
import type { IFileSystem } from "../fs/interface";
import { __ui, Notice, TFile, TFolder } from "../__mocks__/obsidian";

describe("DirectDeleteConfirmModal", () => {
	beforeEach(() => {
		__ui.buttons = [];
		__ui.lastModal = null;
		Notice.lastNotice = null;
	});

	it("executes remote and local deletion on confirm for a file", async () => {
		const mockFile = new TFile("test-folder/note.md", 100, 1000);
		const remoteDeleteSpy = vi.fn().mockResolvedValue(undefined);
		const localVaultDeleteSpy = vi.fn().mockResolvedValue(undefined);
		const stateDeleteSpy = vi.fn().mockResolvedValue(undefined);
		const runSyncSpy = vi.fn().mockResolvedValue(undefined);
		const onDeletedSpy = vi.fn();

		const mockApp = {
			vault: {
				delete: localVaultDeleteSpy,
			},
		};

		const mockOrchestrator = {
			state: {
				delete: stateDeleteSpy,
			},
			runSync: runSyncSpy,
		};

		const mockRemoteFs = {
			delete: remoteDeleteSpy,
		};

		const modal = new DirectDeleteConfirmModal(mockApp as unknown as App, mockFile as unknown as TAbstractFile, {
			remoteFs: mockRemoteFs as unknown as IFileSystem,
			orchestrator: mockOrchestrator as unknown as SyncOrchestrator,
			displayName: "Google Drive",
			onDeleted: onDeletedSpy,
		});

		modal.open();

		// Click confirm button
		expect(__ui.buttons.length).toBe(2);
		await __ui.buttons[0]!.click();

		expect(remoteDeleteSpy).toHaveBeenCalledWith("test-folder/note.md");
		expect(stateDeleteSpy).toHaveBeenCalledWith("test-folder/note.md");
		expect(localVaultDeleteSpy).toHaveBeenCalledWith(mockFile, true);
		expect(onDeletedSpy).toHaveBeenCalledTimes(1);
		expect(Notice.lastNotice).toContain('Deleted "note.md" from the vault and Google Drive');
	});

	it("cleans up child sync records when deleting a folder", async () => {
		const mockFolder = new TFolder("test-folder");
		const remoteDeleteSpy = vi.fn().mockResolvedValue(undefined);
		const localVaultDeleteSpy = vi.fn().mockResolvedValue(undefined);
		const stateDeleteSpy = vi.fn().mockResolvedValue(undefined);
		const stateGetAllSpy = vi.fn().mockResolvedValue([
			{ path: "test-folder/sub/a.md" },
			{ path: "other-folder/b.md" },
			{ path: "test-folder" },
		]);

		const mockApp = {
			vault: {
				delete: localVaultDeleteSpy,
			},
		};

		const mockOrchestrator = {
			state: {
				getAll: stateGetAllSpy,
				delete: stateDeleteSpy,
			},
			runSync: vi.fn(),
		};

		const mockRemoteFs = {
			delete: remoteDeleteSpy,
		};

		const modal = new DirectDeleteConfirmModal(mockApp as unknown as App, mockFolder as unknown as TAbstractFile, {
			remoteFs: mockRemoteFs as unknown as IFileSystem,
			orchestrator: mockOrchestrator as unknown as SyncOrchestrator,
			displayName: "Google Drive",
		});

		modal.open();
		await __ui.buttons[0]!.click();

		expect(remoteDeleteSpy).toHaveBeenCalledWith("test-folder");
		expect(stateDeleteSpy).toHaveBeenCalledWith("test-folder/sub/a.md");
		expect(stateDeleteSpy).toHaveBeenCalledWith("test-folder");
		expect(stateDeleteSpy).not.toHaveBeenCalledWith("other-folder/b.md");
		expect(localVaultDeleteSpy).toHaveBeenCalledWith(mockFolder, true);
	});
});
