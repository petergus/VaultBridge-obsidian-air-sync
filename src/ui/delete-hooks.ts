import type { Menu, MenuItem, TAbstractFile } from "obsidian";
import { DirectDeleteConfirmModal } from "./direct-delete-modal";
import { getCleanDisplayName, type ContextMenuDeps } from "./menu-items";
import { isTrashModalSuppressed } from "../utils/trash-suppression";

/**
 * Route the user's ordinary "Delete" (the menu item, or any `fileManager.trashFile`
 * call) through {@link DirectDeleteConfirmModal}, which deletes from the vault AND the
 * remote in one step — so a deliberate delete never reaches the other device as a held
 * "mass deletion" awaiting review.
 */

/**
 * The parts of Obsidian's menu internals these hooks read. Neither is in the public
 * typings; every access is guarded, so a changed internal just disables the hook.
 */
interface MenuItemInternals {
	title?: string;
	titleEl?: { textContent: string | null };
	icon?: string;
}
interface MenuInternals {
	items?: unknown;
}

/** Items whose click was already rerouted, and menus whose `addItem` is wrapped. */
const hookedItems = new WeakSet<object>();
const wrappedMenus = new WeakSet<Menu>();

function isDeleteItem(item: MenuItem): boolean {
	const internals = item as unknown as MenuItemInternals;
	const title = (internals.title || internals.titleEl?.textContent || "").toLowerCase();
	const icon = (internals.icon || "").toLowerCase();
	return title.includes("delete") || icon.includes("trash");
}

export function hookNormalDeleteItem(
	menu: Menu,
	file: TAbstractFile,
	deps: ContextMenuDeps,
): void {
	const { orchestrator } = deps;
	if (!orchestrator) return;
	const provider = deps.backendManager.getBackendProvider();
	if (!provider) return;
	const remoteFs = deps.backendManager.getRemoteFs();
	if (!remoteFs) return;
	if (!file || !file.path || file.path === "/" || file.path === "") return;

	const displayName = getCleanDisplayName(provider.displayName);

	const tryHookItem = (item: MenuItem): void => {
		if (!item || hookedItems.has(item) || !isDeleteItem(item)) return;
		hookedItems.add(item);
		item.onClick(() => {
			new DirectDeleteConfirmModal(deps.app, file, { remoteFs, orchestrator, displayName }).open();
		});
	};

	const { items } = menu as unknown as MenuInternals;
	if (Array.isArray(items)) {
		for (const it of items as MenuItem[]) tryHookItem(it);
	}

	// Items added after this point (the menu is still being built) are hooked as they arrive.
	if (!wrappedMenus.has(menu)) {
		wrappedMenus.add(menu);
		const origAddItem = menu.addItem.bind(menu);
		menu.addItem = (cb: (item: MenuItem) => unknown) =>
			origAddItem((item: MenuItem) => {
				cb(item);
				tryHookItem(item);
			});
	}
}

export function registerTrashFileHook(deps: ContextMenuDeps): () => void {
	const fileManager = deps.app.fileManager;
	if (!fileManager || typeof fileManager.trashFile !== "function") {
		return () => {};
	}

	const originalTrashFile = fileManager.trashFile.bind(fileManager);

	fileManager.trashFile = async (file: TAbstractFile) => {
		// The plugin's own deletions (sync, the confirm modal) pass straight through.
		if (isTrashModalSuppressed()) {
			return originalTrashFile(file);
		}

		const provider = deps.backendManager.getBackendProvider();
		const remoteFs = deps.backendManager.getRemoteFs();
		const { orchestrator } = deps;
		if (
			!provider ||
			!remoteFs ||
			!orchestrator ||
			!file?.path ||
			file.path === "/" ||
			file.path === ""
		) {
			return originalTrashFile(file);
		}

		const displayName = getCleanDisplayName(provider.displayName);

		return new Promise<void>((resolve) => {
			new DirectDeleteConfirmModal(deps.app, file, {
				remoteFs,
				orchestrator,
				displayName,
				onDeleted: () => resolve(),
			}).open();
		});
	};

	return () => {
		fileManager.trashFile = originalTrashFile;
	};
}
