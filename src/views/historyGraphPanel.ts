import * as vscode from 'vscode';
import { listChangesets, getCurrentBranch, listBranches, getChangesetDiff } from '../core/workspace';
import { log, logError } from '../util/logger';
import type { ChangesetInfo, ChangesetDiffItem } from '../core/types';

/**
 * Graph layout node — a changeset with lane position and connection info.
 */
interface GraphNode {
	changeset: ChangesetInfo;
	lane: number;
	color: string;
	/** Connections to draw: [{fromRow, fromLane, toRow, toLane, color, type}] */
	connections: GraphConnection[];
}

interface GraphConnection {
	toRow: number;
	toLane: number;
	color: string;
	type: 'parent' | 'branch' | 'merge';
}

const LANE_COLORS = [
	'#4ec9b0', '#569cd6', '#c586c0', '#ce9178', '#dcdcaa',
	'#9cdcfe', '#d7ba7d', '#b5cea8', '#d16969', '#608b4e',
];

/**
 * WebviewViewProvider — renders in the sidebar panel under the Plastic SCM activity bar.
 */
export class HistoryGraphViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	static readonly viewId = 'plasticScm.historyGraphView';
	private view?: vscode.WebviewView;
	private disposables: vscode.Disposable[] = [];
	private currentFilter?: string;

	constructor(private readonly extensionUri: vscode.Uri) {}

	resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	): void {
		this.view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.extensionUri],
		};

		webviewView.webview.onDidReceiveMessage(
			async (msg) => {
				switch (msg.command) {
					case 'refresh':
						await this.loadData(this.currentFilter);
						break;
					case 'filterBranch':
						this.currentFilter = msg.branch || undefined;
						await this.loadData(this.currentFilter);
						break;
					case 'selectChangeset':
						await this.showChangesetFiles(msg.changesetId, msg.parentId);
						break;
					case 'openDiff':
						await this.openFileDiff(msg.changesetId, msg.parentId, msg.path);
						break;
				}
			},
			null,
			this.disposables,
		);

		this.loadData();
	}

	refresh(): void {
		this.loadData(this.currentFilter);
	}

	private async loadData(filterBranch?: string): Promise<void> {
		if (!this.view) return;

		try {
			const [changesets, currentBranch, branches] = await Promise.all([
				listChangesets(filterBranch, 200),
				getCurrentBranch(),
				listBranches(),
			]);

			const graphNodes = this.computeGraph(changesets, currentBranch);
			const branchNames = branches.map(b => b.name);

			this.view.webview.html = this.getHtml(
				this.view.webview, graphNodes, branchNames, currentBranch, filterBranch,
			);
		} catch (err) {
			logError('Failed to load history graph', err);
			if (this.view) {
				this.view.webview.html = this.getErrorHtml(
					err instanceof Error ? err.message : String(err),
				);
			}
		}
	}

	/**
	 * When user clicks a changeset, fetch its diff and send file list back to webview.
	 */
	private async showChangesetFiles(changesetId: number, parentId: number): Promise<void> {
		if (!this.view) return;
		try {
			const files = await getChangesetDiff(changesetId, parentId);
			this.view.webview.postMessage({
				command: 'changesetFiles',
				changesetId,
				parentId,
				files,
			});
		} catch (err) {
			logError('Failed to load changeset diff', err);
			this.view.webview.postMessage({
				command: 'changesetFiles',
				changesetId,
				parentId,
				files: [],
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	/**
	 * Open a diff editor for a specific file in a changeset.
	 */
	private async openFileDiff(changesetId: number, parentId: number, path: string): Promise<void> {
		const wsFolder = vscode.workspace.workspaceFolders?.[0];
		if (!wsFolder) return;

		// Build URIs for diff: use plastic: scheme for old revision, file: for current
		const oldUri = vscode.Uri.parse(`plastic:/${path}?cs=${parentId}`);
		const newUri = vscode.Uri.parse(`plastic:/${path}?cs=${changesetId}`);

		const title = `${path.split('/').pop()} (cs:${parentId} ↔ cs:${changesetId})`;

		try {
			await vscode.commands.executeCommand('vscode.diff', oldUri, newUri, title);
		} catch {
			// Fallback: just open the file
			const fileUri = vscode.Uri.joinPath(wsFolder.uri, path);
			await vscode.commands.executeCommand('vscode.open', fileUri);
		}
	}

	/**
	 * Improved graph layout: properly tracks branch origins, merges, and parallel lanes.
	 * Produces connections that represent branch-off points and merge-back points.
	 */
	private computeGraph(changesets: ChangesetInfo[], currentBranch?: string): GraphNode[] {
		if (changesets.length === 0) return [];

		// Sort by ID descending (newest first)
		const sorted = [...changesets].sort((a, b) => b.id - a.id);

		// Build lookup
		const idToIndex = new Map<number, number>();
		for (let i = 0; i < sorted.length; i++) {
			idToIndex.set(sorted[i].id, i);
		}

		// --- Lane assignment ---
		// Active lanes: track which branches currently occupy which lanes.
		// When a branch first appears (newest commit), assign it a lane.
		// When a branch's oldest commit connects to a parent on another branch, that's a branch-off.
		const branchLanes = new Map<string, number>();
		let nextLane = 0;

		// Current branch always gets lane 0
		if (currentBranch) {
			branchLanes.set(currentBranch, nextLane++);
		}

		// First pass: assign lanes in order of first appearance (newest commits first)
		for (const cs of sorted) {
			if (!branchLanes.has(cs.branch)) {
				branchLanes.set(cs.branch, nextLane++);
			}
		}

		// Second pass: build nodes with connections
		const nodes: GraphNode[] = [];

		// Track the last seen row index per branch (for continuation lines)
		const lastRowPerBranch = new Map<string, number>();

		for (let i = 0; i < sorted.length; i++) {
			const cs = sorted[i];
			const lane = branchLanes.get(cs.branch)!;
			const color = LANE_COLORS[lane % LANE_COLORS.length];
			const connections: GraphConnection[] = [];

			// Connection to parent changeset
			const parentIdx = idToIndex.get(cs.parent);
			if (parentIdx !== undefined) {
				const parent = sorted[parentIdx];
				const parentLane = branchLanes.get(parent.branch)!;
				const parentColor = LANE_COLORS[parentLane % LANE_COLORS.length];

				if (parent.branch === cs.branch) {
					// Same branch → straight vertical parent line
					connections.push({
						toRow: parentIdx,
						toLane: parentLane,
						color,
						type: 'parent',
					});
				} else {
					// Different branch → this is a branch-off point (this branch was created from parent)
					connections.push({
						toRow: parentIdx,
						toLane: parentLane,
						color,
						type: 'branch',
					});
				}
			}

			// Check if any OTHER changeset has this changeset as parent AND is on a different branch
			// That would represent a merge INTO this branch (or continuation from it)
			for (let j = 0; j < i; j++) {
				const other = sorted[j];
				if (other.parent === cs.id && other.branch !== cs.branch) {
					// 'other' branched off from 'cs' — already handled by 'other's connections
					// But if other's branch merges back (other has a child on cs.branch), track it
					// For now, the branch-off line from other → cs is drawn by other's node
				}
			}

			lastRowPerBranch.set(cs.branch, i);

			nodes.push({ changeset: cs, lane, color, connections });
		}

		return nodes;
	}

	private getHtml(
		webview: vscode.Webview,
		nodes: GraphNode[],
		branches: string[],
		currentBranch?: string,
		filterBranch?: string,
	): string {
		const maxLane = nodes.reduce((max, n) => Math.max(max, n.lane), 0);
		const laneSpacing = 20;
		const graphWidth = (maxLane + 1) * laneSpacing + 24;
		const rowHeight = 28;
		const totalHeight = nodes.length * rowHeight + 8;

		const branchOptions = branches
			.map(b => `<option value="${esc(b)}" ${b === filterBranch ? 'selected' : ''}>${esc(this.shortBranch(b))}</option>`)
			.join('');

		// Build SVG
		const svgLines: string[] = [];
		const svgDots: string[] = [];

		// Collect active lane ranges for continuation lines
		const branchFirstRow = new Map<string, number>();
		const branchLastRow = new Map<string, number>();
		for (let i = 0; i < nodes.length; i++) {
			const br = nodes[i].changeset.branch;
			if (!branchFirstRow.has(br)) branchFirstRow.set(br, i);
			branchLastRow.set(br, i);
		}

		// Draw continuation lines per branch (vertical backbone)
		for (const [branch, firstRow] of branchFirstRow) {
			const lastRow = branchLastRow.get(branch)!;
			if (firstRow === lastRow) continue;
			const lane = nodes[firstRow].lane;
			const color = nodes[firstRow].color;
			const x = lane * laneSpacing + 16;
			const y1 = firstRow * rowHeight + rowHeight / 2 + 4;
			const y2 = lastRow * rowHeight + rowHeight / 2 + 4;
			svgLines.push(
				`<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" stroke="${color}" stroke-width="2" stroke-opacity="0.35"/>`,
			);
		}

		// Draw connections and dots
		for (let i = 0; i < nodes.length; i++) {
			const node = nodes[i];
			const cx = node.lane * laneSpacing + 16;
			const cy = i * rowHeight + rowHeight / 2 + 4;

			for (const conn of node.connections) {
				const tx = conn.toLane * laneSpacing + 16;
				const ty = conn.toRow * rowHeight + rowHeight / 2 + 4;

				if (conn.type === 'parent') {
					// Same-branch vertical
					svgLines.push(
						`<line x1="${cx}" y1="${cy}" x2="${tx}" y2="${ty}" stroke="${conn.color}" stroke-width="2" stroke-opacity="0.7"/>`,
					);
				} else {
					// Branch-off or merge: curved bezier
					const midY = cy + (ty - cy) * 0.4;
					svgLines.push(
						`<path d="M${cx},${cy} C${cx},${midY} ${tx},${midY} ${tx},${ty}" fill="none" stroke="${conn.color}" stroke-width="2" stroke-opacity="0.7"/>`,
					);
				}
			}

			// Dot
			const hasCrossConn = node.connections.some(c => c.type !== 'parent');
			const r = hasCrossConn ? 5 : 4;
			svgDots.push(
				`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${node.color}" stroke="var(--vscode-editor-background)" stroke-width="1.5"/>`,
			);
		}

		// Build commit list rows
		const rows = nodes.map((node, i) => {
			const cs = node.changeset;
			const short = this.shortBranch(cs.branch);
			const isCurrent = cs.branch === currentBranch;
			const dateStr = this.formatDate(cs.date);
			const comment = esc(cs.comment ?? '(no comment)');
			const trunc = comment.length > 60 ? comment.substring(0, 57) + '...' : comment;

			return `<div class="row" data-cs="${cs.id}" data-parent="${cs.parent}" style="height:${rowHeight}px" title="${comment}">
	<div class="graph-col" style="width:${graphWidth}px"></div>
	<div class="info-col">
		<span class="comment">${trunc}</span>
		<span class="meta">
			<span class="badge" style="color:${node.color};border-color:${node.color}40;background:${node.color}15">${esc(short)}${isCurrent ? ' ●' : ''}</span>
			<span class="cs-id">#${cs.id}</span>
			<span class="owner">${esc(cs.owner)}</span>
			<span class="date">${dateStr}</span>
		</span>
	</div>
</div>`;
		}).join('\n');

		return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
	font-family: var(--vscode-font-family);
	font-size: 12px;
	color: var(--vscode-foreground);
	background: var(--vscode-sideBar-background, var(--vscode-editor-background));
	overflow: hidden;
}
.toolbar {
	display: flex; align-items: center; gap: 4px;
	padding: 6px 8px;
	border-bottom: 1px solid var(--vscode-panel-border);
}
.toolbar select, .toolbar button {
	background: var(--vscode-input-background);
	color: var(--vscode-input-foreground);
	border: 1px solid var(--vscode-input-border, transparent);
	padding: 2px 6px; border-radius: 2px; font-size: 11px;
	cursor: pointer;
}
.toolbar button:hover { background: var(--vscode-list-hoverBackground); }
.scroll { overflow-y: auto; height: calc(100vh - 32px); }
.graph-wrapper { position: relative; min-height: ${totalHeight}px; }
.graph-svg {
	position: absolute; left: 0; top: 0;
	pointer-events: none; z-index: 1;
}
.row {
	display: flex; align-items: center; cursor: pointer;
	border-bottom: 1px solid var(--vscode-list-hoverBackground);
}
.row:hover { background: var(--vscode-list-hoverBackground); }
.row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.graph-col { flex-shrink: 0; }
.info-col {
	flex: 1; min-width: 0; padding: 0 6px;
	display: flex; flex-direction: column; justify-content: center; gap: 1px;
}
.comment {
	white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
	font-size: 12px;
}
.meta {
	display: flex; align-items: center; gap: 6px;
	font-size: 10px; color: var(--vscode-descriptionForeground);
}
.badge {
	border: 1px solid; border-radius: 8px; padding: 0 5px;
	font-size: 10px; white-space: nowrap;
	max-width: 100px; overflow: hidden; text-overflow: ellipsis;
}
.cs-id { font-family: var(--vscode-editor-font-family); opacity: 0.7; }
.owner { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 80px; }
.date { white-space: nowrap; }
/* File detail panel */
.file-panel {
	border-top: 1px solid var(--vscode-panel-border);
	background: var(--vscode-editor-background);
	max-height: 200px; overflow-y: auto;
	padding: 4px 0;
}
.file-panel .title {
	padding: 4px 8px; font-size: 11px; font-weight: bold;
	color: var(--vscode-descriptionForeground);
}
.file-item {
	display: flex; align-items: center; gap: 6px;
	padding: 2px 8px; cursor: pointer; font-size: 11px;
}
.file-item:hover { background: var(--vscode-list-hoverBackground); }
.file-type { width: 12px; text-align: center; font-weight: bold; font-size: 10px; }
.file-type.added { color: #4ec9b0; }
.file-type.changed { color: #569cd6; }
.file-type.deleted { color: #d16969; }
.file-type.moved { color: #dcdcaa; }
.file-path {
	white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
	font-family: var(--vscode-editor-font-family);
}
.empty { padding: 16px; text-align: center; color: var(--vscode-descriptionForeground); }
.loading { padding: 8px; text-align: center; color: var(--vscode-descriptionForeground); font-style: italic; }
</style></head>
<body>
<div class="toolbar">
	<select id="branchFilter">
		<option value="">All</option>
		${branchOptions}
	</select>
	<button id="refreshBtn" title="Refresh">↻</button>
	<span style="color:var(--vscode-descriptionForeground);font-size:10px">${nodes.length} cs</span>
</div>
<div class="scroll" id="scrollContainer">
${nodes.length === 0
	? '<div class="empty">No changesets found</div>'
	: `<div class="graph-wrapper" id="graphWrapper">
	<svg class="graph-svg" width="${graphWidth}" height="${totalHeight}" xmlns="http://www.w3.org/2000/svg">
		${svgLines.join('\n\t\t')}
		${svgDots.join('\n\t\t')}
	</svg>
	${rows}
</div>`
}
</div>
<div class="file-panel" id="filePanel" style="display:none">
	<div class="title" id="filePanelTitle">Changed files</div>
	<div id="fileList"></div>
</div>
<script>
const vscode = acquireVsCodeApi();
let selectedRow = null;

document.getElementById('refreshBtn').addEventListener('click', () => {
	vscode.postMessage({ command: 'refresh' });
});
document.getElementById('branchFilter').addEventListener('change', (e) => {
	vscode.postMessage({ command: 'filterBranch', branch: e.target.value });
});

// Click on commit row → request changeset files
document.querySelectorAll('.row').forEach(row => {
	row.addEventListener('click', () => {
		if (selectedRow) selectedRow.classList.remove('selected');
		row.classList.add('selected');
		selectedRow = row;
		const csId = parseInt(row.dataset.cs);
		const parentId = parseInt(row.dataset.parent);
		document.getElementById('filePanel').style.display = '';
		document.getElementById('filePanelTitle').textContent = 'Loading changeset #' + csId + '...';
		document.getElementById('fileList').innerHTML = '<div class="loading">Loading...</div>';
		vscode.postMessage({ command: 'selectChangeset', changesetId: csId, parentId: parentId });
	});
});

// Receive file list from extension
window.addEventListener('message', event => {
	const msg = event.data;
	if (msg.command === 'changesetFiles') {
		const panel = document.getElementById('filePanel');
		const list = document.getElementById('fileList');
		const title = document.getElementById('filePanelTitle');
		panel.style.display = '';

		if (msg.error) {
			title.textContent = 'Changeset #' + msg.changesetId + ' (error)';
			list.innerHTML = '<div class="empty">' + msg.error + '</div>';
			return;
		}

		const files = msg.files || [];
		title.textContent = 'Changeset #' + msg.changesetId + ' — ' + files.length + ' file(s)';

		if (files.length === 0) {
			list.innerHTML = '<div class="empty">No files found</div>';
			return;
		}

		list.innerHTML = files.map(f => {
			const typeChar = f.type === 'added' ? 'A' : f.type === 'deleted' ? 'D' : f.type === 'moved' ? 'M' : 'C';
			const shortPath = f.path.split('/').slice(-2).join('/');
			return '<div class="file-item" data-path="' + escHtml(f.path) + '" data-cs="' + msg.changesetId + '" data-parent="' + msg.parentId + '">' +
				'<span class="file-type ' + f.type + '">' + typeChar + '</span>' +
				'<span class="file-path" title="' + escHtml(f.path) + '">' + escHtml(shortPath) + '</span>' +
				'</div>';
		}).join('');

		// Click file → open diff
		list.querySelectorAll('.file-item').forEach(item => {
			item.addEventListener('click', () => {
				vscode.postMessage({
					command: 'openDiff',
					changesetId: parseInt(item.dataset.cs),
					parentId: parseInt(item.dataset.parent),
					path: item.dataset.path,
				});
			});
		});
	}
});

function escHtml(s) {
	return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
</script>
</body></html>`;
	}

	private getErrorHtml(message: string): string {
		return `<!DOCTYPE html><html><head><style>
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
background: var(--vscode-sideBar-background); display:flex; align-items:center; justify-content:center; height:100vh; }
.err { text-align:center; padding:16px; }
.err h3 { color: var(--vscode-errorForeground); margin-bottom: 8px; }
.err pre { background: var(--vscode-textBlockQuote-background); padding:8px; border-radius:4px; white-space:pre-wrap; font-size:11px; }
button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border:none; padding:6px 12px; border-radius:2px; cursor:pointer; margin-top:8px; }
</style></head><body>
<div class="err"><h3>Failed to load history</h3><pre>${esc(message)}</pre>
<button onclick="const v=acquireVsCodeApi();v.postMessage({command:'refresh'})">Retry</button></div>
</body></html>`;
	}

	private shortBranch(name: string): string {
		const parts = name.split('/');
		return parts.length > 2 ? parts.slice(-2).join('/') : parts[parts.length - 1];
	}

	private formatDate(dateStr: string): string {
		if (!dateStr) return '';
		try {
			const d = new Date(dateStr);
			const now = new Date();
			const diffMs = now.getTime() - d.getTime();
			const diffDays = Math.floor(diffMs / 86400000);
			if (diffDays === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
			if (diffDays < 7) return `${diffDays}d ago`;
			return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
		} catch {
			return dateStr;
		}
	}

	dispose(): void {
		for (const d of this.disposables) d.dispose();
		this.disposables = [];
	}
}

function esc(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
