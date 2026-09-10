import type { App, EventRef, MarkdownFileInfo, MarkdownView, MenuItem, TAbstractFile } from "obsidian";
import { Menu, Notice } from "obsidian";
import type { BackendManager } from "../fs/backend-manager";

export interface ContextMenuDeps {
	app: App;
	backendManager: BackendManager;
	registerEvent?: (ref: EventRef) => void;
	registerDomEvent?: (
		el: Window | Document | HTMLElement,
		type: string,
		callback: (evt: any) => any,
		options?: boolean | AddEventListenerOptions,
	) => void;
	registerCleanup?: (cb: () => void) => void;
}

function getCleanDisplayName(rawName: string): string {
	const lower = rawName.toLowerCase();
	if (lower.includes("google drive")) return "Google Drive";
	if (lower.includes("onedrive")) return "OneDrive";
	if (lower.includes("dropbox")) return "Dropbox";
	return rawName;
}

export function setupMenuItem(
	item: MenuItem,
	file: TAbstractFile,
	deps: ContextMenuDeps,
): void {
	const provider = deps.backendManager.getBackendProvider();
	if (!provider) return;

	const remoteFs = deps.backendManager.getRemoteFs();
	if (!remoteFs?.getWebUrl) return;

	const displayName = getCleanDisplayName(provider.displayName);
	const name = file.name || deps.app.vault.getName() || "Vault root";

	item
		.setTitle(`Open in ${displayName}`)
		.setIcon("external-link")
		.onClick(async () => {
			try {
				const currentFs = deps.backendManager.getRemoteFs();
				const url = await currentFs?.getWebUrl?.(file.path);
				if (url) {
					window.open(url);
				} else {
					new Notice(`"${name}" is not yet synced to ${displayName}`);
				}
			} catch {
				new Notice(`Failed to open "${name}" in ${displayName}`);
			}
		});
}

export function setupMultiMenuItem(
	item: MenuItem,
	files: readonly TAbstractFile[],
	deps: ContextMenuDeps,
): void {
	const provider = deps.backendManager.getBackendProvider();
	if (!provider) return;

	const remoteFs = deps.backendManager.getRemoteFs();
	if (!remoteFs?.getWebUrl) return;

	const displayName = getCleanDisplayName(provider.displayName);

	item
		.setTitle(`Open ${files.length} items in ${displayName}`)
		.setIcon("external-link")
		.onClick(async () => {
			let openedCount = 0;
			for (const file of files) {
				try {
					const currentFs = deps.backendManager.getRemoteFs();
					const url = await currentFs?.getWebUrl?.(file.path);
					if (url) {
						window.open(url);
						openedCount++;
					}
				} catch {
					// Ignore individual failure in multi-open
				}
			}
			if (openedCount === 0 && files.length > 0) {
				new Notice(`Selected items are not yet synced to ${displayName}`);
			}
		});
}

function resolveFileFromElement(el: any, app: App): TAbstractFile | null {
	if (!el || typeof el.closest !== "function") return null;
	const matchEl = el.closest(
		".nn-file[data-path], .nn-folder[data-path], .nn-navitem[data-path], .nav-file, .nav-folder, [data-path]",
	);
	if (!matchEl || typeof matchEl.getAttribute !== "function") return null;

	const path = matchEl.getAttribute("data-path");
	if (path === null || path === undefined) return null;

	if (path === "" || path === "/") {
		return app.vault.getRoot();
	}
	return app.vault.getAbstractFileByPath(path);
}

/**
 * Register file-menu, files-menu, and editor-menu handlers to add an "Open in <Backend>"
 * item (e.g. "Open in Google Drive") when the active backend supports getWebUrl.
 * Also hooks Notebook Navigator API and Menu.prototype for full compatibility.
 */
export function registerContextMenuHandlers(
	deps: ContextMenuDeps,
	legacyRegisterEvent?: (ref: EventRef) => void,
): void {
	const registerEvent =
		deps.registerEvent ?? legacyRegisterEvent ?? ((ref) => deps.app.workspace.offref(ref));

	const addSingleItemToMenu = (menu: Menu, file: TAbstractFile) => {
		if (!file) return;
		if ((menu as any).__vaultbridge_context_menu_added) return;

		const provider = deps.backendManager.getBackendProvider();
		if (!provider) return;

		const remoteFs = deps.backendManager.getRemoteFs();
		if (!remoteFs?.getWebUrl) return;

		(menu as any).__vaultbridge_context_menu_added = true;

		menu.addItem((item) => {
			setupMenuItem(item, file, deps);
		});
	};

	// 1. Right-click in File Explorer or tab headers (Obsidian core event)
	registerEvent(
		deps.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
			addSingleItemToMenu(menu, file);
		}),
	);

	// 2. Right-click when file(s) are selected in a multi-file selection context (Obsidian core event)
	registerEvent(
		deps.app.workspace.on("files-menu", (menu: Menu, files: TAbstractFile[]) => {
			if (!files || files.length === 0) return;
			if ((menu as any).__vaultbridge_context_menu_added) return;

			if (files.length === 1 && files[0]) {
				addSingleItemToMenu(menu, files[0]);
			} else if (files.length > 1) {
				const provider = deps.backendManager.getBackendProvider();
				if (!provider) return;
				const remoteFs = deps.backendManager.getRemoteFs();
				if (!remoteFs?.getWebUrl) return;

				(menu as any).__vaultbridge_context_menu_added = true;
				menu.addItem((item) => {
					setupMultiMenuItem(item, files, deps);
				});
			}
		}),
	);

	// 3. Right-click inside active note editor (Obsidian core event)
	registerEvent(
		deps.app.workspace.on("editor-menu", (menu: Menu, _editor, info: MarkdownView | MarkdownFileInfo) => {
			if (info?.file) {
				addSingleItemToMenu(menu, info.file);
			}
		}),
	);

	// 4. Hook Notebook Navigator Official Extension API if installed
	const hookNotebookNavigator = () => {
		const nnPlugin = (deps.app as any).plugins?.plugins?.["notebook-navigator"];
		if (!nnPlugin?.api?.menus) return;
		if ((nnPlugin as any).__vaultbridge_nn_hooked) return;
		(nnPlugin as any).__vaultbridge_nn_hooked = true;

		if (typeof nnPlugin.api.menus.registerFileMenu === "function") {
			const unregFile = nnPlugin.api.menus.registerFileMenu(
				({ addItem, file, selection }: any) => {
					if (!file) return;
					if (selection?.mode === "multiple" && selection?.files?.length > 1) {
						addItem((item: MenuItem) => {
							if ((item as any).menu) {
								(item as any).menu.__vaultbridge_context_menu_added = true;
							}
							setupMultiMenuItem(item, selection.files, deps);
						});
					} else {
						addItem((item: MenuItem) => {
							if ((item as any).menu) {
								(item as any).menu.__vaultbridge_context_menu_added = true;
							}
							setupMenuItem(item, file, deps);
						});
					}
				},
			);
			if (typeof unregFile === "function" && deps.registerCleanup) {
				deps.registerCleanup(unregFile);
			}
		}

		if (typeof nnPlugin.api.menus.registerFolderMenu === "function") {
			const unregFolder = nnPlugin.api.menus.registerFolderMenu(
				({ addItem, folder }: any) => {
					if (!folder) return;
					addItem((item: MenuItem) => {
						if ((item as any).menu) {
							(item as any).menu.__vaultbridge_context_menu_added = true;
						}
						setupMenuItem(item, folder, deps);
					});
				},
			);
			if (typeof unregFolder === "function" && deps.registerCleanup) {
				deps.registerCleanup(unregFolder);
			}
		}
	};

	hookNotebookNavigator();
	deps.app.workspace.onLayoutReady(() => {
		hookNotebookNavigator();
	});

	// 5. Track last right-clicked DOM element for context menus that don't trigger events
	let lastContextMenuTarget: HTMLElement | null = null;
	let lastContextMenuTime = 0;

	if (typeof window !== "undefined" && deps.registerDomEvent) {
		deps.registerDomEvent(
			window,
			"contextmenu",
			(evt: MouseEvent) => {
				lastContextMenuTarget = (evt?.target as any) ?? null;
				lastContextMenuTime = Date.now();
			},
			true,
		);
	}

	// 6. Monkeypatch Menu.prototype.showAtMouseEvent and showAtPosition as a universal fallback
	const origShowAtMouseEvent = Menu.prototype.showAtMouseEvent;
	const origShowAtPosition = Menu.prototype.showAtPosition;

	Menu.prototype.showAtMouseEvent = function (evt: MouseEvent) {
		try {
			hookNotebookNavigator();
			if (!(this as any).__vaultbridge_context_menu_added) {
				const provider = deps.backendManager.getBackendProvider();
				const remoteFs = deps.backendManager.getRemoteFs();
				if (provider && remoteFs?.getWebUrl) {
					const target = (evt?.target as any) || lastContextMenuTarget;
					const file = resolveFileFromElement(target, deps.app);
					if (file) {
						(this as any).__vaultbridge_context_menu_added = true;
						this.addSeparator();
						this.addItem((item) => {
							setupMenuItem(item, file, deps);
						});
					}
				}
			}
		} catch (err) {
			console.error("[VaultBridge] Error in context menu hook:", err);
		}
		return origShowAtMouseEvent.call(this, evt);
	};

	Menu.prototype.showAtPosition = function (pos: any, doc?: Document) {
		try {
			hookNotebookNavigator();
			if (!(this as any).__vaultbridge_context_menu_added && Date.now() - lastContextMenuTime < 1000) {
				const provider = deps.backendManager.getBackendProvider();
				const remoteFs = deps.backendManager.getRemoteFs();
				if (provider && remoteFs?.getWebUrl) {
					const file = resolveFileFromElement(lastContextMenuTarget, deps.app);
					if (file) {
						(this as any).__vaultbridge_context_menu_added = true;
						this.addSeparator();
						this.addItem((item) => {
							setupMenuItem(item, file, deps);
						});
					}
				}
			}
		} catch (err) {
			console.error("[VaultBridge] Error in showAtPosition hook:", err);
		}
		return origShowAtPosition.call(this, pos, doc);
	};

	if (deps.registerCleanup) {
		deps.registerCleanup(() => {
			Menu.prototype.showAtMouseEvent = origShowAtMouseEvent;
			Menu.prototype.showAtPosition = origShowAtPosition;
		});
	}
}
