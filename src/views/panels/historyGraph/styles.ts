/**
 * Static CSS for the history graph webview panel.
 *
 * Extracted from the inline template in historyGraphPanel.getHtml() so the
 * panel's HTML skeleton is actually readable. The one dynamic rule
 * (.graph-wrapper min-height) stays inline in getHtml() because it depends
 * on the computed total row height.
 *
 * Import this as a string and drop it into a `<style>` block verbatim,
 * alongside the shared `coreStyles` from webviewStyles.ts.
 */

export const historyGraphStyles = `
/* ── History graph view-specific styles ── */
.graph-svg { position: absolute; left: 0; top: 0; pointer-events: none; z-index: 1; }
.graph-col { flex-shrink: 0; }
.info-col {
	flex: 1; min-width: 0; padding: 2px 6px;
	display: flex; flex-direction: column; justify-content: center; gap: 1px;
	border-bottom: 1px solid var(--vscode-list-hoverBackground);
}
.row { display: flex; align-items: center; cursor: pointer; }
.row:hover .info-col, .row.hovered .info-col { background: var(--vscode-list-hoverBackground); }
.row.selected .info-col { background: var(--selection-bg); border-left: 3px solid var(--selection-border); }
.row.selected:hover .info-col, .row.selected.hovered .info-col { background: var(--selection-bg-hover); }
.row.selected .comment { color: #fff; }
.row.selected .meta { color: #ccc; }
.comment { font-size: var(--font-body); }
.meta { display: flex; align-items: center; gap: 6px; font-size: var(--font-caption); }
.cs-id { opacity: 0.7; }
.owner { max-width: 80px; }
.date { white-space: nowrap; }
/* SVG dot interactions */
.graph-svg circle { pointer-events: all; transition: r 0.15s ease, filter 0.15s ease; cursor: pointer; }
.graph-svg circle:hover, .graph-svg circle.hovered { r: 7; filter: drop-shadow(0 0 3px currentColor); }
circle.selected-dot { filter: drop-shadow(0 0 4px var(--selection-border)); stroke: var(--selection-border) !important; stroke-width: 2 !important; }
/* File list items use shared .list-item + .change-type */
.panel .panel-title { display: flex; align-items: center; }
.file-item { gap: 6px; padding: 2px 8px; font-size: var(--font-label); }
.file-item.is-folder { cursor: default; opacity: 0.75; }
.file-item.search-match { background: var(--vscode-editor-findMatchHighlightBackground, rgba(234, 92, 0, 0.33)); box-shadow: inset 2px 0 0 var(--vscode-editor-findMatchBorder, #ea5c00); }
.file-item.search-match:hover { background: var(--vscode-editor-findMatchBackground, rgba(234, 92, 0, 0.5)); }
.file-item .entry-letter { min-width: 18px; text-align: center; font-weight: bold; font-size: 10px; }
.file-item .folder-glyph { opacity: 0.8; }
.file-path { font-family: var(--vscode-editor-font-family); }
/* Search bar + filter pill */
.search-row {
	display: flex; align-items: center; gap: 4px; padding: 4px 6px;
	border-bottom: 1px solid var(--vscode-panel-border);
}
.search-row input[type="text"] {
	flex: 1; min-width: 0; padding: 2px 6px;
	background: var(--vscode-input-background);
	color: var(--vscode-input-foreground);
	border: 1px solid var(--vscode-input-border, transparent);
	font-size: var(--font-label);
	font-family: inherit;
}
.search-row input[type="text"]:focus {
	outline: 1px solid var(--vscode-focusBorder);
	border-color: var(--vscode-focusBorder);
}
.search-row button { padding: 2px 6px; font-size: 11px; }
.search-row button.pinned { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.filter-pill {
	display: flex; align-items: center; gap: 6px;
	padding: 3px 8px; margin: 4px 6px;
	background: var(--vscode-list-hoverBackground);
	border-left: 3px solid var(--selection-border, #007fd4);
	font-size: var(--font-label);
}
.filter-pill .pill-label { flex: 1; min-width: 0; }
.filter-pill .pill-close { cursor: pointer; padding: 0 4px; opacity: 0.7; }
.filter-pill .pill-close:hover { opacity: 1; }
`;
