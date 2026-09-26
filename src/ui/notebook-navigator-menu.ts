import type { App, MenuItem, TAbstractFile } from "obsidian";
import {
	markItemMenuAdded,
	setupMenuItem,
	setupMultiMenuItem,
	type ContextMenuDeps,
} from "./menu-items";

/**
 * Notebook Navigator (community plugin) replaces the core file explorer and builds its
 * own menus, so the core `file-menu` event never fires there. It exposes a menu
 * extension API; this module registers the "Open in <backend>" items through it.
 */

/** The slice of Notebook Navigator's public menu API used here. */
interface NnMenuContext {
	addItem: (cb: (item: MenuItem) => void) => void;
	file?: TAbstractFile;
	folder?: TAbstractFile;
	selection?: { mode?: string; files?: TAbstractFile[] };
}
interface NnMenusApi {
	registerFileMenu?: (cb: (ctx: NnMenuContext) => void) => unknown;
	registerFolderMenu?: (cb: (ctx: NnMenuContext) => void) => unknown;
}
interface NnPlugin {
	api?: { menus?: NnMenusApi };
}

/** Plugins already hooked — the hook is retried on layout-ready and on every menu. */
const hookedPlugins = new WeakSet<object>();

function findNotebookNavigator(app: App): NnPlugin | undefined {
	// `app.plugins` is not in the public typings; read it defensively.
	const registry = (app as unknown as { plugins?: { plugins?: Record<string, NnPlugin | undefined> } }).plugins;
	return registry?.plugins?.["notebook-navigator"];
}

function registerCleanupIfFn(deps: ContextMenuDeps, unregister: unknown): void {
	if (typeof unregister === "function" && deps.registerCleanup) {
		deps.registerCleanup(unregister as () => void);
	}
}

/** Returns an idempotent function that hooks Notebook Navigator's menus once it is loaded. */
export function createNotebookNavigatorHook(deps: ContextMenuDeps): () => void {
	return () => {
		const nnPlugin = findNotebookNavigator(deps.app);
		const menus = nnPlugin?.api?.menus;
		if (!nnPlugin || !menus) return;
		if (hookedPlugins.has(nnPlugin)) return;
		hookedPlugins.add(nnPlugin);

		if (typeof menus.registerFileMenu === "function") {
			registerCleanupIfFn(deps, menus.registerFileMenu(({ addItem, file, selection }) => {
				if (!file) return;
				const selected = selection?.files;
				if (selection?.mode === "multiple" && selected && selected.length > 1) {
					addItem((item) => {
						markItemMenuAdded(item);
						setupMultiMenuItem(item, selected, deps);
					});
				} else if (deps.backendManager.getRemoteFs()?.getWebUrl) {
					addItem((item) => {
						markItemMenuAdded(item);
						setupMenuItem(item, file, deps);
					});
				}
			}));
		}

		if (typeof menus.registerFolderMenu === "function") {
			registerCleanupIfFn(deps, menus.registerFolderMenu(({ addItem, folder }) => {
				if (!folder) return;
				if (deps.backendManager.getRemoteFs()?.getWebUrl) {
					addItem((item) => {
						markItemMenuAdded(item);
						setupMenuItem(item, folder, deps);
					});
				}
			}));
		}
	};
}
