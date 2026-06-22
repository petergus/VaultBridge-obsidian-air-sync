import type { App } from "obsidian";
import { ButtonComponent, Modal, Notice, Setting } from "obsidian";
import type { VaultBridgeSettings } from "../settings";

/** Minimal client shape the picker needs: list immediate subfolders of a path. */
interface AppFolderListClient {
	listFolders(path: string): Promise<{ name: string; path: string }[]>;
}

/** Minimal provider shape: build a UI client for the given settings. */
export interface AppFolderPickerProvider {
	createUiClient(settings: VaultBridgeSettings): AppFolderListClient;
}

/**
 * In-app folder picker for an App-Folder-scoped backend (Dropbox, OneDrive).
 * Allows the user to drill down level-by-level through the app-folder tree,
 * select an existing folder, or create a new subfolder under the current path.
 */
export class AppFolderPickerModal extends Modal {
	private selected = "";
	private newName = "";
	private currentPath = ""; // Path relative to App Folder, e.g. "" or "Folder A"
	private folders: { name: string; path: string }[] = [];
	private pickerContainer: HTMLDivElement | null = null;

	constructor(
		app: App,
		private title: string,
		private provider: AppFolderPickerProvider,
		private settings: VaultBridgeSettings,
		private onSave: (updates: Record<string, unknown>) => Promise<void>,
		private bindDefault: () => Promise<void>,
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		this.setTitle(this.title);
		contentEl.createEl("p", {
			text: "Pick an existing folder in the app folder, or create a new one. This vault syncs into the chosen folder.",
		});

		this.pickerContainer = contentEl.createDiv();
		await this.loadFolders();
		this.renderPicker();
	}

	private async loadFolders(): Promise<void> {
		try {
			const client = this.provider.createUiClient(this.settings);
			this.folders = await client.listFolders(this.currentPath);
		} catch (err) {
			console.error("Failed to list folders at path:", this.currentPath, err);
			new Notice(`Could not list folders: ${err instanceof Error ? err.message : String(err)}`);
			this.folders = [];
		}
	}

	private renderPicker(): void {
		if (!this.pickerContainer) return;
		this.pickerContainer.empty();

		// Current Path Header
		const pathDisplay = this.currentPath ? `/${this.currentPath}` : "/ (Root)";
		const headerEl = this.pickerContainer.createDiv({
			cls: "vaultbridge-picker-header",
			attr: { style: "margin-bottom: 15px; display: flex; align-items: center;" }
		});
		headerEl.createEl("span", { text: "Current folder: ", attr: { style: "font-weight: bold; margin-right: 5px;" } });
		headerEl.createEl("span", { text: pathDisplay, attr: { style: "font-family: monospace;" } });

		if (this.currentPath) {
			const backButton = headerEl.createEl("button", {
				text: "Back",
				attr: { style: "margin-left: 15px; padding: 2px 8px; font-size: 0.9em;" }
			});
			backButton.addEventListener("click", () => {
				void (async () => {
					const parts = this.currentPath.split("/");
					parts.pop();
					this.currentPath = parts.join("/");
					this.selected = "";
					await this.loadFolders();
					this.renderPicker();
				})();
			});
		}

		// Existing Folders Dropdown
		const safeFolders = this.folders.filter(f => typeof f.name === "string" && f.name !== "");
		if (safeFolders.length > 0) {
			const dropdownSetting = new Setting(this.pickerContainer)
				.setName("Existing folder")
				.setDesc("Select a folder at the current level.")
				.addDropdown((dd) => {
					dd.addOption("", "Select a folder…");
					for (const folder of safeFolders) {
						dd.addOption(folder.path, folder.name);
					}
					dd.setValue(this.selected);
					dd.onChange((value) => {
						this.selected = value;
						drillButton?.setDisabled(!value);
					});
				});

			let drillButton: ButtonComponent | undefined;
			dropdownSetting.addButton((btn) => {
				drillButton = btn
					.setButtonText("Open")
					.setDisabled(!this.selected)
					.onClick(async () => {
						if (!this.selected) return;
						this.currentPath = this.selected;
						this.selected = "";
						await this.loadFolders();
						this.renderPicker();
					});
			});
		} else {
			this.pickerContainer.createEl("p", {
				text: "No subfolders found at this level.",
				attr: { style: "color: var(--text-muted); font-style: italic; margin: 10px 0;" }
			});
		}

		// New Folder Input
		new Setting(this.pickerContainer)
			.setName("New folder name")
			.setDesc("Or create a new folder under the current folder.")
			.addText((text) =>
				text
					.setPlaceholder("My vault")
					.setValue(this.newName)
					.onChange((value) => {
						this.newName = value.trim();
					}),
			);

		// Use This Folder Button
		new Setting(this.pickerContainer).addButton((button) =>
			button
				.setButtonText("Use this folder")
				.setCta()
				.onClick(() => void this.confirm()),
		);
	}

	private async confirm(): Promise<void> {
		let finalPath = "";
		if (this.newName) {
			// If creating a new folder, construct path under currentPath
			finalPath = this.currentPath ? `${this.currentPath}/${this.newName}` : this.newName;
		} else {
			// Otherwise use the selected dropdown folder or the current path itself
			finalPath = this.selected || this.currentPath;
		}

		if (!finalPath) {
			new Notice("Pick a folder or enter a new name.");
			return;
		}

		this.close();
		// Queue the chosen path, then trigger the bind action
		await this.onSave({ pendingPickedFolderPath: finalPath });
		await this.bindDefault();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
