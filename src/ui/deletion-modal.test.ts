import { describe, it, expect, vi, beforeEach } from "vitest";
import type { App } from "obsidian";
import { groupPendingDeletions, DeletionReviewModal } from "./deletion-modal";
import { VaultBridgeSettingTab } from "./settings";
import type VaultBridgePlugin from "../main";
import type { SyncOrchestrator } from "../sync/orchestrator";
import type { SyncAction } from "../sync/types";
import { __ui, Notice } from "../__mocks__/obsidian";
import type { FakeEl } from "../__mocks__/obsidian";

const app = {} as App;

/** The review modal only calls these two orchestrator methods. */
function reviewOrchestrator(
	pending: SyncAction[],
	approve: (actions?: readonly SyncAction[]) => Promise<void> = vi.fn(),
): SyncOrchestrator {
	return {
		getPendingDeletions: vi.fn().mockReturnValue(pending),
		approvePendingDeletions: approve,
	} as unknown as SyncOrchestrator;
}

/** The mocked `contentEl` is a FakeEl (see __mocks__/obsidian.ts). */
function contentOf(modal: DeletionReviewModal): FakeEl {
	return modal.contentEl as unknown as FakeEl;
}

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
		const modal = new DeletionReviewModal(app, reviewOrchestrator([]));
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
		const modal = new DeletionReviewModal(app, reviewOrchestrator(pendingActions, approveSpy), onApprovedSpy);
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
		const modal = new DeletionReviewModal(app, reviewOrchestrator(pendingActions, approveSpy));
		modal.open();

		// Content should include both server and local deletion details
		expect(contentOf(modal).children.length).toBeGreaterThan(0);

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
		const modal = new DeletionReviewModal(app, reviewOrchestrator(pendingActions, approveSpy));
		modal.open();

		// Click Server filter pill
		const serverPill = contentOf(modal)
			.querySelectorAll(".vaultbridge-filter-pill")
			.find((p) => p.text.startsWith("Server"));
		expect(serverPill).toBeDefined();
		__ui.buttons = [];
		serverPill!.trigger("click");

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
		const modal = new DeletionReviewModal(app, reviewOrchestrator(pendingActions, approveSpy));
		modal.open();

		const searchInput = contentOf(modal).querySelector(".vaultbridge-deletion-search-input");
		expect(searchInput).not.toBeNull();
		__ui.buttons = [];
		searchInput!.trigger("input", { target: { value: "my-note" } });

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

		const orchestrator = reviewOrchestrator(pendingActions);

		const writeTextMock = vi.fn().mockResolvedValue(undefined);
		Object.assign(navigator, {
			clipboard: { writeText: writeTextMock },
		});

		const modal = new DeletionReviewModal(app, orchestrator);
		modal.open();

		const copyBtn = contentOf(modal).querySelector(".vaultbridge-copy-btn");
		expect(copyBtn).not.toBeNull();
		copyBtn!.trigger("click");

		// Give promise a tick
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(writeTextMock).toHaveBeenCalledWith(
			"[Server] note1.md\n[Local] note2.md"
		);
		expect(Notice.lastNotice).toContain("Copied 2 file paths to clipboard");
	});
});

describe("VaultBridgeSettingTab - Held Deletions", () => {
	beforeEach(() => {
		__ui.buttons = [];
		__ui.lastModal = null;
		Notice.lastNotice = null;
	});

	it("renders held deletions alert in settings when deletions are pending", async () => {
		const pendingActions: SyncAction[] = [
			{ path: "remote1.md", action: "delete_remote" },
			{ path: "local1.md", action: "delete_local" },
		];

		const mockPlugin = {
			app: {
				vault: {
					configDir: ".cfg",
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

		const settingTab = new VaultBridgeSettingTab(
			{ vault: { configDir: ".cfg" } } as unknown as App,
			mockPlugin as unknown as VaultBridgePlugin,
		);
		settingTab.renderContent();

		// Buttons: Review deletions, Approve all, Sync now, Rescan
		const reviewBtn = __ui.buttons.find((b) => b.name === "Held deletions awaiting review");
		expect(reviewBtn).toBeDefined();

		// Click review deletions
		await reviewBtn!.click();
		expect(mockPlugin.openDeletionReviewModal).toHaveBeenCalledTimes(1);
	});
});
