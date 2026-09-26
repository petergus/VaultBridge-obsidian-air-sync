import type { App, EventRef, MarkdownFileInfo, MarkdownView, MenuPositionDef, TAbstractFile } from "obsidian";
import { Menu } from "obsidian";
import { hookNormalDeleteItem, registerTrashFileHook } from "./delete-hooks";
import {
	canOpenInRemote,
	hasOpenItem,
	markOpenItemAdded,
	setupMenuItem,
	setupMultiMenuItem,
	type ContextMenuDeps,
} from "./menu-items";
import { createNotebookNavigatorHook } from "./notebook-navigator-menu";

export type { ContextMenuDeps } from "./menu-items";

/** How recent a right-click must be for a position-shown menu to be treated as its menu. */
const CONTEXT_MENU_FRESH_MS = 1000;

/** The DOM surface `resolveFileFromElement` needs — duck-typed so any element-like target works. */
interface ClosestCapable {
	closest(selector: string): { getAttribute(name: string): string | null } | null;
}

function isClosestCapable(el: unknown): el is ClosestCapable {
	return !!el && typeof (el as Partial<ClosestCapable>).closest === "function";
}

/**
 * Resolve the vault file a right-clicked element stands for, via the nearest
 * `data-path` (core explorer, Notebook Navigator, and most file-list plugins set it).
 */
function resolveFileFromElement(el: unknown, app: App): TAbstractFile | null {
	if (!isClosestCapable(el)) return null;
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

/** Add the "Open in <backend>" item for `file` to `menu`, once. */
function addOpenItemOnce(menu: Menu, file: TAbstractFile, deps: ContextMenuDeps, withSeparator = false): void {
	if (hasOpenItem(menu) || !canOpenInRemote(deps)) return;
	markOpenItemAdded(menu);
	if (withSeparator) menu.addSeparator();
	menu.addItem((item) => {
		setupMenuItem(item, file, deps);
	});
}

/**
 * Register file-menu, files-menu, and editor-menu handlers that add "Open in <Backend>"
 * and route the normal "Delete" through the vault-and-cloud confirmation.
 * Also hooks Notebook Navigator's menu API and Menu.prototype for full compatibility.
 */
export function registerContextMenuHandlers(
	deps: ContextMenuDeps,
	legacyRegisterEvent?: (ref: EventRef) => void,
): void {
	const registerEvent =
		deps.registerEvent ?? legacyRegisterEvent ?? ((ref) => deps.app.workspace.offref(ref));

	const addSingleItemToMenu = (menu: Menu, file: TAbstractFile) => {
		if (!file) return;
		hookNormalDeleteItem(menu, file, deps);
		addOpenItemOnce(menu, file, deps);
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
			if (hasOpenItem(menu)) return;

			if (files.length === 1 && files[0]) {
				addSingleItemToMenu(menu, files[0]);
			} else if (files.length > 1 && canOpenInRemote(deps)) {
				markOpenItemAdded(menu);
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

	// 4. Hook Notebook Navigator's menu extension API if installed (now, and once it loads)
	const hookNotebookNavigator = createNotebookNavigatorHook(deps);
	hookNotebookNavigator();
	deps.app.workspace.onLayoutReady(() => {
		hookNotebookNavigator();
	});

	// 5. Track last right-clicked DOM element for context menus that don't trigger events
	let lastContextMenuTarget: EventTarget | null = null;
	let lastContextMenuTime = 0;

	if (typeof window !== "undefined" && deps.registerDomEvent) {
		deps.registerDomEvent(
			window,
			"contextmenu",
			(evt: MouseEvent) => {
				lastContextMenuTarget = evt?.target ?? null;
				lastContextMenuTime = Date.now();
			},
			true,
		);
	}

	// 6. Monkeypatch Menu.prototype.showAtMouseEvent and showAtPosition as a universal fallback
	// The originals are held unbound on purpose: each is restored onto the prototype at
	// cleanup and re-invoked with `.call(this, …)` below, so `this` is always the menu.
	const origShowAtMouseEvent = Menu.prototype.showAtMouseEvent; // eslint-disable-line @typescript-eslint/unbound-method -- restored at cleanup, invoked via .call(this)
	const origShowAtPosition = Menu.prototype.showAtPosition; // eslint-disable-line @typescript-eslint/unbound-method -- restored at cleanup, invoked via .call(this)

	Menu.prototype.showAtMouseEvent = function (this: Menu, evt: MouseEvent) {
		try {
			hookNotebookNavigator();
			const file = resolveFileFromElement(evt?.target ?? lastContextMenuTarget, deps.app);
			if (file) {
				hookNormalDeleteItem(this, file, deps);
				addOpenItemOnce(this, file, deps, true);
			}
		} catch (err) {
			console.error("[VaultBridge] Error in context menu hook:", err);
		}
		return origShowAtMouseEvent.call(this, evt);
	};

	Menu.prototype.showAtPosition = function (this: Menu, pos: MenuPositionDef, doc?: Document) {
		try {
			hookNotebookNavigator();
			const file = resolveFileFromElement(lastContextMenuTarget, deps.app);
			if (file && Date.now() - lastContextMenuTime < CONTEXT_MENU_FRESH_MS) {
				hookNormalDeleteItem(this, file, deps);
				addOpenItemOnce(this, file, deps, true);
			}
		} catch (err) {
			console.error("[VaultBridge] Error in showAtPosition hook:", err);
		}
		return origShowAtPosition.call(this, pos, doc);
	};

	const unhookTrash = registerTrashFileHook(deps);

	if (deps.registerCleanup) {
		deps.registerCleanup(() => {
			unhookTrash();
			Menu.prototype.showAtMouseEvent = origShowAtMouseEvent;
			Menu.prototype.showAtPosition = origShowAtPosition;
		});
	}
}
