/**
 * Shared CSS design tokens and utility classes for all webview panels.
 * Centralises VS Code theme integration, selection/hover states, typography,
 * and common layout patterns so every panel stays visually consistent.
 */

// ── Design tokens (CSS custom properties) ───────────────────────────
const TOKENS = `
:root {
	/* Selection */
	--selection-bg: rgba(0, 120, 212, 0.3);
	--selection-bg-hover: rgba(0, 120, 212, 0.35);
	--selection-border: #007fd4;

	/* Typography scale */
	--font-body: 12px;
	--font-label: 11px;
	--font-caption: 10px;

	/* Change-type colours */
	--color-added: #4ec9b0;
	--color-changed: #569cd6;
	--color-deleted: #d16969;
	--color-moved: #dcdcaa;
}
`;

// ── Reset & base body ───────────────────────────────────────────────
const BASE = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
	font-family: var(--vscode-font-family);
	font-size: var(--font-body);
	color: var(--vscode-foreground);
	background: var(--vscode-sideBar-background, var(--vscode-editor-background));
	overflow: hidden;
	display: flex; flex-direction: column; height: 100vh;
}
`;

// ── Utility classes ─────────────────────────────────────────────────
const UTILITIES = `
/* Text truncation */
.truncate { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* Muted description text */
.text-muted { color: var(--vscode-descriptionForeground); }

/* Monospace (code / IDs) */
.text-mono { font-family: var(--vscode-editor-font-family); }

/* Empty / placeholder state */
.empty { padding: 16px; text-align: center; color: var(--vscode-descriptionForeground); }
.loading { padding: 8px; text-align: center; color: var(--vscode-descriptionForeground); font-style: italic; }
`;

// ── Interactive list items (rows, file entries, etc.) ────────────────
const LIST_ITEMS = `
/* Base interactive item */
.list-item {
	display: flex; align-items: center; cursor: pointer;
}
.list-item:hover { background: var(--vscode-list-hoverBackground); }
.list-item.selected,
.list-item.selected:hover {
	background: var(--selection-bg);
	border-left: 3px solid var(--selection-border);
}
.list-item.selected:hover { background: var(--selection-bg-hover); }
.list-item.selected .text-muted { color: #ccc; }
`;

// ── Toolbar ─────────────────────────────────────────────────────────
const TOOLBAR = `
.toolbar {
	display: flex; align-items: center; gap: 4px;
	padding: 6px 8px;
	border-bottom: 1px solid var(--vscode-panel-border);
}
.toolbar select, .toolbar button {
	background: var(--vscode-input-background);
	color: var(--vscode-input-foreground);
	border: 1px solid var(--vscode-input-border, transparent);
	padding: 2px 6px; border-radius: 2px;
	font-size: var(--font-label);
	cursor: pointer;
}
.toolbar button:hover { background: var(--vscode-list-hoverBackground); }
.toggle-btn.active {
	background: var(--vscode-button-background);
	color: var(--vscode-button-foreground);
	border-color: var(--vscode-button-background);
}
`;

// ── Progress bar ────────────────────────────────────────────────────
const PROGRESS = `
.progress-bar {
	height: 2px; background: transparent; overflow: hidden;
	position: relative;
}
.progress-bar.active {
	background: var(--vscode-progressBar-background, var(--selection-border));
	animation: progress-indeterminate 1.5s infinite ease-in-out;
}
@keyframes progress-indeterminate {
	0%   { opacity: 0.3; }
	50%  { opacity: 1; }
	100% { opacity: 0.3; }
}
`;

// ── Change-type indicators ──────────────────────────────────────────
const CHANGE_TYPES = `
.change-type { width: 12px; text-align: center; font-weight: bold; font-size: var(--font-caption); }
.change-type.added   { color: var(--color-added); }
.change-type.changed { color: var(--color-changed); }
.change-type.deleted { color: var(--color-deleted); }
.change-type.moved   { color: var(--color-moved); }
`;

// ── Badge (branch labels, tags) ─────────────────────────────────────
const BADGE = `
.badge {
	border: 1px solid; border-radius: 8px; padding: 0 5px;
	font-size: var(--font-caption);
	white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
	max-width: 100px;
}
`;

// ── Panel (bottom detail panels) ────────────────────────────────────
const PANEL = `
.panel {
	border-top: 1px solid var(--vscode-panel-border);
	background: var(--vscode-editor-background);
	max-height: 200px; overflow-y: auto;
	padding: 4px 0;
}
.panel .panel-title {
	padding: 4px 8px; font-size: var(--font-label); font-weight: bold;
	color: var(--vscode-descriptionForeground);
}
`;

// ── Error page ──────────────────────────────────────────────────────
const ERROR = `
.err { text-align: center; padding: 16px; }
.err h3 { color: var(--vscode-errorForeground); margin-bottom: 8px; }
.err pre {
	background: var(--vscode-textBlockQuote-background);
	padding: 8px; border-radius: 4px; white-space: pre-wrap;
	font-size: var(--font-label);
}
.err button, .btn {
	background: var(--vscode-button-background);
	color: var(--vscode-button-foreground);
	border: none; padding: 6px 12px; border-radius: 2px;
	cursor: pointer; margin-top: 8px;
}
`;

// ── Scroll container ────────────────────────────────────────────────
const SCROLL = `
.scroll { overflow-y: auto; flex: 1; min-height: 0; }
`;

/**
 * Core stylesheet — includes everything except view-specific layout.
 * Embed as `<style>${coreStyles}</style>` in any webview HTML.
 */
export const coreStyles = [
	TOKENS, BASE, UTILITIES, LIST_ITEMS, TOOLBAR,
	PROGRESS, CHANGE_TYPES, BADGE, PANEL, ERROR, SCROLL,
].join('\n');

/**
 * Minimal stylesheet for error-only pages (smaller payload).
 */
export const errorStyles = [TOKENS, BASE, ERROR].join('\n');
