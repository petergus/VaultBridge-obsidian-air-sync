import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import type { App, MarkdownView, MenuItem, TAbstractFile } from "obsidian";
import { Menu, Notice } from "obsidian";
import { registerContextMenuHandlers } from "./context-menu";
import { DirectDeleteConfirmModal } from "./direct-delete-modal";
import type { BackendManager } from "../fs/backend-manager";
import type { IBackendProvider } from "../fs/backend";
import type { IFileSystem } from "../fs/interface";
import type { SyncOrchestrator } from "../sync/orchestrator";
import { __ui, MenuItem as FakeMenuItem } from "../__mocks__/obsidian";

vi.mock("obsidian");

interface TestMenuItem {
	title: string;
	icon: string;
	callback: ((evt?: unknown) => unknown) | null;
}

function getMenuItems(menu: Menu): TestMenuItem[] {
	// The mocked Menu (see __mocks__/obsidian.ts) records its items.
	return (menu as unknown as { items?: TestMenuItem[] }).items ?? [];
}

function createMockMenuItem(): MenuItem & TestMenuItem {
	return new FakeMenuItem() as unknown as MenuItem & TestMenuItem;
}

/** The slice of Notebook Navigator's menu API the integration calls back with. */
type NnMenuCallback = (ctx: {
	addItem: (cb: (item: MenuItem) => void) => void;
	file?: TAbstractFile;
	folder?: TAbstractFile;
	selection?: { mode: string; files: TAbstractFile[] };
}) => void;

/** Read Menu.prototype.showAtMouseEvent as a value, to check it is patched and restored. */
function currentShowAtMouseEvent(): unknown {
	return Reflect.get(Menu.prototype, "showAtMouseEvent");
}

/** The delete hooks only need the orchestrator to exist. */
const deleteOrchestrator = {
	state: { delete: vi.fn() },
	runSync: vi.fn(),
} as unknown as SyncOrchestrator;

describe("registerContextMenuHandlers", () => {
	let mockApp: App;
	let mockBackendManager: BackendManager;
	let mockGetBackendProvider: ReturnType<typeof vi.fn>;
	let mockGetRemoteFs: ReturnType<typeof vi.fn>;
	let registeredEvents: ((...args: unknown[]) => unknown)[];
	let workspaceEventHandlers: Record<string, (...args: unknown[]) => unknown>;
	let cleanupCallbacks: (() => void)[];
	let domEventHandlers: Record<string, (evt: MouseEvent) => void>;
	let mockWindowOpen: ReturnType<typeof vi.fn>;
	let mockFilesByPath: Record<string, TAbstractFile>;
	let mockNnPlugin: {
		api: {
			menus: {
				registerFileMenu: Mock<(cb: NnMenuCallback) => void>;
				registerFolderMenu: Mock<(cb: NnMenuCallback) => void>;
			};
		};
	};

	beforeEach(() => {
		vi.clearAllMocks();
		registeredEvents = [];
		workspaceEventHandlers = {};
		cleanupCallbacks = [];
		domEventHandlers = {};
		mockFilesByPath = {};

		mockWindowOpen = vi.fn();
		vi.stubGlobal("window", { open: mockWindowOpen });

		mockNnPlugin = {
			api: {
				menus: {
					registerFileMenu: vi.fn<(cb: NnMenuCallback) => void>(),
					registerFolderMenu: vi.fn<(cb: NnMenuCallback) => void>(),
				},
			},
		};

		mockApp = {
			vault: {
				getName: () => "TestVault",
				getRoot: () => ({ path: "/", name: "TestVault" }) as TAbstractFile,
				getAbstractFileByPath: (p: string) => mockFilesByPath[p] ?? null,
			},
			workspace: {
				on: (name: string, callback: (...args: unknown[]) => unknown) => {
					workspaceEventHandlers[name] = callback;
					return { name, callback } as never;
				},
				onLayoutReady: (callback: () => unknown) => {
					callback();
				},
				offref: vi.fn(),
			},
			plugins: {
				plugins: {
					"notebook-navigator": mockNnPlugin,
				},
			},
		} as unknown as App;

		mockGetBackendProvider = vi.fn();
		mockGetRemoteFs = vi.fn();
		mockBackendManager = {
			getBackendProvider: mockGetBackendProvider,
			getRemoteFs: mockGetRemoteFs,
		} as unknown as BackendManager;
	});

	function registerHandlers() {
		registerContextMenuHandlers({
			app: mockApp,
			backendManager: mockBackendManager,
			registerEvent: (ref) => registeredEvents.push(ref as never),
			registerDomEvent: (_el, type, cb) => {
				domEventHandlers[type] = cb;
			},
			registerCleanup: (cb) => cleanupCallbacks.push(cb),
		});
	}

	it("registers file-menu, files-menu, and editor-menu workspace events", () => {
		registerHandlers();

		expect(registeredEvents.length).toBe(3);
		expect(workspaceEventHandlers["file-menu"]).toBeDefined();
		expect(workspaceEventHandlers["files-menu"]).toBeDefined();
		expect(workspaceEventHandlers["editor-menu"]).toBeDefined();
	});

	it("does not add a menu item if no backend provider is configured", () => {
		registerHandlers();
		mockGetBackendProvider.mockReturnValue(null);

		const menu = new Menu();
		const mockFile = { path: "note.md", name: "note.md" } as TAbstractFile;

		workspaceEventHandlers["file-menu"]!(menu, mockFile);

		expect(getMenuItems(menu).length).toBe(0);
	});

	it("does not add a menu item if the remote FS lacks getWebUrl", () => {
		registerHandlers();
		mockGetBackendProvider.mockReturnValue({
			displayName: "Google Drive",
		} as IBackendProvider);
		mockGetRemoteFs.mockReturnValue({} as IFileSystem);

		const menu = new Menu();
		const mockFile = { path: "note.md", name: "note.md" } as TAbstractFile;

		workspaceEventHandlers["file-menu"]!(menu, mockFile);

		expect(getMenuItems(menu).length).toBe(0);
	});

	it("adds menu item with clean title and icon for Google Drive custom OAuth", () => {
		registerHandlers();
		mockGetBackendProvider.mockReturnValue({
			displayName: "Google Drive (custom OAuth)",
		} as IBackendProvider);
		const mockFs = { getWebUrl: vi.fn() } as unknown as IFileSystem;
		mockGetRemoteFs.mockReturnValue(mockFs);

		const menu = new Menu();
		const mockFile = { path: "Projects/doc.md", name: "doc.md" } as TAbstractFile;

		workspaceEventHandlers["file-menu"]!(menu, mockFile);

		const items = getMenuItems(menu);
		expect(items.length).toBe(1);
		expect(items[0]!.title).toBe("Open in Google Drive");
		expect(items[0]!.icon).toBe("external-link");
	});

	it("handles files-menu event when a single file is selected", () => {
		registerHandlers();
		mockGetBackendProvider.mockReturnValue({
			displayName: "Google Drive",
		} as IBackendProvider);
		const mockFs = { getWebUrl: vi.fn() } as unknown as IFileSystem;
		mockGetRemoteFs.mockReturnValue(mockFs);

		const menu = new Menu();
		const mockFile = { path: "Projects/doc.md", name: "doc.md" } as TAbstractFile;

		workspaceEventHandlers["files-menu"]!(menu, [mockFile]);

		const items = getMenuItems(menu);
		expect(items.length).toBe(1);
		expect(items[0]!.title).toBe("Open in Google Drive");
	});

	it("handles files-menu event when multiple files are selected", () => {
		registerHandlers();
		mockGetBackendProvider.mockReturnValue({
			displayName: "Google Drive",
		} as IBackendProvider);
		const mockFs = { getWebUrl: vi.fn() } as unknown as IFileSystem;
		mockGetRemoteFs.mockReturnValue(mockFs);

		const menu = new Menu();
		const mockFile1 = { path: "Projects/doc1.md", name: "doc1.md" } as TAbstractFile;
		const mockFile2 = { path: "Projects/doc2.md", name: "doc2.md" } as TAbstractFile;

		workspaceEventHandlers["files-menu"]!(menu, [mockFile1, mockFile2]);

		const items = getMenuItems(menu);
		expect(items.length).toBe(1);
		expect(items[0]!.title).toBe("Open 2 items in Google Drive");
	});

	it("opens web URL when clicked and URL is available", async () => {
		registerHandlers();
		mockGetBackendProvider.mockReturnValue({
			displayName: "Google Drive",
		} as IBackendProvider);
		const mockGetWebUrl = vi.fn().mockResolvedValue("https://drive.google.com/file/d/123/view");
		const mockFs = { getWebUrl: mockGetWebUrl } as unknown as IFileSystem;
		mockGetRemoteFs.mockReturnValue(mockFs);

		const menu = new Menu();
		const mockFile = { path: "Projects/doc.md", name: "doc.md" } as TAbstractFile;

		workspaceEventHandlers["file-menu"]!(menu, mockFile);

		const items = getMenuItems(menu);
		expect(items.length).toBe(1);
		await items[0]!.callback!();

		expect(mockGetWebUrl).toHaveBeenCalledWith("Projects/doc.md");
		expect(mockWindowOpen).toHaveBeenCalledWith("https://drive.google.com/file/d/123/view");
	});

	it("shows a notice when file is not yet synced to Google Drive", async () => {
		registerHandlers();
		mockGetBackendProvider.mockReturnValue({
			displayName: "Google Drive",
		} as IBackendProvider);
		const mockGetWebUrl = vi.fn().mockResolvedValue(null);
		const mockFs = { getWebUrl: mockGetWebUrl } as unknown as IFileSystem;
		mockGetRemoteFs.mockReturnValue(mockFs);

		const menu = new Menu();
		const mockFile = { path: "new-note.md", name: "new-note.md" } as TAbstractFile;

		workspaceEventHandlers["file-menu"]!(menu, mockFile);

		const items = getMenuItems(menu);
		await items[0]!.callback!();

		expect(mockWindowOpen).not.toHaveBeenCalled();
		expect((Notice as unknown as { lastNotice: string }).lastNotice).toBe('"new-note.md" is not yet synced to Google Drive');
	});

	it("handles editor-menu event when active file is present", async () => {
		registerHandlers();
		mockGetBackendProvider.mockReturnValue({
			displayName: "Google Drive",
		} as IBackendProvider);
		const mockGetWebUrl = vi.fn().mockResolvedValue("https://drive.google.com/file/d/456/view");
		const mockFs = { getWebUrl: mockGetWebUrl } as unknown as IFileSystem;
		mockGetRemoteFs.mockReturnValue(mockFs);

		const menu = new Menu();
		const mockFile = { path: "active.md", name: "active.md" } as TAbstractFile;
		const mockView = { file: mockFile } as unknown as MarkdownView;

		workspaceEventHandlers["editor-menu"]!(menu, {} as never, mockView);

		const items = getMenuItems(menu);
		expect(items.length).toBe(1);
		await items[0]!.callback!();

		expect(mockWindowOpen).toHaveBeenCalledWith("https://drive.google.com/file/d/456/view");
	});

	describe("Notebook Navigator integration", () => {
		it("registers with Notebook Navigator API when present", () => {
			registerHandlers();

			expect(mockNnPlugin.api.menus.registerFileMenu).toHaveBeenCalled();
			expect(mockNnPlugin.api.menus.registerFolderMenu).toHaveBeenCalled();
		});

		it("adds Open in Google Drive when Notebook Navigator file menu is triggered", () => {
			registerHandlers();
			mockGetBackendProvider.mockReturnValue({ displayName: "Google Drive" } as IBackendProvider);
			mockGetRemoteFs.mockReturnValue({ getWebUrl: vi.fn() } as unknown as IFileSystem);

			const fileMenuCb = mockNnPlugin.api.menus.registerFileMenu.mock.calls[0]![0];
			const addedItems: TestMenuItem[] = [];
			const mockAddItem = (cb: (item: MenuItem) => void) => {
				const item = createMockMenuItem();
				cb(item);
				addedItems.push(item);
			};

			const mockFile = { path: "Work/Note.md", name: "Note.md" } as TAbstractFile;
			fileMenuCb({ addItem: mockAddItem, file: mockFile, selection: { mode: "single", files: [mockFile] } });

			expect(addedItems.length).toBe(1);
			expect(addedItems[0]!.title).toBe("Open in Google Drive");
		});

		it("adds multi-item Open in Google Drive when multiple files are selected in Notebook Navigator", () => {
			registerHandlers();
			mockGetBackendProvider.mockReturnValue({ displayName: "Google Drive" } as IBackendProvider);
			mockGetRemoteFs.mockReturnValue({ getWebUrl: vi.fn() } as unknown as IFileSystem);

			const fileMenuCb = mockNnPlugin.api.menus.registerFileMenu.mock.calls[0]![0];
			const addedItems: TestMenuItem[] = [];
			const mockAddItem = (cb: (item: MenuItem) => void) => {
				const item = createMockMenuItem();
				cb(item);
				addedItems.push(item);
			};

			const mockFile1 = { path: "Work/Note1.md", name: "Note1.md" } as TAbstractFile;
			const mockFile2 = { path: "Work/Note2.md", name: "Note2.md" } as TAbstractFile;
			fileMenuCb({
				addItem: mockAddItem,
				file: mockFile1,
				selection: { mode: "multiple", files: [mockFile1, mockFile2] },
			});

			expect(addedItems.length).toBe(1);
			expect(addedItems[0]!.title).toBe("Open 2 items in Google Drive");
		});

		it("adds Open in Google Drive when Notebook Navigator folder menu is triggered", () => {
			registerHandlers();
			mockGetBackendProvider.mockReturnValue({ displayName: "Google Drive" } as IBackendProvider);
			mockGetRemoteFs.mockReturnValue({ getWebUrl: vi.fn() } as unknown as IFileSystem);

			const folderMenuCb = mockNnPlugin.api.menus.registerFolderMenu.mock.calls[0]![0];
			const addedItems: TestMenuItem[] = [];
			const mockAddItem = (cb: (item: MenuItem) => void) => {
				const item = createMockMenuItem();
				cb(item);
				addedItems.push(item);
			};

			const mockFolder = { path: "Work", name: "Work" } as TAbstractFile;
			folderMenuCb({ addItem: mockAddItem, folder: mockFolder });

			expect(addedItems.length).toBe(1);
			expect(addedItems[0]!.title).toBe("Open in Google Drive");
		});
	});

	describe("Menu prototype showAtMouseEvent hook", () => {
		it("intercepts showAtMouseEvent on a Notebook Navigator file element", () => {
			registerHandlers();
			mockGetBackendProvider.mockReturnValue({ displayName: "Google Drive" } as IBackendProvider);
			mockGetRemoteFs.mockReturnValue({ getWebUrl: vi.fn() } as unknown as IFileSystem);

			const mockFile = { path: "Folder/Note.md", name: "Note.md" } as TAbstractFile;
			mockFilesByPath["Folder/Note.md"] = mockFile;

			const parentEl = {
				getAttribute: (name: string) => (name === "data-path" ? "Folder/Note.md" : null),
				closest: (sel: string) => (sel.includes("data-path") ? parentEl : null),
			};
			const targetEl = {
				getAttribute: (_name: string) => null,
				closest: (sel: string) => (sel.includes("data-path") ? parentEl : null),
			};

			const menu = new Menu();
			const mockEvt = { target: targetEl } as unknown as MouseEvent;

			menu.showAtMouseEvent(mockEvt);

			const items = getMenuItems(menu);
			expect(items.length).toBe(1);
			expect(items[0]!.title).toBe("Open in Google Drive");
		});

		it("does not duplicate menu item if already handled", () => {
			registerHandlers();
			mockGetBackendProvider.mockReturnValue({ displayName: "Google Drive" } as IBackendProvider);
			mockGetRemoteFs.mockReturnValue({ getWebUrl: vi.fn() } as unknown as IFileSystem);

			const mockFile = { path: "Folder/Note.md", name: "Note.md" } as TAbstractFile;
			mockFilesByPath["Folder/Note.md"] = mockFile;

			const menu = new Menu();
			// First add via file-menu
			workspaceEventHandlers["file-menu"]!(menu, mockFile);
			expect(getMenuItems(menu).length).toBe(1);

			// Then showAtMouseEvent is called
			const targetEl = {
				getAttribute: (name: string) => (name === "data-path" ? "Folder/Note.md" : null),
				closest: (_sel: string) => targetEl,
			};
			menu.showAtMouseEvent({ target: targetEl } as unknown as MouseEvent);

			// Still exactly 1 item!
			expect(getMenuItems(menu).length).toBe(1);
		});

		it("restores Menu prototype on cleanup", () => {
			const originalShow = currentShowAtMouseEvent();
			registerHandlers();

			// Hooked
			expect(currentShowAtMouseEvent()).not.toBe(originalShow);

			// Clean up all
			for (const cleanup of cleanupCallbacks) {
				cleanup();
			}

			// Restored
			expect(currentShowAtMouseEvent()).toBe(originalShow);
		});
	});

	describe("Normal delete hook and confirmation", () => {
		it("does not add a separate delete menu item, only hooks the normal delete", () => {
			registerContextMenuHandlers({
				app: mockApp,
				backendManager: mockBackendManager,
				orchestrator: deleteOrchestrator,
				registerEvent: (ref) => registeredEvents.push(ref as never),
				registerDomEvent: (_el, type, cb) => {
					domEventHandlers[type] = cb;
				},
				registerCleanup: (cb) => cleanupCallbacks.push(cb),
			});

			mockGetBackendProvider.mockReturnValue({ displayName: "Google Drive" } as IBackendProvider);
			mockGetRemoteFs.mockReturnValue({ getWebUrl: vi.fn(), delete: vi.fn() } as unknown as IFileSystem);

			const menu = new Menu();
			const mockFile = { path: "Projects/Note.md", name: "Note.md" } as TAbstractFile;

			workspaceEventHandlers["file-menu"]!(menu, mockFile);

			const items = getMenuItems(menu);
			// Only "Open in Google Drive" added by VaultBridge — no duplicate delete menu item!
			expect(items.length).toBe(1);
			expect(items[0]!.title).toBe("Open in Google Drive");
		});

		it("hooks the existing normal delete menu item to trigger confirmation modal", () => {
			registerContextMenuHandlers({
				app: mockApp,
				backendManager: mockBackendManager,
				orchestrator: deleteOrchestrator,
				registerEvent: (ref) => registeredEvents.push(ref as never),
				registerDomEvent: (_el, type, cb) => {
					domEventHandlers[type] = cb;
				},
				registerCleanup: (cb) => cleanupCallbacks.push(cb),
			});

			mockGetBackendProvider.mockReturnValue({ displayName: "Google Drive" } as IBackendProvider);
			mockGetRemoteFs.mockReturnValue({ getWebUrl: vi.fn(), delete: vi.fn() } as unknown as IFileSystem);

			const menu = new Menu();
			// Simulate Obsidian's core Delete item pre-existing in the menu
			menu.addItem((item) => {
				item.setTitle("Delete");
				item.setIcon("trash");
				item.onClick(vi.fn());
			});

			const mockFile = { path: "Projects/Note.md", name: "Note.md" } as TAbstractFile;
			workspaceEventHandlers["file-menu"]!(menu, mockFile);

			const items = getMenuItems(menu);
			const deleteItem = items.find((i) => i.title.toLowerCase().includes("delete"));
			expect(deleteItem).toBeDefined();
			// Clicking the normal Delete now opens the vault-and-cloud confirmation.
			__ui.lastModal = null;
			void deleteItem!.callback?.();
			expect(__ui.lastModal).toBeInstanceOf(DirectDeleteConfirmModal);
		});
	});
});
