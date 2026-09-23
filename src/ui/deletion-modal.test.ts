import { describe, it, expect, vi, beforeEach } from "vitest";
import { groupPendingDeletions, DeletionReviewModal, DirectDeleteConfirmModal } from "./deletion-modal";
import { VaultBridgeSettingTab } from "./settings";
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

		// Buttons: Approve all deletions and Decide later
		expect(__ui.buttons.length).toBe(2);
		await __ui.buttons[0]!.click();

		expect(approveSpy).toHaveBeenCalledTimes(1);
		expect(onApprovedSpy).toHaveBeenCalledTimes(1);
		expect(Notice.lastNotice).toContain("Applying 1 deletion");
	});

	it("supports reviewing both server and local deletions", async () => {
		const pendingActions: SyncAction[] = [
			{ path: "server-file.md", action: "delete_remote" },
			{ path: "local-file.md", action: "delete_local" },
		];

		const approveSpy = vi.fn().mockResolvedValue(undefined);
		const mockOrchestrator = {
			getPendingDeletions: vi.fn().mockReturnValue(pendingActions),
			approvePendingDeletions: approveSpy,
		};

		const modal = new DeletionReviewModal({} as any, mockOrchestrator as any);
		modal.open();

		// Content should include both server and local deletion details
		const contentEl = modal.contentEl as any;
		expect(contentEl.children.length).toBeGreaterThan(0);

		// Trigger approve
		expect(__ui.buttons.length).toBe(2);
		await __ui.buttons[0]!.click();
		expect(approveSpy).toHaveBeenCalledWith(pendingActions);
	});

	it("filters server deletions and allows selective approval", async () => {
		const pendingActions: SyncAction[] = [
			{ path: "server1.md", action: "delete_remote" },
			{ path: "server2.md", action: "delete_remote" },
			{ path: "local1.md", action: "delete_local" },
		];

		const approveSpy = vi.fn().mockResolvedValue(undefined);
		const mockOrchestrator = {
			getPendingDeletions: vi.fn().mockReturnValue(pendingActions),
			approvePendingDeletions: approveSpy,
		};

		const modal = new DeletionReviewModal({} as any, mockOrchestrator as any);
		modal.open();

		// Click Server filter pill
		const serverPill = (modal as any).pillElements.find((p: any) =>
			(p.text || "").startsWith("Server")
		);
		expect(serverPill).toBeDefined();
		__ui.buttons = [];
		serverPill.trigger("click");

		// When filtered to Server deletions (2 items out of 3), approve displayed and approve all should be rendered
		expect(__ui.buttons.length).toBe(3);
		await __ui.buttons[0]!.click();

		// Should approve only the 2 server deletions
		expect(approveSpy).toHaveBeenCalledWith([
			{ path: "server1.md", action: "delete_remote" },
			{ path: "server2.md", action: "delete_remote" },
		]);
	});

	it("filters by search query", async () => {
		const pendingActions: SyncAction[] = [
			{ path: "02-projects/my-note.md", action: "delete_remote" },
			{ path: "05-sources/archive.pdf", action: "delete_remote" },
		];

		const approveSpy = vi.fn().mockResolvedValue(undefined);
		const mockOrchestrator = {
			getPendingDeletions: vi.fn().mockReturnValue(pendingActions),
			approvePendingDeletions: approveSpy,
		};

		const modal = new DeletionReviewModal({} as any, mockOrchestrator as any);
		modal.open();

		const searchInput = modal.contentEl.querySelector(".vaultbridge-deletion-search-input") as any;
		expect(searchInput).toBeDefined();
		__ui.buttons = [];
		searchInput.trigger("input", { target: { value: "my-note" } });

		// Filtered down to 1 item
		expect(__ui.buttons.length).toBe(3);
		await __ui.buttons[0]!.click();
		expect(approveSpy).toHaveBeenCalledWith([
			{ path: "02-projects/my-note.md", action: "delete_remote" },
		]);
	});

	it("copies file paths to clipboard", async () => {
		const pendingActions: SyncAction[] = [
			{ path: "note1.md", action: "delete_remote" },
			{ path: "note2.md", action: "delete_local" },
		];

		const mockOrchestrator = {
			getPendingDeletions: vi.fn().mockReturnValue(pendingActions),
			approvePendingDeletions: vi.fn(),
		};

		const writeTextMock = vi.fn().mockResolvedValue(undefined);
		Object.assign(navigator, {
			clipboard: { writeText: writeTextMock },
		});

		const modal = new DeletionReviewModal({} as any, mockOrchestrator as any);
		modal.open();

		const copyBtn = modal.contentEl.querySelector(".vaultbridge-copy-btn") as any;
		expect(copyBtn).toBeDefined();
		copyBtn.trigger("click");

		// Give promise a tick
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(writeTextMock).toHaveBeenCalledWith(
			"[Server] note1.md\n[Local] note2.md"
		);
		expect(Notice.lastNotice).toContain("Copied 2 file paths to clipboard");
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

describe("VaultBridgeSettingTab - Held Deletions", () => {
	beforeEach(() => {
		__ui.buttons = [];
		__ui.lastModal = null;
		Notice.lastNotice = null;
	});

	it("renders held deletions alert in settings when deletions are pending", () => {
		const pendingActions: SyncAction[] = [
			{ path: "remote1.md", action: "delete_remote" },
			{ path: "local1.md", action: "delete_local" },
		];

		const mockPlugin = {
			app: {
				vault: {
					configDir: ".obsidian",
				},
			},
			orchestrator: {
				getPendingDeletions: vi.fn().mockReturnValue(pendingActions),
				approvePendingDeletions: vi.fn().mockResolvedValue(undefined),
			},
			conflictTracker: {
				getTrackedPaths: vi.fn().mockResolvedValue(new Set()),
			},
			backendManager: {
				getBackendProvider: vi.fn().mockReturnValue(null),
			},
			settings: {
				conflictStrategy: "auto_merge",
				backendType: "googledrive",
				maxDeletionsPerSync: 20,
				syncDotPaths: [],
				enableLogging: false,
				logLevel: "info",
				backendData: {},
				syncDebounceSec: 5,
				foregroundSyncCooldownSec: 0,
				pauseSyncWhenOffline: true,
				screenWakeLockOnSync: true,
				showSyncNotifications: true,
				enableConfigSync: false,
				syncConfigJsonFiles: false,
				syncConfigPlugins: false,
				syncConfigSnippets: false,
				syncConfigThemes: false,
				syncConfigIcons: false,
				mobileMaxFileSizeMB: 10,
			},
			openDeletionReviewModal: vi.fn(),
		};

		const settingTab = new VaultBridgeSettingTab({ vault: { configDir: ".obsidian" } } as any, mockPlugin as any);
		settingTab.renderContent();

		// Buttons: Review deletions, Approve all, Sync now, Rescan
		const reviewBtn = __ui.buttons.find((b) => b.name === "Held deletions awaiting review");
		expect(reviewBtn).toBeDefined();

		// Click review deletions
		reviewBtn!.click();
		expect(mockPlugin.openDeletionReviewModal).toHaveBeenCalledTimes(1);
	});
});
