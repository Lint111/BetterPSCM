import * as vscode from 'vscode';
import { listChangesets, listMerges, getCurrentBranch, getChangesetDiff, findChangesetsTouchingPath } from '../core/workspace';
import type { MergeLink } from '../core/types';
import { log, logError } from '../util/logger';
import { buildPlasticUri } from '../util/uri';
import { LruCache, TtlCache } from '../util/cache';
import { getWorkspaceGuid } from '../api/client';
import { coreStyles, errorStyles } from './webviewStyles';
import { escapeHtml } from '../util/html';
import { GRAPH_CACHE_TTL_MS } from '../constants';
import type { ChangesetInfo, ChangesetDiffItem, StatusChangeType } from '../core/types';
import { formatRelativeDate } from '../util/date';
import { normalizePath } from '../util/path';
import { getEntryDecorationInfo, type EntryDecorationInfo } from '../scm/decorations';

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
	static readonly viewId = 'bpscm.historyGraphView';
	private view?: vscode.WebviewView;
	private disposables: vscode.Disposable[] = [];
	private currentFilter?: string;
	/**
	 * Active file-scoped filter — when set, the graph only shows changesets
	 * whose IDs are in `searchMatchIds`. Set via manual toolbar search or via
	 * the "follow active editor" auto-filter (see onDidChangeActiveTextEditor).
	 */
	private searchPattern?: string;
	private searchMatchIds?: Set<number>;
	/** Full changeset info for search matches — used to backfill commits that
	 *  fall outside the 200-recent window. */
	private searchMatchChangesets?: ChangesetInfo[];
	/**
	 * When true, switching the active editor retargets the file filter to the
	 * new file's workspace-relative path. User toggles this via the pin button
	 * in the toolbar. Mirrors `bpscm.graph.followActiveFile` setting.
	 */
	private followActiveEditor = true;
	/** Cache changeset diff results — changeset content is immutable */
	private readonly diffCache = new LruCache<number, { parentId: number; files: ChangesetDiffItem[] }>(100);
	/** Cache graph data keyed by filter ('' = all, branch name = filtered) */
	private readonly graphCache = new TtlCache<string, { changesets: ChangesetInfo[]; merges: MergeLink[]; currentBranch?: string }>(GRAPH_CACHE_TTL_MS);
	/** Cache file-scoped search results — cheap dedupe for rapid re-searches. */
	private readonly searchCache = new TtlCache<string, ChangesetInfo[]>(GRAPH_CACHE_TTL_MS);

	constructor(private readonly extensionUri: vscode.Uri) {
		// Load the follow-active-editor setting and react to changes.
		this.followActiveEditor = vscode.workspace
			.getConfiguration('bpscm')
			.get<boolean>('graph.followActiveFile', true);
		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('bpscm.graph.followActiveFile')) {
					this.followActiveEditor = vscode.workspace
						.getConfiguration('bpscm')
						.get<boolean>('graph.followActiveFile', true);
				}
			}),
		);
		// Auto-filter to the active editor's file. Reacts to the user clicking
		// a search result, opening a file from the explorer, etc. — giving us
		// ambient integration with the built-in Search view without needing
		// access to VS Code's internal search state.
		this.disposables.push(
			vscode.window.onDidChangeActiveTextEditor(editor => {
				if (!this.followActiveEditor) return;
				if (!editor || editor.document.uri.scheme !== 'file') return;
				const wsFolder = vscode.workspace.workspaceFolders?.[0];
				if (!wsFolder) return;
				// Use the basename as the display label, but pass the actual
				// file path so `cm history` can resolve it directly (the cm
				// query language does not support substring matching on
				// revision paths).
				const basename = editor.document.uri.path.split('/').pop();
				if (!basename) return;
				this.applySearch(basename, { source: 'follow', paths: [editor.document.uri.fsPath] });
			}),
		);
	}

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
					case 'search':
						await this.applySearch(msg.query || '', { source: 'manual' });
						break;
					case 'clearSearch':
						this.searchPattern = undefined;
						this.searchMatchIds = undefined;
						await this.loadData(this.currentFilter);
						break;
					case 'toggleFollow':
						this.followActiveEditor = !this.followActiveEditor;
						await vscode.workspace.getConfiguration('bpscm')
							.update('graph.followActiveFile', this.followActiveEditor, vscode.ConfigurationTarget.Global);
						// Re-render so the pin button reflects the new state.
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
		this.searchCache.clear();
		this.loadData(this.currentFilter);
	}

	/**
	 * Resolve a search pattern into a set of matching changeset IDs and
	 * reload the graph with the filter applied. Used by both the manual
	 * toolbar search and the follow-active-editor auto-filter.
	 *
	 * `source` distinguishes the two so the UI can label the filter pill
	 * differently ("from active file" vs "from search") — but the backend
	 * query is the same.
	 */
	private async applySearch(query: string, opts: { source: 'manual' | 'follow'; paths?: string[] }): Promise<void> {
		const trimmed = query.trim();
		if (trimmed.length === 0) {
			this.searchPattern = undefined;
			this.searchMatchIds = undefined;
			this.searchMatchChangesets = undefined;
			await this.loadData(this.currentFilter);
			return;
		}
		if (opts.source === 'follow' && this.searchPattern === trimmed) return;

		this.searchPattern = trimmed;
		try {
			let matches = this.searchCache.get(trimmed);
			if (!matches) {
				if (this.view) {
					this.view.webview.postMessage({ command: 'loading', active: true });
				}
				let paths = opts.paths;
				if (!paths || paths.length === 0) {
					const uris = await vscode.workspace.findFiles(`**/*${trimmed}*`, '**/node_modules/**', 50);
					paths = uris.map(u => u.fsPath);
					log(`[HistoryGraph] findFiles("${trimmed}") → ${paths.length} path(s)`);
				}
				matches = paths.length === 0 ? [] : await findChangesetsTouchingPath(paths);
				this.searchCache.set(trimmed, matches);
			}
			this.searchMatchChangesets = matches;
			this.searchMatchIds = new Set(matches.map(c => c.id));
			log(`[HistoryGraph] search "${trimmed}" → ${matches.length} changesets (source=${opts.source})`);
		} catch (err) {
			logError('File-scoped search failed', err);
			this.searchMatchIds = new Set();
			this.searchMatchChangesets = [];
		}
		await this.loadData(this.currentFilter);
	}

	private async loadData(filterBranch?: string): Promise<void> {
		if (!this.view) return;

		const cacheKey = filterBranch || '';
		const cached = this.graphCache.get(cacheKey);

		let changesets: ChangesetInfo[];
		let merges: MergeLink[];
		let currentBranch: string | undefined;

		if (cached) {
			log(`[HistoryGraph] cache hit for filter="${cacheKey}" (${cached.changesets.length} cs, ${cached.merges.length} merges)`);
			changesets = cached.changesets;
			merges = cached.merges;
			currentBranch = cached.currentBranch;
		} else {
			// Show loading state only for actual fetches
			this.view.webview.postMessage({ command: 'loading', active: true });

			try {
				// listMerges may not be supported on every backend (e.g. REST without
				// cm available); tolerate failure and render the graph without merges.
				const [csResult, branchResult, mergesResult] = await Promise.all([
					listChangesets(filterBranch, 200),
					getCurrentBranch(),
					listMerges().catch(err => {
						log(`[HistoryGraph] listMerges failed, rendering without merge edges: ${err instanceof Error ? err.message : err}`);
						return [] as MergeLink[];
					}),
				]);
				changesets = csResult;
				currentBranch = branchResult;
				merges = mergesResult;
				this.graphCache.set(cacheKey, { changesets, merges, currentBranch });
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

		// Merge in search matches that fell outside the 200-recent window.
		// The search query already returned full ChangesetInfo rows via
		// `cm find revision`, so no second round-trip is needed.
		if (this.searchMatchChangesets && this.searchMatchChangesets.length > 0) {
			const present = new Set(changesets.map(c => c.id));
			const extras = this.searchMatchChangesets.filter(c => !present.has(c.id));
			if (extras.length > 0) {
				log(`[HistoryGraph] merging ${extras.length} out-of-window search match(es)`);
				changesets = [...changesets, ...extras];
			}
		}

		const graphNodes = this.computeGraph(changesets, merges, currentBranch);

		this.view.webview.html = this.getHtml(
			this.view.webview, graphNodes, currentBranch, filterBranch,
			{
				pattern: this.searchPattern,
				matchCount: this.searchMatchIds?.size ?? 0,
				follow: this.followActiveEditor,
			},
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
			const normalizedPath = normalizePath(path);
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
	private computeGraph(changesets: ChangesetInfo[], merges: MergeLink[], currentBranchRaw?: string): GraphNode[] {
		if (changesets.length === 0) return [];

		// Apply the file-scoped filter (if any) BEFORE lane assignment so that
		// branches with zero matching commits disappear entirely — the whole
		// point of the filter is to collapse the history to the relevant parts.
		// Parent edges become "skip edges" since the intermediate commits are
		// gone; the existing renderer handles missing parents gracefully.
		const filtered = this.searchMatchIds
			? changesets.filter(cs => this.searchMatchIds!.has(cs.id))
			: changesets;

		if (filtered.length === 0) return [];

		// Sort by ID descending (newest first)
		// Normalize branch names to prevent duplicates from whitespace/formatting
		const sorted = [...filtered].map(cs => ({
			...cs,
			branch: cs.branch.trim(),
		})).sort((a, b) => b.id - a.id);
		const currentBranch = currentBranchRaw?.trim();

		// Build lookup
		const idToIndex = new Map<number, number>();
		for (let i = 0; i < sorted.length; i++) {
			idToIndex.set(sorted[i].id, i);
		}

		// Index merges by destination changeset id for O(1) lookup per row.
		// Only keep merges whose src and dst are both visible in the loaded window.
		const mergesByDst = new Map<number, number[]>();
		for (const m of merges) {
			if (!idToIndex.has(m.src) || !idToIndex.has(m.dst)) continue;
			const list = mergesByDst.get(m.dst);
			if (list) list.push(m.src);
			else mergesByDst.set(m.dst, [m.src]);
		}

		// Build per-branch changeset lists (sorted by ID desc within each branch)
		const branchChangesets = new Map<string, number[]>();
		for (let i = 0; i < sorted.length; i++) {
			const br = sorted[i].branch;
			if (!branchChangesets.has(br)) branchChangesets.set(br, []);
			branchChangesets.get(br)!.push(i);
		}

		// --- Lane assignment via interval coloring ---
		// Each branch occupies a row range [firstRow, lastRow]. No two branches
		// with overlapping ranges may share the same lane.
		// The range is extended to cover cross-branch connections (branch-off lines
		// travel vertically on the branch's lane from the commit to the parent row).
		const branchMinRow = new Map<string, number>();
		const branchMaxRow = new Map<string, number>();
		for (let i = 0; i < sorted.length; i++) {
			const br = sorted[i].branch;
			if (!branchMinRow.has(br)) branchMinRow.set(br, i);
			branchMaxRow.set(br, i);
		}

		// Extend ranges: if a commit's parent is on a different branch,
		// the connection line drops vertically on the child branch's lane
		// from the commit row to the horizontal turn row. Extend the child
		// branch interval to cover the parent's row.
		for (let i = 0; i < sorted.length; i++) {
			const cs = sorted[i];
			const parentIdx = idToIndex.get(cs.parent);
			if (parentIdx !== undefined) {
				const parent = sorted[parentIdx];
				if (parent.branch !== cs.branch) {
					// Branch-off: extend child branch range to cover the parent row
					const curMax = branchMaxRow.get(cs.branch) ?? i;
					if (parentIdx > curMax) branchMaxRow.set(cs.branch, parentIdx);
					const curMin = branchMinRow.get(cs.branch) ?? i;
					if (parentIdx < curMin) branchMinRow.set(cs.branch, parentIdx);
				}
			}

			// Merge edges: the dst commit gets a connection that lands on the
			// src branch's lane. The vertical segment of that connection lives
			// on the dst branch's own lane (same turn style as branch-off), so
			// extend the dst branch range to cover the src row.
			const mergeSrcs = mergesByDst.get(cs.id);
			if (mergeSrcs) {
				for (const srcId of mergeSrcs) {
					const srcIdx = idToIndex.get(srcId)!;
					const curMax = branchMaxRow.get(cs.branch) ?? i;
					if (srcIdx > curMax) branchMaxRow.set(cs.branch, srcIdx);
					const curMin = branchMinRow.get(cs.branch) ?? i;
					if (srcIdx < curMin) branchMinRow.set(cs.branch, srcIdx);
				}
			}
		}

		const branchLanes = new Map<string, number>();
		// Track which rows each lane is occupied: lane → list of [start, end] intervals
		const laneIntervals: [number, number][][] = [];

		const assignLane = (branch: string, requestedLane?: number): number => {
			const start = branchMinRow.get(branch) ?? 0;
			const end = branchMaxRow.get(branch) ?? start;

			const fits = (lane: number): boolean => {
				const intervals = laneIntervals[lane];
				if (!intervals) return true;
				for (const [s, e] of intervals) {
					if (start <= e && end >= s) return false; // overlap
				}
				return true;
			};

			if (requestedLane !== undefined && fits(requestedLane)) {
				if (!laneIntervals[requestedLane]) laneIntervals[requestedLane] = [];
				laneIntervals[requestedLane].push([start, end]);
				branchLanes.set(branch, requestedLane);
				return requestedLane;
			}

			// Find first available lane
			let lane = 0;
			while (!fits(lane)) lane++;
			if (!laneIntervals[lane]) laneIntervals[lane] = [];
			laneIntervals[lane].push([start, end]);
			branchLanes.set(branch, lane);
			return lane;
		};

		// Current branch always gets lane 0
		if (currentBranch && branchMinRow.has(currentBranch)) {
			assignLane(currentBranch, 0);
		}

		// Assign remaining branches in order of first appearance
		for (const cs of sorted) {
			if (!branchLanes.has(cs.branch)) {
				assignLane(cs.branch);
			}
		}

		// Second pass: build nodes with connections
		const nodes: GraphNode[] = [];

		// Track which branches have their origin connected
		const branchOriginConnected = new Set<string>();

		// Track previous commit index per branch for same-branch continuation
		const branchPrevIdx = new Map<string, number>();

		for (let i = 0; i < sorted.length; i++) {
			const cs = sorted[i];
			const lane = branchLanes.get(cs.branch)!;
			const color = LANE_COLORS[lane % LANE_COLORS.length];
			const connections: GraphConnection[] = [];
			const prevOnBranch = branchPrevIdx.get(cs.branch);

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
					// Different branch → this is a branch-off/merge point
					connections.push({
						toRow: parentIdx,
						toLane: parentLane,
						color,
						type: 'branch',
					});
					branchOriginConnected.add(cs.branch);
				}
			}

			// Merge edges from other branches into this changeset. cm find merge
			// gives us (src → dst) pairs; for each visible src we draw an edge
			// from this node (dst) to the src node's lane.
			const mergeSrcs = mergesByDst.get(cs.id);
			if (mergeSrcs) {
				for (const srcId of mergeSrcs) {
					const srcIdx = idToIndex.get(srcId)!;
					const srcLane = branchLanes.get(sorted[srcIdx].branch)!;
					connections.push({
						toRow: srcIdx,
						toLane: srcLane,
						color: LANE_COLORS[srcLane % LANE_COLORS.length],
						type: 'merge',
					});
				}
			}

			// Always connect to previous commit on same branch if not already
			// connected via same-branch parent. This prevents visual gaps when
			// a commit's parent is on another branch (merge) or not loaded.
			if (prevOnBranch !== undefined) {
				const alreadyConnected = connections.some(
					c => c.toRow === prevOnBranch && c.toLane === lane && c.type === 'parent',
				);
				if (!alreadyConnected) {
					connections.push({
						toRow: prevOnBranch,
						toLane: lane,
						color,
						type: 'parent',
					});
				}
			}

			branchPrevIdx.set(cs.branch, i);
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
		search: { pattern?: string; matchCount: number; follow: boolean } = { matchCount: 0, follow: true },
	): string {
		const maxLane = nodes.reduce((max, n) => Math.max(max, n.lane), 0);
		const laneSpacing = 20;
		const graphWidth = (maxLane + 1) * laneSpacing + 24;
		const rowHeight = 28;
		const totalHeight = nodes.length * rowHeight + 8;

		// Build the decoration lookup once, inject into the webview as JSON.
		// The webview uses the same info the native SCM panel uses — same
		// icons, same letters, same color semantics — so the two views stay
		// visually consistent even when we touch the decoration table later.
		// Keys are `<changeType>` for files and `<changeType>:folder` for
		// directory entries. Only the 4 change types emitted by ChangesetDiffItem
		// are needed; expand here if ChangesetDiffItem.type grows.
		const decoChangeTypes: StatusChangeType[] = ['added', 'changed', 'deleted', 'moved'];
		const decorationLookup: Record<string, EntryDecorationInfo> = {};
		for (const ct of decoChangeTypes) {
			decorationLookup[ct] = getEntryDecorationInfo(ct);
			decorationLookup[`${ct}:folder`] = getEntryDecorationInfo(ct, { dataType: 'Directory' });
		}
		const decorationLookupJson = JSON.stringify(decorationLookup);

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
				`<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" stroke="${color}" stroke-width="2" stroke-opacity="0.55"/>`,
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

				// Merge edges are drawn dashed so they stand out from parent/branch links.
				const dash = conn.type === 'merge' ? ' stroke-dasharray="4,3"' : '';

				if (conn.type === 'parent') {
					// Same-branch vertical
					svgLines.push(
						`<line x1="${cx}" y1="${cy}" x2="${tx}" y2="${ty}" stroke="${conn.color}" stroke-width="2" stroke-opacity="0.7"${dash}/>`,
					);
				} else {
					// Branch/merge: horizontal from source to target lane, then vertical down
					if (tx !== cx) {
						const r = Math.min(6, Math.abs(tx - cx) / 2);
						const dir = tx > cx ? 1 : -1;
						svgLines.push(
							`<path d="M${cx},${cy} L${tx - dir * r},${cy} Q${tx},${cy} ${tx},${cy + r} L${tx},${ty}" fill="none" stroke="${conn.color}" stroke-width="2" stroke-opacity="0.7"${dash}/>`,
						);
					} else {
						svgLines.push(
							`<line x1="${cx}" y1="${cy}" x2="${tx}" y2="${ty}" stroke="${conn.color}" stroke-width="2" stroke-opacity="0.7"${dash}/>`,
						);
					}
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
			const dateStr = formatRelativeDate(cs.date);
			const comment = escapeHtml(cs.comment ?? '(no comment)');
			const trunc = comment.length > 60 ? comment.substring(0, 57) + '...' : comment;

			return `<div class="row" data-cs="${cs.id}" data-parent="${cs.parent}" style="height:${rowHeight}px" title="${comment}">
	<div class="graph-col" style="width:${graphWidth}px"></div>
	<div class="info-col">
		<span class="comment truncate">${trunc}</span>
		<span class="meta text-muted">
			<span class="badge" style="color:${node.color};border-color:${node.color}40;background:${node.color}15">${escapeHtml(short)}${isCurrent ? ' ●' : ''}</span>
			<span class="cs-id text-mono">#${cs.id}</span>
			<span class="owner truncate">${escapeHtml(cs.owner)}</span>
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
</style></head>
<body>
<div class="progress-bar" id="progressBar"></div>
<div class="toolbar">
	<button id="focusBtn" class="toggle-btn ${filterBranch ? 'active' : ''}" title="Show current branch only">⎇ Branch</button>
	<button id="allBtn" class="toggle-btn ${!filterBranch ? 'active' : ''}" title="Show all branches">◎ All</button>
	<button id="refreshBtn" title="Refresh">↻</button>
	<span style="color:var(--vscode-descriptionForeground);font-size:10px;margin-left:auto">${nodes.length} cs</span>
</div>
<div class="search-row">
	<input type="text" id="searchInput" placeholder="Filter history by file/path…" value="${escapeHtml(search.pattern ?? '')}" />
	<button id="pinBtn" class="toggle-btn ${search.follow ? 'pinned' : ''}" title="${search.follow ? 'Following active editor — click to unpin' : 'Not following active editor — click to follow'}">${search.follow ? '📌' : '📍'}</button>
</div>
${search.pattern
	? `<div class="filter-pill">
		<span class="pill-label" title="${escapeHtml(search.pattern)}">Filter: <b>${escapeHtml(search.pattern)}</b> — ${search.matchCount} changeset(s)</span>
		<span class="pill-close" id="clearFilterBtn" title="Clear filter">✕</span>
	</div>`
	: ''
}
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
	<div class="panel-title">
		<span id="filePanelTitle">Changed files</span>
		<button id="toggleFoldersBtn" class="toggle-btn active" title="Show/hide folder entries" style="margin-left:auto;font-size:10px;padding:2px 6px;">
			📁 Folders
		</button>
	</div>
	<div id="fileList"></div>
</div>
<script>
const vscode = acquireVsCodeApi();
let selectedRow = null;
// Decoration lookup mirrors the native SCM panel — keeps the two views
// visually consistent. Keys: '<changeType>' for files, '<changeType>:folder'
// for directory entries.
const DECO = ${decorationLookupJson};
let showFolders = true;
let lastFilesPayload = null;
const searchPattern = ${JSON.stringify(search.pattern ?? '').replace(/</g, '\\u003c')};
const searchPatternLc = searchPattern.toLowerCase();

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

// ── File-scoped history filter ──────────────────────────────────
// Enter in the search input runs a filter. Empty string clears it.
// The pin button toggles follow-active-editor; its state is persisted
// in workspace config (bpscm.graph.followActiveFile).
const searchInput = document.getElementById('searchInput');
if (searchInput) {
	searchInput.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') {
			const q = searchInput.value.trim();
			showLoading();
			if (q.length === 0) {
				vscode.postMessage({ command: 'clearSearch' });
			} else {
				vscode.postMessage({ command: 'search', query: q });
			}
		} else if (e.key === 'Escape') {
			searchInput.value = '';
			showLoading();
			vscode.postMessage({ command: 'clearSearch' });
		}
	});
}
const pinBtn = document.getElementById('pinBtn');
if (pinBtn) {
	pinBtn.addEventListener('click', () => {
		vscode.postMessage({ command: 'toggleFollow' });
	});
}
const clearFilterBtn = document.getElementById('clearFilterBtn');
if (clearFilterBtn) {
	clearFilterBtn.addEventListener('click', () => {
		showLoading();
		vscode.postMessage({ command: 'clearSearch' });
	});
}

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
		lastFilesPayload = msg;
		renderFileList();
	}
});

// Mirror of the shared shouldOpenDiff rule — folders never open a diff view.
function shouldOpenDiff(f) { return !isFolderEntry(f); }
function isFolderEntry(f) { return !!f.isDirectory; }

function renderFileList() {
	if (!lastFilesPayload) return;
	const msg = lastFilesPayload;
	const panel = document.getElementById('filePanel');
	const list = document.getElementById('fileList');
	const title = document.getElementById('filePanelTitle');
	panel.style.display = '';

	if (msg.error) {
		title.textContent = 'Changeset #' + msg.changesetId + ' (error)';
		list.innerHTML = '<div class="empty">' + escHtml(msg.error) + '</div>';
		return;
	}

	const allFiles = msg.files || [];
	let files = showFolders ? allFiles : allFiles.filter(f => !isFolderEntry(f));
	if (searchPatternLc.length > 0) {
		// Float matches to the top so the reason this changeset showed up is obvious.
		files = files.slice().sort((a, b) => {
			const am = a.path.toLowerCase().indexOf(searchPatternLc) !== -1 ? 0 : 1;
			const bm = b.path.toLowerCase().indexOf(searchPatternLc) !== -1 ? 0 : 1;
			return am - bm;
		});
	}
	const folderCount = allFiles.length - allFiles.filter(f => !isFolderEntry(f)).length;
	const suffix = folderCount > 0 && !showFolders ? ' (' + folderCount + ' folder(s) hidden)' : '';
	title.textContent = 'Changeset #' + msg.changesetId + ' — ' + files.length + ' file(s)' + suffix;

	if (files.length === 0) {
		list.innerHTML = '<div class="empty">No files found</div>';
		return;
	}

	list.innerHTML = files.map(f => {
		const key = f.type + (isFolderEntry(f) ? ':folder' : '');
		const deco = DECO[key] || DECO[f.type] || { letter: '?', tooltip: f.type, strikeThrough: false, colorId: 'foreground' };
		const shortPath = f.path.split('/').slice(-2).join('/');
		const isDir = isFolderEntry(f);
		const isMatch = searchPatternLc.length > 0 && f.path.toLowerCase().indexOf(searchPatternLc) !== -1;
		const classes = 'list-item file-item' + (isDir ? ' is-folder' : '') + (isMatch ? ' search-match' : '');
		const strike = deco.strikeThrough ? 'text-decoration:line-through;' : '';
		// Color the change-type letter using the shared VS Code theme color var.
		// The native SCM panel uses a ThemeIcon with the same color id — same
		// visual semantics, different container.
		const colorVar = 'var(--vscode-' + deco.colorId.replace(/\\./g, '-') + ')';
		const letterHtml = '<span class="entry-letter" style="color:' + colorVar + '">' + escHtml(deco.letter) + '</span>';
		const folderGlyph = isDir ? '<span class="folder-glyph">📁</span>' : '';
		return '<div class="' + classes + '" data-path="' + escHtml(f.path) + '" data-cs="' + msg.changesetId + '" data-parent="' + msg.parentId + '" data-folder="' + (isDir ? '1' : '0') + '" title="' + escHtml(deco.tooltip + ' — ' + f.path) + '">' +
			letterHtml +
			folderGlyph +
			'<span class="file-path truncate" style="' + strike + 'color:' + colorVar + '">' + escHtml(shortPath) + '</span>' +
			'</div>';
	}).join('');

	// Click file → open diff (folders are skipped via shouldOpenDiff — unified rule).
	let selectedFile = null;
	list.querySelectorAll('.file-item').forEach(item => {
		const isDir = item.dataset.folder === '1';
		if (isDir) return; // shouldOpenDiff === false
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

// Folder-visibility toggle — lets the user hide directory entries from the
// historic changeset list. State is re-applied to the last-loaded changeset
// so the user can toggle without reclicking the row.
document.getElementById('toggleFoldersBtn').addEventListener('click', () => {
	showFolders = !showFolders;
	const btn = document.getElementById('toggleFoldersBtn');
	btn.classList.toggle('active', showFolders);
	btn.title = showFolders ? 'Hide folder entries' : 'Show folder entries';
	renderFileList();
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
<div class="err"><h3>Failed to load history</h3><pre>${escapeHtml(message)}</pre>
<button onclick="const v=acquireVsCodeApi();v.postMessage({command:'refresh'})">Retry</button></div>
</body></html>`;
	}

	private shortBranch(name: string): string {
		const parts = name.split('/');
		return parts.length > 2 ? parts.slice(-2).join('/') : parts[parts.length - 1];
	}


	dispose(): void {
		for (const d of this.disposables) d.dispose();
		this.disposables = [];
		this.diffCache.clear();
		this.graphCache.clear();
	}
}
