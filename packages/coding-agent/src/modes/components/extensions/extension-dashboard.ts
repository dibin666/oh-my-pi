/**
 * ExtensionDashboard - Tabbed layout for the Extension Control Center.
 *
 * Layout:
 * - Top: Horizontal tab bar for provider selection
 * - Body: 2-column grid (inventory list | preview panel)
 *
 * Navigation:
 * - TAB/Shift+TAB: Cycle through provider tabs
 * - Up/Down/j/k: Navigate list
 * - Space: Toggle selected item (or master switch)
 * - Esc: Close dashboard (clears search first if active)
 */
import {
	type Component,
	Container,
	matchesKey,
	padding,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import type { MCPServer } from "../../../capability/mcp";
import { Settings } from "../../../config/settings";
import { formatMcpTimeoutDisplay, setMcpTimeoutOverride } from "../../../mcp/timeout-overrides";
import { DynamicBorder } from "../../../modes/components/dynamic-border";
import { theme } from "../../../modes/theme/theme";
import { matchesAppInterrupt } from "../../../modes/utils/keybinding-matchers";
import { HookInputComponent } from "../hook-input";
import { ExtensionList } from "./extension-list";
import { InspectorPanel } from "./inspector-panel";
import { applyFilter, createInitialState, filterByProvider, refreshState, toggleProvider } from "./state-manager";
import type { DashboardState, Extension } from "./types";

export interface ExtensionDashboardOptions {
	onMcpTimeoutUpdated?: () => Promise<void>;
}

export class ExtensionDashboard extends Container {
	#state!: DashboardState;
	#mainList!: ExtensionList;
	#inspector!: InspectorPanel;
	#noticeLine: string | null = null;
	#timeoutEditor: HookInputComponent | null = null;

	onClose?: () => void;

	private constructor(
		private readonly cwd: string,
		private readonly settings: Settings | null,
		private readonly terminalHeight: number,
		private readonly options: ExtensionDashboardOptions = {},
	) {
		super();
	}

	static async create(
		cwd: string,
		settings: Settings | null = null,
		terminalHeight?: number,
		options: ExtensionDashboardOptions = {},
	): Promise<ExtensionDashboard> {
		const dashboard = new ExtensionDashboard(cwd, settings, terminalHeight ?? process.stdout.rows ?? 24, options);
		await dashboard.#init();
		return dashboard;
	}

	async #init(): Promise<void> {
		const sm = this.settings ?? (await Settings.init());
		const disabledIds = sm ? ((sm.get("disabledExtensions") as string[]) ?? []) : [];
		this.#state = await createInitialState(this.cwd, disabledIds);

		// Calculate max visible items based on terminal height
		// Reserve ~10 lines for header, tabs, help text, borders
		const maxVisible = Math.max(5, Math.floor((this.terminalHeight - 10) / 2));

		// Create main list - always focused
		this.#mainList = new ExtensionList(
			this.#state.searchFiltered,
			{
				onSelectionChange: ext => {
					this.#state.selected = ext;
					this.#inspector.setExtension(ext);
				},
				onToggle: (extensionId, enabled) => {
					this.#handleExtensionToggle(extensionId, enabled);
				},
				onMasterToggle: providerId => {
					this.#handleProviderToggle(providerId);
				},
				masterSwitchProvider: this.#getActiveProviderId(),
			},
			maxVisible,
		);
		this.#mainList.setFocused(true);

		// Create inspector
		this.#inspector = new InspectorPanel();
		if (this.#state.selected) {
			this.#inspector.setExtension(this.#state.selected);
		}

		this.#buildLayout();
	}

	#getActiveProviderId(): string | null {
		const tab = this.#state.tabs[this.#state.activeTabIndex];
		return tab && tab.id !== "all" ? tab.id : null;
	}

	#buildLayout(): void {
		this.clear();
		if (this.#timeoutEditor) {
			this.addChild(this.#timeoutEditor);
			return;
		}

		// Top border
		this.addChild(new DynamicBorder());

		// Title
		this.addChild(new Text(theme.bold(theme.fg("accent", " Extension Control Center")), 0, 0));

		// Tab bar
		this.addChild(new Text(this.#renderTabBar(), 0, 0));
		this.addChild(new Spacer(1));

		// 2-column body with height limit
		// Reserve ~8 lines for header, tabs, help text, borders
		const bodyMaxHeight = Math.max(5, this.terminalHeight - 8);
		this.addChild(new TwoColumnBody(this.#mainList, this.#inspector, bodyMaxHeight));

		this.addChild(new Spacer(1));
		let helpText = " ↑/↓: navigate  Space: toggle  Tab: next provider  Esc: close";
		if (this.#getSelectedEditableMcpExtension()) {
			helpText += "  Ctrl+T: edit MCP timeout";
		}
		this.addChild(new Text(theme.fg("dim", helpText), 0, 0));
		if (this.#noticeLine) {
			this.addChild(new Text(this.#noticeLine, 0, 0));
		}

		// Bottom border
		this.addChild(new DynamicBorder());
	}

	#renderTabBar(): string {
		const parts: string[] = [" "];

		for (let i = 0; i < this.#state.tabs.length; i++) {
			const tab = this.#state.tabs[i];
			const isActive = i === this.#state.activeTabIndex;
			const isEmpty = tab.count === 0 && tab.id !== "all";
			const isDisabled = !tab.enabled && tab.id !== "all";

			let label = tab.label;
			if (tab.count > 0) {
				label += ` (${tab.count})`;
			}

			const displayLabel = isDisabled ? `${theme.status.disabled} ${label}` : label;

			if (isActive) {
				parts.push(theme.bg("selectedBg", ` ${displayLabel} `));
			} else if (isDisabled) {
				parts.push(theme.fg("dim", ` ${displayLabel} `));
			} else if (isEmpty) {
				parts.push(theme.fg("dim", ` ${label} `));
			} else {
				parts.push(theme.fg("muted", ` ${label} `));
			}
		}

		return parts.join("");
	}

	#getSelectedEditableMcpExtension(): Extension | null {
		const selected = this.#state.selected;
		if (!selected || selected.kind !== "mcp") return null;
		return selected.source.level === "user" || selected.source.level === "project" ? selected : null;
	}

	#closeTimeoutEditor(): void {
		this.#timeoutEditor?.dispose();
		this.#timeoutEditor = null;
		this.#buildLayout();
	}

	#openTimeoutEditor(extension: Extension): void {
		const mcp = extension.raw as MCPServer;
		const title = [
			`Set timeout for MCP server \`${extension.name}\``,
			`Current: ${formatMcpTimeoutDisplay(mcp.timeout)}`,
			"Enter milliseconds.",
			"Use `0` to disable the timeout.",
			"Leave empty to clear the override and fall back to the source config/default.",
		].join("\n\n");
		this.#timeoutEditor = new HookInputComponent(
			title,
			undefined,
			value => {
				void this.#submitTimeoutEdit(extension, value);
			},
			() => {
				this.#closeTimeoutEditor();
			},
		);
		this.#buildLayout();
	}

	async #submitTimeoutEdit(extension: Extension, value: string): Promise<void> {
		const trimmed = value.trim();
		const scope = extension.source.level;
		if (scope !== "user" && scope !== "project") {
			this.#noticeLine = theme.fg("warning", "This MCP source cannot store timeout overrides.");
			this.#closeTimeoutEditor();
			return;
		}

		let timeoutMs: number | undefined;
		if (trimmed) {
			const parsed = Number(trimmed);
			if (!Number.isInteger(parsed) || parsed < 0) {
				this.#noticeLine = theme.fg("warning", "Invalid MCP timeout. Use an integer >= 0.");
				this.#closeTimeoutEditor();
				return;
			}
			timeoutMs = parsed;
		}

		try {
			await setMcpTimeoutOverride({
				scope,
				cwd: this.cwd,
				sourcePath: extension.path,
				serverName: extension.name,
				timeoutMs,
			});
			await this.options.onMcpTimeoutUpdated?.();
			this.#noticeLine = theme.fg(
				"success",
				timeoutMs === undefined
					? `Cleared MCP timeout override for ${extension.name}.`
					: `Set MCP timeout for ${extension.name} to ${formatMcpTimeoutDisplay(timeoutMs)}.`,
			);
		} catch (error) {
			this.#noticeLine = theme.fg(
				"warning",
				`Failed to update MCP timeout: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		this.#closeTimeoutEditor();
		await this.#refreshFromState();
	}

	#handleProviderToggle(providerId: string): void {
		toggleProvider(providerId);
		void this.#refreshFromState();
	}

	#handleExtensionToggle(extensionId: string, enabled: boolean): void {
		const sm = this.settings ?? Settings.instance;
		if (!sm) return;

		const disabled = ((sm.get("disabledExtensions") as string[]) ?? []).slice();
		if (enabled) {
			const index = disabled.indexOf(extensionId);
			if (index !== -1) {
				disabled.splice(index, 1);
				sm.set("disabledExtensions", disabled);
			}
		} else {
			if (!disabled.includes(extensionId)) {
				disabled.push(extensionId);
				sm.set("disabledExtensions", disabled);
			}
		}

		void this.#refreshFromState();
	}

	async #refreshFromState(): Promise<void> {
		// Remember current tab ID before refresh
		const currentTabId = this.#state.tabs[this.#state.activeTabIndex]?.id;

		const sm = this.settings ?? Settings.instance;
		const disabledIds = sm ? ((sm.get("disabledExtensions") as string[]) ?? []) : [];
		this.#state = await refreshState(this.#state, this.cwd, disabledIds);

		// Find the same tab in the new (re-sorted) list
		if (currentTabId) {
			const newIndex = this.#state.tabs.findIndex(t => t.id === currentTabId);
			if (newIndex >= 0) {
				this.#state.activeTabIndex = newIndex;
			}
		}

		this.#mainList.setExtensions(this.#state.searchFiltered);
		this.#mainList.setMasterSwitchProvider(this.#getActiveProviderId());

		if (this.#state.selected) {
			this.#inspector.setExtension(this.#state.selected);
		}

		this.#buildLayout();
	}

	#switchTab(direction: 1 | -1): void {
		const numTabs = this.#state.tabs.length;
		if (numTabs === 0) return;

		// Find next selectable tab (skip empty+enabled providers)
		let nextIndex = this.#state.activeTabIndex;
		for (let i = 0; i < numTabs; i++) {
			nextIndex = (nextIndex + direction + numTabs) % numTabs;
			const tab = this.#state.tabs[nextIndex];
			const isEmptyEnabled = tab.count === 0 && tab.enabled && tab.id !== "all";
			if (!isEmptyEnabled) break;
		}
		this.#state.activeTabIndex = nextIndex;

		// Re-filter for new tab
		const tab = this.#state.tabs[this.#state.activeTabIndex];
		this.#state.tabFiltered = filterByProvider(this.#state.extensions, tab.id);
		this.#state.searchFiltered = applyFilter(this.#state.tabFiltered, this.#state.searchQuery);
		this.#state.listIndex = 0;
		this.#state.scrollOffset = 0;
		this.#state.selected = this.#state.searchFiltered[0] ?? null;

		// Update list
		this.#mainList.setExtensions(this.#state.searchFiltered);
		this.#mainList.setMasterSwitchProvider(this.#getActiveProviderId());
		this.#mainList.resetSelection();

		if (this.#state.selected) {
			this.#inspector.setExtension(this.#state.selected);
		}

		this.#buildLayout();
	}

	handleInput(data: string): void {
		if (this.#timeoutEditor) {
			this.#timeoutEditor.handleInput(data);
			return;
		}

		if (matchesKey(data, "ctrl+c")) {
			this.onClose?.();
			return;
		}

		if (matchesAppInterrupt(data)) {
			if (this.#state.searchQuery.length > 0) {
				this.#state.searchQuery = "";
				this.#state.searchFiltered = this.#state.tabFiltered;
				this.#mainList.setExtensions(this.#state.searchFiltered);
				this.#mainList.clearSearch();
				this.#buildLayout();
				return;
			}
			this.onClose?.();
			return;
		}

		if (matchesKey(data, "tab")) {
			this.#switchTab(1);
			return;
		}
		if (matchesKey(data, "shift+tab")) {
			this.#switchTab(-1);
			return;
		}

		if (matchesKey(data, "ctrl+t")) {
			const selectedMcp = this.#getSelectedEditableMcpExtension();
			if (selectedMcp) {
				this.#openTimeoutEditor(selectedMcp);
				return;
			}
		}

		this.#mainList.handleInput(data);

		const query = this.#mainList.getSearchQuery();
		if (query !== this.#state.searchQuery) {
			this.#state.searchQuery = query;
			this.#state.searchFiltered = applyFilter(this.#state.tabFiltered, query);
		}
	}
}

/**
 * Two-column body component for side-by-side rendering.
 */
class TwoColumnBody implements Component {
	constructor(
		private readonly leftPane: ExtensionList,
		private readonly rightPane: InspectorPanel,
		private readonly maxHeight: number,
	) {}

	render(width: number): string[] {
		const leftWidth = Math.floor(width * 0.5);
		const rightWidth = Math.max(0, width - leftWidth - 3);

		const leftLines = this.leftPane.render(leftWidth);
		const rightLines = this.rightPane.render(rightWidth);

		// Limit to maxHeight lines
		const numLines = Math.min(this.maxHeight, Math.max(leftLines.length, rightLines.length));
		const combined: string[] = [];
		const separator = theme.fg("dim", ` ${theme.boxSharp.vertical} `);

		for (let i = 0; i < numLines; i++) {
			const left = truncateToWidth(leftLines[i] ?? "", leftWidth);
			const leftPadded = left + padding(Math.max(0, leftWidth - visibleWidth(left)));
			const right = truncateToWidth(rightLines[i] ?? "", rightWidth);
			combined.push(leftPadded + separator + right);
		}

		return combined;
	}

	invalidate(): void {
		this.leftPane.invalidate?.();
		this.rightPane.invalidate?.();
	}
}
