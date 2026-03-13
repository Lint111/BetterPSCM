import * as vscode from 'vscode';
import { listChangesets, getCurrentBranch, getChangesetDiff } from '../core/workspace';
import { log, logError } from '../util/logger';
import { buildPlasticUri } from '../util/uri';
import { LruCache, TtlCache } from '../util/cache';
import { getWorkspaceGuid } from '../api/client';
import { coreStyles, errorStyles } from './webviewStyles';
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
	/** Cache changeset diff results — changeset content is immutable */
	private readonly diffCache = new LruCache<number, { parentId: number; files: ChangesetDiffItem[] }>(100);
	/** Cache graph data keyed by filter ('' = all, branch name = filtered) */
	private readonly graphCache = new TtlCache<string, { changesets: ChangesetInfo[]; currentBranch?: string }>(30_000);

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
					case 'focusCurrentBranch': {
						try {
							log('[HistoryGraph] focusCurrentBranch requested');
							// Use cached branch from the "all" query if available
							const allCached = this.graphCache.get('');
							const branch = allCached?.currentBranch ?? await getCurrentBranch();
							log(`[HistoryGraph] current branch: ${branch}`);
							this.currentFilter = branch || undefined;
							await this.loadData(this.currentFilter);
						} catch (err) {
							logError('Failed to get current branch for focus', err);
							await this.loadData();
						}
						break;
					}
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
		this.graphCache.clear();
		this.loadData(this.currentFilter);
	}

	private async loadData(filterBranch?: string): Promise<void> {
		if (!this.view) return;

		const cacheKey = filterBranch || '';
		const cached = this.graphCache.get(cacheKey);

		let changesets: ChangesetInfo[];
		let currentBranch: string | undefined;

		if (cached) {
			log(`[HistoryGraph] cache hit for filter="${cacheKey}" (${cached.changesets.length} cs)`);
			changesets = cached.changesets;
			currentBranch = cached.currentBranch;
		} else {
			// Show loading state only for actual fetches
			this.view.webview.postMessage({ command: 'loading', active: true });

			try {
				[changesets, currentBranch] = await Promise.all([
					listChangesets(filterBranch, 200),
					getCurrentBranch(),
				]);
				this.graphCache.set(cacheKey, { changesets, currentBranch });
			} catch (err) {
				logError('Failed to load history graph', err);
				if (this.view) {
					this.view.webview.html = this.getErrorHtml(
						err instanceof Error ? err.message : String(err),
					);
				}
				return;
			}
		}

		const graphNodes = this.computeGraph(changesets, currentBranch);

		this.view.webview.html = this.getHtml(
			this.view.webview, graphNodes, currentBranch, filterBranch,
		);
	}

	/**
	 * When user clicks a changeset, fetch its diff and send file list back to webview.
	 * Results are cached since changeset content is immutable.
	 */
	private async showChangesetFiles(changesetId: number, parentId: number): Promise<void> {
		if (!this.view) return;
		log(`[HistoryGraph] selectChangeset: cs=${changesetId}, parent=${parentId}`);

		// Check cache first
		const cached = this.diffCache.get(changesetId);
		if (cached) {
			log(`[HistoryGraph] cache hit for cs=${changesetId} (${cached.files.length} files)`);
			this.view.webview.postMessage({
				command: 'changesetFiles',
				changesetId,
				parentId: cached.parentId,
				files: cached.files,
			});
			return;
		}

		try {
			const effectiveParent = (parentId && parentId > 0) ? parentId : Math.max(changesetId - 1, 0);
			const files = await getChangesetDiff(changesetId, effectiveParent);
			log(`[HistoryGraph] got ${files.length} files for cs=${changesetId}`);

			this.diffCache.set(changesetId, { parentId: effectiveParent, files });

			this.view.webview.postMessage({
				command: 'changesetFiles',
				changesetId,
				parentId: effectiveParent,
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
	 * Uses cm cat with serverpath:/path#cs:N format to fetch revision content.
	 */
	private async openFileDiff(changesetId: number, parentId: number, path: string): Promise<void> {
		const wsFolder = vscode.workspace.workspaceFolders?.[0];
		if (!wsFolder) return;

		log(`[HistoryGraph] openFileDiff: path=${path}, cs=${changesetId}, parent=${parentId}`);

		try {
			const wsGuid = getWorkspaceGuid();

			// Build plastic: URIs using the serverpath#cs:N format that cm cat understands
			const normalizedPath = path.replace(/\\/g, '/');
			const serverPath = normalizedPath.startsWith('/') ? normalizedPath : `/${normalizedPath}`;

			const oldRevSpec = `serverpath:${serverPath}#cs:${parentId}`;
			const newRevSpec = `serverpath:${serverPath}#cs:${changesetId}`;

			const oldUri = buildPlasticUri(wsGuid, oldRevSpec, normalizedPath);
			const newUri = buildPlasticUri(wsGuid, newRevSpec, normalizedPath);

			const fileName = normalizedPath.split('/').pop() ?? normalizedPath;
			const title = `${fileName} (cs:${parentId} ↔ cs:${changesetId})`;

			// Enable hiding unchanged regions for cleaner diffs
			const diffConfig = vscode.workspace.getConfiguration('diffEditor');
			if (!diffConfig.get<boolean>('hideUnchangedRegions.enabled')) {
				await diffConfig.update('hideUnchangedRegions.enabled', true, vscode.ConfigurationTarget.Global);
			}

			await vscode.commands.executeCommand('vscode.diff', oldUri, newUri, title);
		} catch (err) {
			logError('Failed to open diff', err);
			// Fallback: open the workspace file
			try {
				const fileUri = vscode.Uri.joinPath(wsFolder.uri, path);
				await vscode.commands.executeCommand('vscode.open', fileUri);
			} catch {
				// Silently fail — file may not exist in workspace
			}
		}
	}

	/**
	 * Improved graph layout: properly tracks branch origins, merges, and parallel lanes.
	 * Produces connections that represent branch-off points and merge-back points.
	 *
	 * Handles orphaned branches by inferring parent branch from naming hierarchy
	 * (e.g., /main/Tech/VFX → parent branch is /main/Tech) and connecting to the
	 * nearest changeset on that parent branch.
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

		// Build per-branch changeset lists (sorted by ID desc within each branch)
		const branchChangesets = new Map<string, number[]>();
		for (let i = 0; i < sorted.length; i++) {
			const br = sorted[i].branch;
			if (!branchChangesets.has(br)) branchChangesets.set(br, []);
			branchChangesets.get(br)!.push(i);
		}

		// --- Lane assignment ---
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

		// Track which branches have their origin connected
		const branchOriginConnected = new Set<string>();

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

				if (parent.branch === cs.branch) {
					// Same branch → straight vertical parent line
					connections.push({
						toRow: parentIdx,
						toLane: parentLane,
						color,
						type: 'parent',
					});
				} else {
					// Different branch → this is a branch-off point
					connections.push({
						toRow: parentIdx,
						toLane: parentLane,
						color,
						type: 'branch',
					});
					branchOriginConnected.add(cs.branch);
				}
			}

			nodes.push({ changeset: cs, lane, color, connections });
		}

		// Third pass: fix orphaned branches
		// For each branch whose oldest changeset has no visible parent connection,
		// infer the parent branch from naming hierarchy and connect to nearest changeset
		for (const [branch, rowIndices] of branchChangesets) {
			if (branchOriginConnected.has(branch)) continue;

			// Find the oldest changeset on this branch (last in the row list since sorted desc)
			const oldestRowIdx = rowIndices[rowIndices.length - 1];
			const oldestCs = sorted[oldestRowIdx];

			// Already has a parent connection in the loaded set?
			if (idToIndex.has(oldestCs.parent)) continue;

			// Infer parent branch from naming hierarchy
			const parentBranch = this.inferParentBranch(branch, branchChangesets);
			if (!parentBranch) continue;

			const parentLane = branchLanes.get(parentBranch);
			if (parentLane === undefined) continue;

			// Find the nearest changeset on the parent branch by ID
			// We want the parent branch changeset closest to (and ideally <= ) oldestCs.id
			const parentRows = branchChangesets.get(parentBranch)!;
			let bestRow = -1;
			let bestDist = Infinity;

			for (const pRow of parentRows) {
				const pCs = sorted[pRow];
				// Prefer parent changesets that are older (higher row = lower ID)
				const dist = Math.abs(pCs.id - oldestCs.id);
				if (pCs.id <= oldestCs.id && dist < bestDist) {
					bestDist = dist;
					bestRow = pRow;
				}
			}

			// If no older changeset found, use the closest one overall
			if (bestRow === -1) {
				for (const pRow of parentRows) {
					const dist = Math.abs(sorted[pRow].id - oldestCs.id);
					if (dist < bestDist) {
						bestDist = dist;
						bestRow = pRow;
					}
				}
			}

			if (bestRow >= 0) {
				const parentColor = LANE_COLORS[parentLane % LANE_COLORS.length];
				nodes[oldestRowIdx].connections.push({
					toRow: bestRow,
					toLane: parentLane,
					color: nodes[oldestRowIdx].color,
					type: 'branch',
				});
			}
		}

		return nodes;
	}

	/**
	 * Infer the parent branch from naming hierarchy.
	 * e.g., "/main/Tech/VFX" → "/main/Tech" → "/main"
	 * Returns the first ancestor branch name that exists in the loaded set.
	 */
	private inferParentBranch(branch: string, branchChangesets: Map<string, number[]>): string | undefined {
		const parts = branch.split('/');
		// Try progressively shorter paths: /main/Tech/VFX → /main/Tech → /main
		for (let len = parts.length - 1; len >= 1; len--) {
			const candidate = parts.slice(0, len).join('/');
			if (candidate && branchChangesets.has(candidate)) {
				return candidate;
			}
		}
		return undefined;
	}

	private getHtml(
		webview: vscode.Webview,
		nodes: GraphNode[],
		currentBranch?: string,
		filterBranch?: string,
	): string {
		const maxLane = nodes.reduce((max, n) => Math.max(max, n.lane), 0);
		const laneSpacing = 20;
		const graphWidth = (maxLane + 1) * laneSpacing + 24;
		const rowHeight = 28;
		const totalHeight = nodes.length * rowHeight + 8;

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
		<span class="comment truncate">${trunc}</span>
		<span class="meta text-muted">
			<span class="badge" style="color:${node.color};border-color:${node.color}40;background:${node.color}15">${esc(short)}${isCurrent ? ' ●' : ''}</span>
			<span class="cs-id text-mono">#${cs.id}</span>
			<span class="owner truncate">${esc(cs.owner)}</span>
			<span class="date">${dateStr}</span>
		</span>
	</div>
</div>`;
		}).join('\n');

		return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
${coreStyles}
/* ── History graph view-specific styles ── */
.graph-wrapper { position: relative; min-height: ${totalHeight}px; }
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
.file-item { gap: 6px; padding: 2px 8px; font-size: var(--font-label); }
.file-path { font-family: var(--vscode-editor-font-family); }
</style></head>
<body>
<div class="progress-bar" id="progressBar"></div>
<div class="toolbar">
	<button id="focusBtn" class="toggle-btn ${filterBranch ? 'active' : ''}" title="Show current branch only">⎇ Branch</button>
	<button id="allBtn" class="toggle-btn ${!filterBranch ? 'active' : ''}" title="Show all branches">◎ All</button>
	<button id="refreshBtn" title="Refresh">↻</button>
	<span style="color:var(--vscode-descriptionForeground);font-size:10px;margin-left:auto">${nodes.length} cs</span>
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
<div class="panel" id="filePanel" style="display:none">
	<div class="panel-title" id="filePanelTitle">Changed files</div>
	<div id="fileList"></div>
</div>
<script>
const vscode = acquireVsCodeApi();
let selectedRow = null;

function showLoading() {
	document.getElementById('progressBar').classList.add('active');
}
document.getElementById('refreshBtn').addEventListener('click', () => {
	showLoading();
	vscode.postMessage({ command: 'refresh' });
});
document.getElementById('focusBtn').addEventListener('click', () => {
	showLoading();
	vscode.postMessage({ command: 'focusCurrentBranch' });
});
document.getElementById('allBtn').addEventListener('click', () => {
	showLoading();
	vscode.postMessage({ command: 'filterBranch', branch: '' });
});

// Cross-hover: row ↔ dot
const allRowsList = document.querySelectorAll('.row');
const allDots = document.querySelectorAll('.graph-svg circle');
allDots.forEach(dot => { dot.dataset.origR = dot.getAttribute('r') || '4'; });
allRowsList.forEach((row, idx) => {
	row.addEventListener('mouseenter', () => {
		if (idx < allDots.length) { allDots[idx].classList.add('hovered'); allDots[idx].setAttribute('r', '7'); }
	});
	row.addEventListener('mouseleave', () => {
		if (idx < allDots.length && !allDots[idx].classList.contains('selected-dot')) {
			allDots[idx].classList.remove('hovered');
			allDots[idx].setAttribute('r', allDots[idx].dataset.origR || '4');
		}
	});
});
allDots.forEach((dot, idx) => {
	dot.addEventListener('mouseenter', () => {
		if (idx < allRowsList.length) allRowsList[idx].classList.add('hovered');
	});
	dot.addEventListener('mouseleave', () => {
		if (idx < allRowsList.length) allRowsList[idx].classList.remove('hovered');
	});
});

// Click on commit row → request changeset files
document.querySelectorAll('.row').forEach(row => {
	row.addEventListener('click', () => {
		if (selectedRow) {
			selectedRow.classList.remove('selected');
			const prevInfo = selectedRow.querySelector('.info-col');
			if (prevInfo) { prevInfo.style.background = ''; prevInfo.style.borderLeft = ''; }
			// Reset previous SVG dot
			const prevDot = document.querySelector('.graph-svg circle.selected-dot');
			if (prevDot) { prevDot.classList.remove('selected-dot'); prevDot.setAttribute('r', prevDot.dataset.origR || '4'); }
		}
		row.classList.add('selected');
		const infoCol = row.querySelector('.info-col');
		if (infoCol) { infoCol.style.background = 'rgba(0, 120, 212, 0.3)'; infoCol.style.borderLeft = '3px solid #007fd4'; }
		// Highlight the SVG dot for this row
		const rowIdx = Array.from(document.querySelectorAll('.row')).indexOf(row);
		const dots = document.querySelectorAll('.graph-svg circle');
		if (rowIdx >= 0 && rowIdx < dots.length) {
			const dot = dots[rowIdx];
			dot.dataset.origR = dot.getAttribute('r') || '4';
			dot.classList.add('selected-dot');
			dot.setAttribute('r', '7');
		}
		selectedRow = row;
		const csId = parseInt(row.dataset.cs);
		const parentId = parseInt(row.dataset.parent);
		document.getElementById('filePanel').style.display = '';
		document.getElementById('filePanelTitle').textContent = 'Loading changeset #' + csId + '...';
		document.getElementById('fileList').innerHTML = '<div class="loading">Loading...</div>';
		vscode.postMessage({ command: 'selectChangeset', changesetId: csId, parentId: parentId });
	});
});

// Click on SVG dot → trigger corresponding row click
const allRows = document.querySelectorAll('.row');
document.querySelectorAll('.graph-svg circle').forEach((dot, idx) => {
	dot.addEventListener('click', () => {
		if (idx < allRows.length) allRows[idx].click();
	});
});

// Receive messages from extension
window.addEventListener('message', event => {
	const msg = event.data;
	if (msg.command === 'loading') {
		const bar = document.getElementById('progressBar');
		if (msg.active) { bar.classList.add('active'); } else { bar.classList.remove('active'); }
		return;
	}
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
			return '<div class="list-item file-item" data-path="' + escHtml(f.path) + '" data-cs="' + msg.changesetId + '" data-parent="' + msg.parentId + '">' +
				'<span class="change-type ' + f.type + '">' + typeChar + '</span>' +
				'<span class="file-path truncate" title="' + escHtml(f.path) + '">' + escHtml(shortPath) + '</span>' +
				'</div>';
		}).join('');

		// Click file → open diff + highlight
		let selectedFile = null;
		list.querySelectorAll('.file-item').forEach(item => {
			item.addEventListener('click', () => {
				if (selectedFile) selectedFile.classList.remove('selected');
				item.classList.add('selected');
				selectedFile = item;
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
${errorStyles}
body { align-items:center; justify-content:center; }
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
