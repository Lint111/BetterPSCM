import * as vscode from 'vscode';
import { listChangesets, getCurrentBranch, listBranches } from '../core/workspace';
import { logError } from '../util/logger';
import type { ChangesetInfo } from '../core/types';

/**
 * Graph layout node — a changeset with lane and connection info for rendering.
 */
interface GraphNode {
	changeset: ChangesetInfo;
	lane: number;
	parentLane: number | null;
	isMerge: boolean;
	color: string;
}

const LANE_COLORS = [
	'#4ec9b0', // teal (current branch)
	'#569cd6', // blue
	'#c586c0', // purple
	'#ce9178', // orange
	'#dcdcaa', // yellow
	'#9cdcfe', // light blue
	'#d7ba7d', // tan
	'#b5cea8', // light green
	'#d16969', // red
	'#608b4e', // green
];

export class HistoryGraphPanel implements vscode.Disposable {
	private static currentPanel: HistoryGraphPanel | undefined;
	private readonly panel: vscode.WebviewPanel;
	private disposables: vscode.Disposable[] = [];
	private currentBranch: string | undefined;

	private constructor(panel: vscode.WebviewPanel, private extensionUri: vscode.Uri) {
		this.panel = panel;

		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

		this.panel.webview.onDidReceiveMessage(
			async (msg) => {
				if (msg.command === 'refresh') {
					await this.loadData();
				} else if (msg.command === 'filterBranch') {
					await this.loadData(msg.branch || undefined);
				}
			},
			null,
			this.disposables,
		);

		this.loadData();
	}

	static show(extensionUri: vscode.Uri): HistoryGraphPanel {
		if (HistoryGraphPanel.currentPanel) {
			HistoryGraphPanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
			return HistoryGraphPanel.currentPanel;
		}

		const panel = vscode.window.createWebviewPanel(
			'plasticScm.historyGraph',
			'Plastic SCM History',
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
			},
		);

		HistoryGraphPanel.currentPanel = new HistoryGraphPanel(panel, extensionUri);
		return HistoryGraphPanel.currentPanel;
	}

	private async loadData(filterBranch?: string): Promise<void> {
		try {
			const [changesets, currentBranch, branches] = await Promise.all([
				listChangesets(filterBranch, 200),
				getCurrentBranch(),
				listBranches(),
			]);

			this.currentBranch = currentBranch;

			const graphNodes = this.computeGraph(changesets, currentBranch);
			const branchNames = branches.map(b => b.name);

			this.panel.webview.html = this.getHtml(graphNodes, branchNames, currentBranch, filterBranch);
		} catch (err) {
			logError('Failed to load history graph', err);
			this.panel.webview.html = this.getErrorHtml(
				err instanceof Error ? err.message : String(err),
			);
		}
	}

	/**
	 * Assign lanes to changesets for visual graph layout.
	 * Groups by branch, sorts newest-first, and tracks parallel branch lanes.
	 */
	private computeGraph(changesets: ChangesetInfo[], currentBranch?: string): GraphNode[] {
		if (changesets.length === 0) return [];

		// Sort by ID descending (newest first)
		const sorted = [...changesets].sort((a, b) => b.id - a.id);

		// Assign lanes per branch
		const branchLanes = new Map<string, number>();
		let nextLane = 0;

		// Current branch always gets lane 0
		if (currentBranch) {
			branchLanes.set(currentBranch, nextLane++);
		}

		// Build parent lookup
		const changesetById = new Map<number, ChangesetInfo>();
		for (const cs of sorted) {
			changesetById.set(cs.id, cs);
		}

		const nodes: GraphNode[] = [];

		for (const cs of sorted) {
			let lane = branchLanes.get(cs.branch);
			if (lane === undefined) {
				lane = nextLane++;
				branchLanes.set(cs.branch, lane);
			}

			const parent = changesetById.get(cs.parent);
			let parentLane: number | null = null;
			if (parent) {
				parentLane = branchLanes.get(parent.branch) ?? null;
			}

			// A merge is when the parent is on a different branch
			const isMerge = parent !== undefined && parent.branch !== cs.branch;

			nodes.push({
				changeset: cs,
				lane,
				parentLane,
				isMerge,
				color: LANE_COLORS[lane % LANE_COLORS.length],
			});
		}

		return nodes;
	}

	private getHtml(nodes: GraphNode[], branches: string[], currentBranch?: string, filterBranch?: string): string {
		const maxLane = nodes.reduce((max, n) => Math.max(max, n.lane), 0);
		const graphWidth = (maxLane + 1) * 24 + 16;
		const rowHeight = 32;

		const branchOptions = branches
			.map(b => `<option value="${this.escapeHtml(b)}" ${b === filterBranch ? 'selected' : ''}>${this.escapeHtml(b)}</option>`)
			.join('');

		// Build SVG graph lines and dots
		const svgElements: string[] = [];
		const totalHeight = nodes.length * rowHeight + 8;

		for (let i = 0; i < nodes.length; i++) {
			const node = nodes[i];
			const cx = node.lane * 24 + 20;
			const cy = i * rowHeight + rowHeight / 2 + 4;

			// Draw line to parent (next row in same lane, or cross-lane for merges)
			if (node.parentLane !== null) {
				const parentIdx = nodes.findIndex(n => n.changeset.id === node.changeset.parent);
				if (parentIdx >= 0) {
					const px = node.parentLane * 24 + 20;
					const py = parentIdx * rowHeight + rowHeight / 2 + 4;

					if (node.lane === node.parentLane) {
						// Straight vertical line
						svgElements.push(
							`<line x1="${cx}" y1="${cy}" x2="${px}" y2="${py}" stroke="${node.color}" stroke-width="2" stroke-opacity="0.6"/>`,
						);
					} else {
						// Curved merge/branch line
						const midY = (cy + py) / 2;
						svgElements.push(
							`<path d="M${cx},${cy} C${cx},${midY} ${px},${midY} ${px},${py}" fill="none" stroke="${node.color}" stroke-width="2" stroke-opacity="0.6"/>`,
						);
					}
				}
			}

			// Draw vertical continuation lines for active lanes
			if (i < nodes.length - 1) {
				const nextY = (i + 1) * rowHeight + rowHeight / 2 + 4;
				// Find if any future node uses this lane
				for (let j = i + 1; j < nodes.length; j++) {
					if (nodes[j].lane === node.lane) {
						// Draw continuation from current to next same-lane node
						const targetY = j * rowHeight + rowHeight / 2 + 4;
						svgElements.push(
							`<line x1="${cx}" y1="${cy}" x2="${cx}" y2="${targetY}" stroke="${node.color}" stroke-width="2" stroke-opacity="0.3"/>`,
						);
						break;
					}
				}
			}

			// Draw commit dot
			const dotRadius = node.isMerge ? 6 : 4;
			svgElements.push(
				`<circle cx="${cx}" cy="${cy}" r="${dotRadius}" fill="${node.color}" stroke="${node.color}" stroke-width="2"/>`,
			);

			// Draw merge diamond instead of circle
			if (node.isMerge) {
				svgElements.push(
					`<circle cx="${cx}" cy="${cy}" r="3" fill="var(--vscode-editor-background)"/>`,
				);
			}
		}

		// Build table rows
		const rows = nodes.map((node, i) => {
			const cs = node.changeset;
			const shortBranch = cs.branch.split('/').slice(-1)[0];
			const isCurrent = cs.branch === currentBranch;
			const dateStr = cs.date ? new Date(cs.date).toLocaleString() : '';
			const comment = this.escapeHtml(cs.comment ?? '(no comment)');
			const truncComment = comment.length > 80 ? comment.substring(0, 77) + '...' : comment;

			return `<tr class="commit-row" style="height: ${rowHeight}px">
				<td class="graph-cell" style="width: ${graphWidth}px"></td>
				<td class="id-cell">${cs.id}</td>
				<td class="comment-cell" title="${comment}">${truncComment}</td>
				<td class="branch-cell">
					<span class="branch-badge" style="background: ${node.color}20; color: ${node.color}; border: 1px solid ${node.color}40">
						${this.escapeHtml(shortBranch)}${isCurrent ? ' ●' : ''}
					</span>
				</td>
				<td class="owner-cell">${this.escapeHtml(cs.owner)}</td>
				<td class="date-cell">${dateStr}</td>
			</tr>`;
		}).join('');

		return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
	body {
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size);
		color: var(--vscode-foreground);
		background: var(--vscode-editor-background);
		margin: 0;
		padding: 0;
		overflow: hidden;
	}
	.toolbar {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		border-bottom: 1px solid var(--vscode-panel-border);
		background: var(--vscode-sideBar-background);
	}
	.toolbar select, .toolbar button {
		background: var(--vscode-input-background);
		color: var(--vscode-input-foreground);
		border: 1px solid var(--vscode-input-border);
		padding: 4px 8px;
		border-radius: 2px;
		font-size: var(--vscode-font-size);
	}
	.toolbar button:hover {
		background: var(--vscode-button-hoverBackground);
	}
	.toolbar label {
		color: var(--vscode-descriptionForeground);
	}
	.scroll-container {
		overflow: auto;
		height: calc(100vh - 45px);
		position: relative;
	}
	.graph-table-wrapper {
		position: relative;
		display: flex;
	}
	.graph-svg {
		position: absolute;
		left: 0;
		top: 0;
		pointer-events: none;
		z-index: 1;
	}
	table {
		border-collapse: collapse;
		width: 100%;
		table-layout: fixed;
	}
	tr.commit-row {
		border-bottom: 1px solid var(--vscode-list-hoverBackground);
	}
	tr.commit-row:hover {
		background: var(--vscode-list-hoverBackground);
	}
	td {
		padding: 0 8px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		vertical-align: middle;
	}
	.graph-cell {
		min-width: ${graphWidth}px;
		max-width: ${graphWidth}px;
	}
	.id-cell {
		width: 60px;
		color: var(--vscode-descriptionForeground);
		font-family: var(--vscode-editor-font-family);
		font-size: 11px;
	}
	.comment-cell {
		min-width: 200px;
	}
	.branch-cell {
		width: 150px;
	}
	.branch-badge {
		display: inline-block;
		padding: 1px 6px;
		border-radius: 10px;
		font-size: 11px;
		max-width: 130px;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.owner-cell {
		width: 120px;
		color: var(--vscode-descriptionForeground);
	}
	.date-cell {
		width: 160px;
		color: var(--vscode-descriptionForeground);
		font-size: 11px;
	}
	.empty-state {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 200px;
		color: var(--vscode-descriptionForeground);
	}
</style>
</head>
<body>
	<div class="toolbar">
		<label>Branch:</label>
		<select id="branchFilter">
			<option value="">All branches</option>
			${branchOptions}
		</select>
		<button id="refreshBtn">↻ Refresh</button>
		${nodes.length > 0 ? `<span style="color: var(--vscode-descriptionForeground)">${nodes.length} changesets</span>` : ''}
	</div>
	<div class="scroll-container">
		${nodes.length === 0
			? '<div class="empty-state">No changesets found</div>'
			: `<div class="graph-table-wrapper">
				<svg class="graph-svg" width="${graphWidth}" height="${totalHeight}" xmlns="http://www.w3.org/2000/svg">
					${svgElements.join('\n\t\t\t\t\t')}
				</svg>
				<table>
					${rows}
				</table>
			</div>`
		}
	</div>
	<script>
		const vscode = acquireVsCodeApi();
		document.getElementById('refreshBtn').addEventListener('click', () => {
			vscode.postMessage({ command: 'refresh' });
		});
		document.getElementById('branchFilter').addEventListener('change', (e) => {
			vscode.postMessage({ command: 'filterBranch', branch: e.target.value });
		});
	</script>
</body>
</html>`;
	}

	private getErrorHtml(message: string): string {
		return `<!DOCTYPE html>
<html>
<head>
<style>
	body {
		font-family: var(--vscode-font-family);
		color: var(--vscode-foreground);
		background: var(--vscode-editor-background);
		display: flex;
		align-items: center;
		justify-content: center;
		height: 100vh;
		margin: 0;
	}
	.error {
		text-align: center;
		padding: 24px;
	}
	.error h2 { color: var(--vscode-errorForeground); }
	.error pre {
		background: var(--vscode-textBlockQuote-background);
		padding: 12px;
		border-radius: 4px;
		white-space: pre-wrap;
		max-width: 600px;
	}
	button {
		background: var(--vscode-button-background);
		color: var(--vscode-button-foreground);
		border: none;
		padding: 8px 16px;
		border-radius: 2px;
		cursor: pointer;
		margin-top: 12px;
	}
</style>
</head>
<body>
	<div class="error">
		<h2>Failed to load history</h2>
		<pre>${this.escapeHtml(message)}</pre>
		<button onclick="const vscode = acquireVsCodeApi(); vscode.postMessage({command:'refresh'})">Retry</button>
	</div>
</body>
</html>`;
	}

	private escapeHtml(s: string): string {
		return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}

	dispose(): void {
		HistoryGraphPanel.currentPanel = undefined;
		this.panel.dispose();
		for (const d of this.disposables) {
			d.dispose();
		}
		this.disposables = [];
	}
}
