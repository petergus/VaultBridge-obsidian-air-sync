import { describe, it, expect, vi, beforeEach } from "vitest";
import { groupPendingDeletions, DeletionReviewModal, DirectDeleteConfirmModal } from "./deletion-modal";
import type { SyncAction } from "../sync/types";
import { __ui, Notice, TFile, TFolder } from "../__mocks__/obsidian";

describe("groupPendingDeletions", () => {
	it("groups paths by first two directory segments", () => {
		const actions: SyncAction[] = [
			{ path: "02-projects/Active-Projects/A/note1.md", action: "delete_remote" },
			{ path: "02-projects/Active-Projects/B/note2.md", action: "delete_remote" },
			{ path: "02-projects/active/note3.md", action: "delete_remote" },
			{ path: "standalone.md", action: "delete_remote" },
		];

		const groups = groupPendingDeletions(actions);
		expect(groups.get("02-projects/Active-Projects")).toBe(2);
		expect(groups.get("02-projects/active")).toBe(1);
		expect(groups.get("standalone.md")).toBe(1);
	});
});

describe("DeletionReviewModal", () => {
	beforeEach(() => {
		__ui.buttons = [];
		__ui.lastModal = null;
		Notice.lastNotice = null;
	});

	it("renders empty state when no deletions are pending", () => {
		const mockOrchestrator = {
			getPendingDeletions: vi.fn().mockReturnValue([]),
			approvePendingDeletions: vi.fn(),
		};

		const modal = new DeletionReviewModal({} as any, mockOrchestrator as any);
		modal.open();

		expect(__ui.buttons.length).toBe(1);
		expect(__ui.buttons[0]!.click).toBeDefined();
	});

	it("renders approval buttons and executes approval on click", async () => {
		const pendingActions: SyncAction[] = [
			{ path: "02-projects/Active-Projects/note.md", action: "delete_remote" },
		];

		const approveSpy = vi.fn().mockResolvedValue(undefined);
		const onApprovedSpy = vi.fn();
		const mockOrchestrator = {
			getPendingDeletions: vi.fn().mockReturnValue(pendingActions),
			approvePendingDeletions: approveSpy,
		};

		const modal = new DeletionReviewModal({} as any, mockOrchestrator as any, onApprovedSpy);
		modal.open();

		// Two buttons: Delete from Remote Storage and Decide Later
		expect(__ui.buttons.length).toBe(2);
		await __ui.buttons[0]!.click();

		expect(approveSpy).toHaveBeenCalledTimes(1);
		expect(onApprovedSpy).toHaveBeenCalledTimes(1);
		expect(Notice.lastNotice).toContain("Applying 1 deletions");
	});
});

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

		const modal = new DirectDeleteConfirmModal(mockApp as any, mockFile as any, {
			remoteFs: mockRemoteFs as any,
			orchestrator: mockOrchestrator as any,
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
		expect(Notice.lastNotice).toContain('Successfully deleted "note.md" from Vault and Google Drive');
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

		const modal = new DirectDeleteConfirmModal(mockApp as any, mockFolder as any, {
			remoteFs: mockRemoteFs as any,
			orchestrator: mockOrchestrator as any,
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
