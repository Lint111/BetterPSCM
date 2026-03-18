# Code Review Navigation & Audit Export — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add inline code review comment navigation — link comments to files/lines, show truncated code snippets, next/back traversal, and Markdown audit export.

**Architecture:** When a review is opened, batch-resolve all comment revision IDs to file paths via a single `cm find revision` query. Populate a tree view grouped by file. Clicking a comment opens a snippet webview. Editor decorations + next/back navigation for open files. Audit export renders code+comments to Markdown.

**Tech Stack:** VS Code Extension API (TreeView, TextEditorDecorationType, WebviewPanel, StatusBarItem), Plastic SCM CLI (`cm find revision`, `cm cat`)

---

### Task 1: Backend — resolveRevisionPaths + enriched comments

**Files:**
- Modify: `src/core/backend.ts:46` (add method to interface)
- Modify: `src/core/backendCli.ts:534` (implement method)
- Modify: `src/core/backendRest.ts` (stub)
- Modify: `src/core/workspace.ts` (add facade function)
- Modify: `src/core/types.ts:128` (add ResolvedComment type)
- Test: `test/unit/core/backendCli.test.ts`

**Step 1: Write the failing tests**

Add to `test/unit/core/backendCli.test.ts` inside the `CliBackend` describe block:

```typescript
describe('resolveRevisionPaths', () => {
	it('resolves multiple revision IDs to file paths in one call', async () => {
		mockExecCm.mockResolvedValue({
			stdout: [
				'C:\\proj\\Assets\\Scripts\\Foo.cs#42939',
				'C:\\proj\\Assets\\Scripts\\Bar.cs#42940',
			].join('\n'),
			stderr: '',
			exitCode: 0,
		});

		const result = await backend.resolveRevisionPaths([42939, 42940]);

		expect(mockExecCm).toHaveBeenCalledWith([
			'find', 'revision',
			'where id=42939 or id=42940',
			'--format={item}#{id}',
			'--nototal',
		]);
		expect(result.get(42939)).toBe('C:\\proj\\Assets\\Scripts\\Foo.cs');
		expect(result.get(42940)).toBe('C:\\proj\\Assets\\Scripts\\Bar.cs');
	});

	it('returns empty map for empty input', async () => {
		const result = await backend.resolveRevisionPaths([]);
		expect(result.size).toBe(0);
		expect(mockExecCm).not.toHaveBeenCalled();
	});

	it('handles single revision ID', async () => {
		mockExecCm.mockResolvedValue({
			stdout: 'C:\\proj\\Assets\\Scripts\\Foo.cs#42939\n',
			stderr: '',
			exitCode: 0,
		});

		const result = await backend.resolveRevisionPaths([42939]);

		expect(mockExecCm).toHaveBeenCalledWith([
			'find', 'revision',
			'where id=42939',
			'--format={item}#{id}',
			'--nototal',
		]);
		expect(result.get(42939)).toBe('C:\\proj\\Assets\\Scripts\\Foo.cs');
	});

	it('chunks large revision lists into multiple calls', async () => {
		// 60 IDs should be split into 2 calls (50 + 10)
		const ids = Array.from({ length: 60 }, (_, i) => i + 1);
		mockExecCm
			.mockResolvedValueOnce({ stdout: ids.slice(0, 50).map(id => `C:\\f${id}.cs#${id}`).join('\n'), stderr: '', exitCode: 0 })
			.mockResolvedValueOnce({ stdout: ids.slice(50).map(id => `C:\\f${id}.cs#${id}`).join('\n'), stderr: '', exitCode: 0 });

		const result = await backend.resolveRevisionPaths(ids);

		expect(mockExecCm).toHaveBeenCalledTimes(2);
		expect(result.size).toBe(60);
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /mnt/c/Github/BetterSCM && npx vitest run test/unit/core/backendCli.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — `backend.resolveRevisionPaths is not a function`

**Step 3: Add ResolvedComment type**

In `src/core/types.ts`, after the `ReviewCommentInfo` interface (line 137), add:

```typescript
export interface ResolvedComment {
	id: number;
	owner: string;
	text: string;
	type: ReviewCommentType;
	timestamp: string;
	filePath: string;
	lineNumber: number;
}
```

**Step 4: Add resolveRevisionPaths to backend interface**

In `src/core/backend.ts`, after line 46 (updateReviewerStatus), add:

```typescript
	// Phase 4b — review comment resolution
	resolveRevisionPaths(revisionIds: number[]): Promise<Map<number, string>>;
```

**Step 5: Implement in CLI backend**

In `src/core/backendCli.ts`, after the `updateReviewerStatus` stub (line 534), add:

```typescript
	async resolveRevisionPaths(revisionIds: number[]): Promise<Map<number, string>> {
		if (revisionIds.length === 0) return new Map();

		const CHUNK_SIZE = 50;
		const pathMap = new Map<number, string>();

		for (let i = 0; i < revisionIds.length; i += CHUNK_SIZE) {
			const chunk = revisionIds.slice(i, i + CHUNK_SIZE);
			const whereClause = chunk.map(id => `id=${id}`).join(' or ');
			const result = await execCm([
				'find', 'revision',
				`where ${whereClause}`,
				'--format={item}#{id}',
				'--nototal',
			]);
			if (result.exitCode !== 0) {
				throw new Error(`cm find revision failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
			}
			for (const line of result.stdout.split(/\r?\n/).filter(l => l.length > 0)) {
				const sepIdx = line.lastIndexOf('#');
				if (sepIdx < 0) continue;
				const filePath = line.substring(0, sepIdx);
				const id = parseInt(line.substring(sepIdx + 1), 10);
				if (!isNaN(id)) pathMap.set(id, filePath);
			}
		}

		return pathMap;
	}
```

**Step 6: Stub in REST backend**

In `src/core/backendRest.ts`, add the method (it can use the REST API's revision endpoints if available, or throw NotSupportedError):

```typescript
	async resolveRevisionPaths(_revisionIds: number[]): Promise<Map<number, string>> {
		// REST API doesn't need this — review comments already include item paths
		return new Map();
	}
```

**Step 7: Add facade function in workspace.ts**

In `src/core/workspace.ts`, add:

```typescript
export async function resolveRevisionPaths(revisionIds: number[]): Promise<Map<number, string>> {
	return getBackend().resolveRevisionPaths(revisionIds);
}
```

Also add `ResolvedComment` to the type imports and re-exports.

**Step 8: Run tests to verify they pass**

Run: `cd /mnt/c/Github/BetterSCM && npx vitest run test/unit/core/backendCli.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS

**Step 9: Commit**

```bash
cd /mnt/c/Github/BetterSCM
git add src/core/backend.ts src/core/backendCli.ts src/core/backendRest.ts src/core/workspace.ts src/core/types.ts test/unit/core/backendCli.test.ts
git commit -m "feat(review): add resolveRevisionPaths for batch revision→file resolution"
```

---

### Task 2: Comment enrichment — resolve comments to file+line

**Files:**
- Create: `src/core/reviewResolver.ts`
- Test: `test/unit/core/reviewResolver.test.ts`

**Step 1: Write the failing tests**

Create `test/unit/core/reviewResolver.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { resolveComments } from '../../../src/core/reviewResolver';
import type { ReviewCommentInfo, ResolvedComment } from '../../../src/core/types';

describe('resolveComments', () => {
	it('enriches comments with file paths and line numbers', async () => {
		const comments: ReviewCommentInfo[] = [
			{ id: 1, owner: 'theo', text: 'Fix this', type: 'Comment', timestamp: '2026-02-17T15:00:00', locationSpec: '42939#37' },
			{ id: 2, owner: 'maria', text: 'Looks good', type: 'Comment', timestamp: '2026-02-17T16:00:00', locationSpec: '42940#12' },
		];
		const pathMap = new Map<number, string>([
			[42939, 'C:\\proj\\Assets\\Foo.cs'],
			[42940, 'C:\\proj\\Assets\\Bar.cs'],
		]);
		const resolveFn = vi.fn().mockResolvedValue(pathMap);

		const result = await resolveComments(comments, resolveFn);

		expect(resolveFn).toHaveBeenCalledWith([42939, 42940]);
		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({
			id: 1, owner: 'theo', text: 'Fix this', type: 'Comment', timestamp: '2026-02-17T15:00:00',
			filePath: 'C:\\proj\\Assets\\Foo.cs', lineNumber: 37,
		});
		expect(result[1]).toEqual({
			id: 2, owner: 'maria', text: 'Looks good', type: 'Comment', timestamp: '2026-02-17T16:00:00',
			filePath: 'C:\\proj\\Assets\\Bar.cs', lineNumber: 12,
		});
	});

	it('skips comments without locationSpec', async () => {
		const comments: ReviewCommentInfo[] = [
			{ id: 1, owner: 'theo', text: 'General note', type: 'Comment', timestamp: '2026-02-17T15:00:00' },
			{ id: 2, owner: 'maria', text: 'Fix line', type: 'Comment', timestamp: '2026-02-17T16:00:00', locationSpec: '42939#10' },
		];
		const pathMap = new Map([[42939, 'C:\\proj\\Foo.cs']]);
		const resolveFn = vi.fn().mockResolvedValue(pathMap);

		const result = await resolveComments(comments, resolveFn);

		expect(result).toHaveLength(1);
		expect(result[0].filePath).toBe('C:\\proj\\Foo.cs');
	});

	it('skips comments whose revision ID could not be resolved', async () => {
		const comments: ReviewCommentInfo[] = [
			{ id: 1, owner: 'theo', text: 'Orphan', type: 'Comment', timestamp: '2026-02-17', locationSpec: '99999#5' },
		];
		const resolveFn = vi.fn().mockResolvedValue(new Map());

		const result = await resolveComments(comments, resolveFn);

		expect(result).toHaveLength(0);
	});

	it('deduplicates revision IDs before calling resolve', async () => {
		const comments: ReviewCommentInfo[] = [
			{ id: 1, owner: 'a', text: 'x', type: 'Comment', timestamp: '', locationSpec: '100#1' },
			{ id: 2, owner: 'b', text: 'y', type: 'Comment', timestamp: '', locationSpec: '100#5' },
		];
		const resolveFn = vi.fn().mockResolvedValue(new Map([[100, 'C:\\f.cs']]));

		await resolveComments(comments, resolveFn);

		expect(resolveFn).toHaveBeenCalledWith([100]); // deduplicated
	});

	it('sorts result by filePath then lineNumber', async () => {
		const comments: ReviewCommentInfo[] = [
			{ id: 1, owner: 'a', text: 'x', type: 'Comment', timestamp: '', locationSpec: '200#50' },
			{ id: 2, owner: 'b', text: 'y', type: 'Comment', timestamp: '', locationSpec: '100#10' },
			{ id: 3, owner: 'c', text: 'z', type: 'Comment', timestamp: '', locationSpec: '100#5' },
		];
		const resolveFn = vi.fn().mockResolvedValue(new Map([
			[100, 'A.cs'],
			[200, 'B.cs'],
		]));

		const result = await resolveComments(comments, resolveFn);

		expect(result.map(r => r.id)).toEqual([3, 2, 1]); // A:5, A:10, B:50
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /mnt/c/Github/BetterSCM && npx vitest run test/unit/core/reviewResolver.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — module not found

**Step 3: Implement reviewResolver.ts**

Create `src/core/reviewResolver.ts`:

```typescript
import type { ReviewCommentInfo, ResolvedComment } from './types';

/**
 * Parse locationSpec "revisionId#lineNumber" into its parts.
 * Returns undefined if the format is invalid.
 */
function parseLocationSpec(spec: string | undefined): { revisionId: number; lineNumber: number } | undefined {
	if (!spec) return undefined;
	const sep = spec.indexOf('#');
	if (sep < 0) return undefined;
	const revisionId = parseInt(spec.substring(0, sep), 10);
	const lineNumber = parseInt(spec.substring(sep + 1), 10);
	if (isNaN(revisionId) || isNaN(lineNumber)) return undefined;
	return { revisionId, lineNumber };
}

/**
 * Resolve review comments to file paths and line numbers.
 *
 * @param comments - Raw review comments (may or may not have locationSpec)
 * @param resolvePaths - Function that batch-resolves revision IDs to file paths
 * @returns Comments enriched with filePath + lineNumber, sorted by file then line
 */
export async function resolveComments(
	comments: ReviewCommentInfo[],
	resolvePaths: (revisionIds: number[]) => Promise<Map<number, string>>,
): Promise<ResolvedComment[]> {
	// Parse locationSpecs and collect unique revision IDs
	const parsed = comments.map(c => ({ comment: c, loc: parseLocationSpec(c.locationSpec) }));
	const revisionIds = [...new Set(
		parsed.map(p => p.loc?.revisionId).filter((id): id is number => id !== undefined),
	)];

	if (revisionIds.length === 0) return [];

	const pathMap = await resolvePaths(revisionIds);

	// Build resolved comments, skipping any that couldn't be resolved
	const resolved: ResolvedComment[] = [];
	for (const { comment, loc } of parsed) {
		if (!loc) continue;
		const filePath = pathMap.get(loc.revisionId);
		if (!filePath) continue;
		resolved.push({
			id: comment.id,
			owner: comment.owner,
			text: comment.text,
			type: comment.type,
			timestamp: comment.timestamp,
			filePath,
			lineNumber: loc.lineNumber,
		});
	}

	// Sort by file path, then by line number
	resolved.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.lineNumber - b.lineNumber);

	return resolved;
}
```

**Step 4: Run tests to verify they pass**

Run: `cd /mnt/c/Github/BetterSCM && npx vitest run test/unit/core/reviewResolver.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS

**Step 5: Commit**

```bash
cd /mnt/c/Github/BetterSCM
git add src/core/reviewResolver.ts test/unit/core/reviewResolver.test.ts
git commit -m "feat(review): add resolveComments to enrich comments with file paths"
```

---

### Task 3: Review Comments Tree View

**Files:**
- Create: `src/views/reviewCommentsTreeProvider.ts`
- Modify: `src/constants.ts:28` (add command IDs)
- Modify: `package.json` (register view + commands)
- Modify: `src/extension.ts:214` (register tree view)
- Modify: `src/commands/codeReview.ts` (trigger resolution on open)

**Step 1: Add constants**

In `src/constants.ts`, add to the COMMANDS object after `openCodeReview` (line 28):

```typescript
	inspectReviewComments: 'plasticScm.inspectReviewComments',
	nextReviewComment: 'plasticScm.nextReviewComment',
	prevReviewComment: 'plasticScm.prevReviewComment',
	exportReviewAudit: 'plasticScm.exportReviewAudit',
```

**Step 2: Register in package.json**

Add to `contributes.commands` array (after openCodeReview, line 138):

```json
{
  "command": "plasticScm.inspectReviewComments",
  "title": "Inspect Review Comments",
  "icon": "$(comment-discussion)",
  "category": "Plastic SCM"
},
{
  "command": "plasticScm.nextReviewComment",
  "title": "Next Review Comment",
  "icon": "$(arrow-down)",
  "category": "Plastic SCM"
},
{
  "command": "plasticScm.prevReviewComment",
  "title": "Previous Review Comment",
  "icon": "$(arrow-up)",
  "category": "Plastic SCM"
},
{
  "command": "plasticScm.exportReviewAudit",
  "title": "Export Review Audit",
  "icon": "$(export)",
  "category": "Plastic SCM"
}
```

Add a new view in `contributes.views.scm` (after codeReviewsView, line 324):

```json
{
  "id": "plasticScm.reviewCommentsView",
  "name": "Review Comments",
  "when": "plasticScm.isActive && plasticScm.reviewActive"
}
```

Add to `menus.view/title` (after line 286):

```json
{
  "command": "plasticScm.nextReviewComment",
  "when": "view == plasticScm.reviewCommentsView",
  "group": "navigation"
},
{
  "command": "plasticScm.prevReviewComment",
  "when": "view == plasticScm.reviewCommentsView",
  "group": "navigation"
},
{
  "command": "plasticScm.exportReviewAudit",
  "when": "view == plasticScm.reviewCommentsView",
  "group": "navigation"
}
```

Add to `menus.view/item/context` (after line 279):

```json
{
  "command": "plasticScm.inspectReviewComments",
  "when": "view == plasticScm.codeReviewsView && viewItem == codeReview",
  "group": "navigation"
}
```

**Step 3: Create the tree provider**

Create `src/views/reviewCommentsTreeProvider.ts`:

```typescript
import * as vscode from 'vscode';
import type { ResolvedComment } from '../core/types';

type TreeElement = FileGroupItem | CommentItem;

export class ReviewCommentsTreeProvider implements vscode.TreeDataProvider<TreeElement>, vscode.Disposable {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private _comments: ResolvedComment[] = [];
	private _reviewTitle = '';

	setComments(comments: ResolvedComment[], reviewTitle: string): void {
		this._comments = comments;
		this._reviewTitle = reviewTitle;
		this._onDidChangeTreeData.fire();
	}

	get comments(): readonly ResolvedComment[] { return this._comments; }

	clear(): void {
		this._comments = [];
		this._reviewTitle = '';
		this._onDidChangeTreeData.fire();
	}

	dispose(): void {
		this._onDidChangeTreeData.dispose();
	}

	getTreeItem(element: TreeElement): vscode.TreeItem {
		return element;
	}

	getChildren(element?: TreeElement): TreeElement[] {
		if (!element) {
			// Root level: group by file
			const groups = new Map<string, ResolvedComment[]>();
			for (const c of this._comments) {
				const existing = groups.get(c.filePath) ?? [];
				existing.push(c);
				groups.set(c.filePath, existing);
			}

			if (groups.size === 0) {
				const empty = new vscode.TreeItem('No inline comments in this review');
				return [empty as TreeElement];
			}

			return [...groups.entries()].map(
				([filePath, comments]) => new FileGroupItem(filePath, comments),
			);
		}

		if (element instanceof FileGroupItem) {
			return element.comments.map(c => new CommentItem(c));
		}

		return [];
	}
}

class FileGroupItem extends vscode.TreeItem {
	constructor(
		public readonly filePath: string,
		public readonly comments: ResolvedComment[],
	) {
		const fileName = filePath.replace(/\\/g, '/').split('/').pop() ?? filePath;
		super(fileName, vscode.TreeItemCollapsibleState.Expanded);
		this.description = `${comments.length} comment(s)`;
		this.tooltip = filePath;
		this.iconPath = new vscode.ThemeIcon('file-code');
		this.contextValue = 'reviewFileGroup';
	}
}

class CommentItem extends vscode.TreeItem {
	constructor(public readonly comment: ResolvedComment) {
		const preview = comment.text.length > 60
			? comment.text.substring(0, 57) + '...'
			: comment.text;
		super(preview, vscode.TreeItemCollapsibleState.None);
		this.description = `line ${comment.lineNumber}`;
		this.tooltip = `${comment.owner}: ${comment.text}`;
		this.iconPath = new vscode.ThemeIcon(
			comment.type === 'Question' ? 'question' : 'comment',
			comment.type === 'Question'
				? new vscode.ThemeColor('charts.yellow')
				: undefined,
		);
		this.contextValue = 'reviewComment';
		this.command = {
			command: 'plasticScm.inspectReviewComments',
			title: 'Inspect Comment',
			arguments: [comment],
		};
	}
}
```

**Step 4: Wire up in extension.ts**

In `src/extension.ts`, add the import at the top:

```typescript
import { ReviewCommentsTreeProvider } from './views/reviewCommentsTreeProvider';
```

After the code reviews tree view registration (line 221), add:

```typescript
	// Register review comments tree view
	const reviewCommentsTree = new ReviewCommentsTreeProvider();
	disposables.add(reviewCommentsTree);
	context.subscriptions.push(
		vscode.window.createTreeView('plasticScm.reviewCommentsView', {
			treeDataProvider: reviewCommentsTree,
		}),
	);
	registerCodeReviewCommands(context, codeReviewsTree, reviewCommentsTree);
```

Update the `registerCodeReviewCommands` call on line 221 to pass `reviewCommentsTree` as the third parameter (this changes the function signature — see Task 5 for full wiring).

**Step 5: Commit**

```bash
cd /mnt/c/Github/BetterSCM
git add src/views/reviewCommentsTreeProvider.ts src/constants.ts package.json src/extension.ts
git commit -m "feat(review): add review comments tree view grouped by file"
```

---

### Task 4: Review Snippet Panel (truncated code view)

**Files:**
- Create: `src/views/reviewSnippetPanel.ts`

**Step 1: Create the snippet panel**

Create `src/views/reviewSnippetPanel.ts`:

```typescript
import * as vscode from 'vscode';
import { coreStyles } from './webviewStyles';
import { fetchFileContent } from '../core/workspace';
import { logError } from '../util/logger';
import type { ResolvedComment } from '../core/types';

export class ReviewSnippetPanel implements vscode.Disposable {
	static readonly viewType = 'plasticScm.reviewSnippetPanel';
	private static instance: ReviewSnippetPanel | undefined;

	private readonly panel: vscode.WebviewPanel;
	private disposables: vscode.Disposable[] = [];

	static async show(comment: ResolvedComment, extensionUri: vscode.Uri, contextLines = 5): Promise<void> {
		if (ReviewSnippetPanel.instance) {
			ReviewSnippetPanel.instance.panel.reveal();
			await ReviewSnippetPanel.instance.loadSnippet(comment, contextLines);
			return;
		}
		const inst = new ReviewSnippetPanel(extensionUri);
		await inst.loadSnippet(comment, contextLines);
	}

	private constructor(extensionUri: vscode.Uri) {
		this.panel = vscode.window.createWebviewPanel(
			ReviewSnippetPanel.viewType,
			'Review Comment',
			vscode.ViewColumn.One,
			{ enableScripts: true, retainContextWhenHidden: true },
		);

		ReviewSnippetPanel.instance = this;

		this.panel.onDidDispose(() => {
			ReviewSnippetPanel.instance = undefined;
			this.dispose();
		}, null, this.disposables);

		this.panel.webview.onDidReceiveMessage(
			msg => this.handleMessage(msg),
			null,
			this.disposables,
		);
	}

	private currentComment: ResolvedComment | undefined;

	private async handleMessage(msg: any): Promise<void> {
		if (msg.type === 'showMore' && this.currentComment) {
			await this.loadSnippet(this.currentComment, msg.contextLines);
		} else if (msg.type === 'goToFile' && this.currentComment) {
			const uri = vscode.Uri.file(this.currentComment.filePath);
			const line = Math.max(0, this.currentComment.lineNumber - 1);
			const doc = await vscode.workspace.openTextDocument(uri);
			const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
			editor.revealRange(
				new vscode.Range(line, 0, line, 0),
				vscode.TextEditorRevealType.InCenter,
			);
		}
	}

	private async loadSnippet(comment: ResolvedComment, contextLines: number): Promise<void> {
		this.currentComment = comment;
		const fileName = comment.filePath.replace(/\\/g, '/').split('/').pop() ?? '';
		this.panel.title = `${fileName}:${comment.lineNumber}`;

		try {
			// Parse revisionId from the original locationSpec pattern
			// We need the revisionId to fetch the file content at the reviewed revision
			// It's encoded in the ResolvedComment — extract from filePath resolution context
			const content = await this.fetchFileLines(comment);
			const totalLines = content.length;
			const targetLine = comment.lineNumber; // 1-based
			const startLine = Math.max(1, targetLine - contextLines);
			const endLine = Math.min(totalLines, targetLine + contextLines);
			const snippet = content.slice(startLine - 1, endLine);

			this.panel.webview.html = this.buildHtml(comment, snippet, startLine, targetLine, contextLines, totalLines);
		} catch (err) {
			logError('Failed to load review snippet', err);
			this.panel.webview.html = this.buildErrorHtml(comment, err);
		}
	}

	private async fetchFileLines(comment: ResolvedComment): Promise<string[]> {
		// Try to read the local workspace file first (most common case)
		try {
			const uri = vscode.Uri.file(comment.filePath);
			const doc = await vscode.workspace.openTextDocument(uri);
			return doc.getText().split('\n');
		} catch {
			// File might not exist locally — return empty
			return [];
		}
	}

	private buildHtml(
		comment: ResolvedComment,
		lines: string[],
		startLine: number,
		targetLine: number,
		contextLines: number,
		totalLines: number,
	): string {
		const ext = comment.filePath.split('.').pop() ?? '';
		const linesHtml = lines.map((line, i) => {
			const lineNum = startLine + i;
			const isTarget = lineNum === targetLine;
			return `<div class="code-line ${isTarget ? 'target-line' : ''}"><span class="line-num">${lineNum}</span><span class="line-text">${esc(line)}</span></div>`;
		}).join('');

		const fileName = comment.filePath.replace(/\\/g, '/').split('/').pop() ?? '';

		return `<!DOCTYPE html>
<html>
<head>
<style>
${coreStyles}
.snippet-header { padding: 12px 16px; border-bottom: 1px solid var(--vscode-panel-border); }
.file-path { font-family: var(--vscode-editor-font-family); font-size: var(--font-label); color: var(--vscode-descriptionForeground); }
.code-block { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size, 13px); line-height: 1.5; overflow-x: auto; }
.code-line { display: flex; padding: 0 16px; white-space: pre; }
.code-line:hover { background: var(--vscode-list-hoverBackground); }
.target-line { background: rgba(255, 200, 0, 0.15); border-left: 3px solid var(--vscode-editorWarning-foreground, #cca700); }
.line-num { display: inline-block; min-width: 40px; padding-right: 12px; text-align: right; color: var(--vscode-editorLineNumber-foreground); user-select: none; }
.line-text { flex: 1; }
.comment-section { padding: 12px 16px; border-top: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); }
.comment-meta { font-size: var(--font-caption); color: var(--vscode-descriptionForeground); margin-bottom: 6px; }
.comment-text { white-space: pre-wrap; padding: 8px 12px; border-left: 3px solid var(--vscode-textLink-foreground); background: var(--vscode-textBlockQuote-background, rgba(127,127,127,0.1)); }
.actions { padding: 8px 16px; display: flex; gap: 8px; }
</style>
</head>
<body>
	<div class="snippet-header">
		<div class="file-path">${esc(comment.filePath)}</div>
	</div>
	<div class="code-block">
		${linesHtml}
	</div>
	<div class="comment-section">
		<div class="comment-meta">${esc(comment.owner)} · ${esc(comment.type)} · line ${comment.lineNumber}</div>
		<div class="comment-text">${esc(comment.text)}</div>
	</div>
	<div class="actions">
		${contextLines < 30 ? `<button class="btn" id="showMoreBtn">Show More Context (±${contextLines * 2})</button>` : ''}
		<button class="btn" id="goToFileBtn">Go to File</button>
	</div>
	<script>
		const vscode = acquireVsCodeApi();
		const showMoreBtn = document.getElementById('showMoreBtn');
		if (showMoreBtn) {
			showMoreBtn.addEventListener('click', () => {
				vscode.postMessage({ type: 'showMore', contextLines: ${Math.min(contextLines * 2, 30)} });
			});
		}
		document.getElementById('goToFileBtn').addEventListener('click', () => {
			vscode.postMessage({ type: 'goToFile' });
		});
	</script>
</body>
</html>`;
	}

	private buildErrorHtml(comment: ResolvedComment, err: unknown): string {
		const msg = err instanceof Error ? err.message : String(err);
		return `<!DOCTYPE html><html><head><style>${coreStyles}</style></head><body>
			<div style="padding:16px"><h3>Failed to load snippet</h3>
			<p>${esc(comment.filePath)}:${comment.lineNumber}</p>
			<pre>${esc(msg)}</pre></div></body></html>`;
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
		this.panel.dispose();
	}
}

function esc(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
```

**Step 2: Commit**

```bash
cd /mnt/c/Github/BetterSCM
git add src/views/reviewSnippetPanel.ts
git commit -m "feat(review): add snippet panel showing truncated code with comments"
```

---

### Task 5: Navigation Controller + Command Wiring

**Files:**
- Create: `src/providers/reviewNavigationController.ts`
- Modify: `src/commands/codeReview.ts` (register all new commands)
- Modify: `src/extension.ts:221` (pass dependencies)

**Step 1: Create the navigation controller**

Create `src/providers/reviewNavigationController.ts`:

```typescript
import * as vscode from 'vscode';
import type { ResolvedComment } from '../core/types';

export class ReviewNavigationController implements vscode.Disposable {
	private _comments: ResolvedComment[] = [];
	private _currentIndex = -1;
	private _statusBar: vscode.StatusBarItem;

	constructor() {
		this._statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	}

	setComments(comments: ResolvedComment[]): void {
		this._comments = comments;
		this._currentIndex = comments.length > 0 ? 0 : -1;
		this.updateStatusBar();
	}

	get currentIndex(): number { return this._currentIndex; }
	get count(): number { return this._comments.length; }
	get current(): ResolvedComment | undefined {
		return this._currentIndex >= 0 ? this._comments[this._currentIndex] : undefined;
	}

	next(): ResolvedComment | undefined {
		if (this._comments.length === 0) return undefined;
		this._currentIndex = (this._currentIndex + 1) % this._comments.length;
		this.updateStatusBar();
		return this._comments[this._currentIndex];
	}

	prev(): ResolvedComment | undefined {
		if (this._comments.length === 0) return undefined;
		this._currentIndex = (this._currentIndex - 1 + this._comments.length) % this._comments.length;
		this.updateStatusBar();
		return this._comments[this._currentIndex];
	}

	goTo(comment: ResolvedComment): void {
		const idx = this._comments.findIndex(c => c.id === comment.id);
		if (idx >= 0) {
			this._currentIndex = idx;
			this.updateStatusBar();
		}
	}

	clear(): void {
		this._comments = [];
		this._currentIndex = -1;
		this._statusBar.hide();
	}

	private updateStatusBar(): void {
		if (this._comments.length === 0) {
			this._statusBar.hide();
			return;
		}
		this._statusBar.text = `$(comment) Review Comment ${this._currentIndex + 1}/${this._comments.length}`;
		this._statusBar.tooltip = 'Click to navigate review comments';
		this._statusBar.command = 'plasticScm.nextReviewComment';
		this._statusBar.show();
	}

	dispose(): void {
		this._statusBar.dispose();
	}
}
```

**Step 2: Update codeReview.ts to wire everything together**

Replace `src/commands/codeReview.ts` with the full version including all new commands:

```typescript
import * as vscode from 'vscode';
import { COMMANDS } from '../constants';
import { createCodeReview, listBranches, getCurrentBranch, getReviewComments, resolveRevisionPaths } from '../core/workspace';
import { resolveComments } from '../core/reviewResolver';
import { CodeReviewPanel } from '../views/codeReviewPanel';
import { ReviewSnippetPanel } from '../views/reviewSnippetPanel';
import { logError } from '../util/logger';
import type { CodeReviewsTreeProvider } from '../views/codeReviewsTreeProvider';
import type { ReviewCommentsTreeProvider } from '../views/reviewCommentsTreeProvider';
import type { ReviewNavigationController } from '../providers/reviewNavigationController';
import type { ResolvedComment } from '../core/types';

export function registerCodeReviewCommands(
	context: vscode.ExtensionContext,
	treeProvider: CodeReviewsTreeProvider,
	commentsTree: ReviewCommentsTreeProvider,
	navController: ReviewNavigationController,
): void {
	async function navigateToComment(comment: ResolvedComment | undefined): Promise<void> {
		if (!comment) return;
		await ReviewSnippetPanel.show(comment, context.extensionUri);
	}

	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.createCodeReview, async () => {
			try {
				const branches = await listBranches();
				const current = await getCurrentBranch();

				const items = branches.map(b => ({
					label: b.name,
					description: b.name === current ? '(current)' : b.owner,
					branchId: b.id,
				}));

				const picked = await vscode.window.showQuickPick(items, {
					placeHolder: 'Select branch to review',
					title: 'Create Code Review',
				});
				if (!picked) return;

				const title = await vscode.window.showInputBox({
					prompt: 'Review title',
					value: `Review: ${picked.label}`,
				});
				if (!title) return;

				await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: 'Creating code review...',
					},
					async () => {
						const review = await createCodeReview({
							title,
							targetType: 'Branch',
							targetId: picked.branchId,
							targetSpec: picked.label,
						});

						vscode.window.showInformationMessage(`Created review #${review.id}: ${review.title}`);
						treeProvider.refresh();
						CodeReviewPanel.open(review.id, context.extensionUri);
					},
				);
			} catch (err) {
				logError('Create code review failed', err);
				vscode.window.showErrorMessage(
					`Failed to create review: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}),

		vscode.commands.registerCommand(COMMANDS.openCodeReview, (reviewId: number) => {
			CodeReviewPanel.open(reviewId, context.extensionUri);
		}),

		vscode.commands.registerCommand(COMMANDS.inspectReviewComments, async (commentOrReviewId: ResolvedComment | number) => {
			if (typeof commentOrReviewId === 'object' && 'filePath' in commentOrReviewId) {
				// Direct comment click from tree view
				navController.goTo(commentOrReviewId);
				await navigateToComment(commentOrReviewId);
				return;
			}

			// Review ID — load and resolve all comments
			const reviewId = commentOrReviewId as number;
			try {
				await vscode.window.withProgress(
					{ location: vscode.ProgressLocation.Notification, title: 'Loading review comments...' },
					async () => {
						const comments = await getReviewComments(reviewId);
						const resolved = await resolveComments(comments, resolveRevisionPaths);
						commentsTree.setComments(resolved, `Review #${reviewId}`);
						navController.setComments(resolved);
						vscode.commands.executeCommand('setContext', 'plasticScm.reviewActive', true);

						if (resolved.length > 0) {
							await navigateToComment(resolved[0]);
						} else {
							vscode.window.showInformationMessage('This review has no inline comments.');
						}
					},
				);
			} catch (err) {
				logError('Failed to inspect review comments', err);
				vscode.window.showErrorMessage(`Failed to load comments: ${err instanceof Error ? err.message : String(err)}`);
			}
		}),

		vscode.commands.registerCommand(COMMANDS.nextReviewComment, async () => {
			await navigateToComment(navController.next());
		}),

		vscode.commands.registerCommand(COMMANDS.prevReviewComment, async () => {
			await navigateToComment(navController.prev());
		}),
	);
}
```

**Step 3: Update extension.ts to create and pass the navigation controller**

In `src/extension.ts`, add imports:

```typescript
import { ReviewCommentsTreeProvider } from './views/reviewCommentsTreeProvider';
import { ReviewNavigationController } from './providers/reviewNavigationController';
```

Replace the review-related registration block (around lines 213-221) with:

```typescript
	// Register code reviews tree view
	const codeReviewsTree = new CodeReviewsTreeProvider();
	disposables.add(codeReviewsTree);
	context.subscriptions.push(
		vscode.window.createTreeView('plasticScm.codeReviewsView', {
			treeDataProvider: codeReviewsTree,
		}),
	);

	// Register review comments tree view
	const reviewCommentsTree = new ReviewCommentsTreeProvider();
	disposables.add(reviewCommentsTree);
	context.subscriptions.push(
		vscode.window.createTreeView('plasticScm.reviewCommentsView', {
			treeDataProvider: reviewCommentsTree,
		}),
	);

	// Navigation controller for next/back traversal
	const navController = new ReviewNavigationController();
	disposables.add(navController);

	registerCodeReviewCommands(context, codeReviewsTree, reviewCommentsTree, navController);
```

**Step 4: Commit**

```bash
cd /mnt/c/Github/BetterSCM
git add src/providers/reviewNavigationController.ts src/commands/codeReview.ts src/extension.ts
git commit -m "feat(review): add navigation controller with next/back and status bar"
```

---

### Task 6: Inline Editor Decorations

**Files:**
- Create: `src/providers/reviewDecorationProvider.ts`
- Modify: `src/extension.ts` (register decoration provider)

**Step 1: Create the decoration provider**

Create `src/providers/reviewDecorationProvider.ts`:

```typescript
import * as vscode from 'vscode';
import type { ResolvedComment } from '../core/types';

const commentDecorationType = vscode.window.createTextEditorDecorationType({
	backgroundColor: 'rgba(255, 200, 0, 0.08)',
	isWholeLine: true,
	gutterIconPath: new vscode.ThemeIcon('comment-discussion').id ? undefined : undefined,
	overviewRulerColor: 'rgba(255, 200, 0, 0.6)',
	overviewRulerLane: vscode.OverviewRulerLane.Right,
	after: {
		margin: '0 0 0 2em',
		color: new vscode.ThemeColor('editorCodeLens.foreground'),
	},
});

const gutterDecorationType = vscode.window.createTextEditorDecorationType({
	gutterIconSize: 'contain',
});

export class ReviewDecorationProvider implements vscode.Disposable {
	private _comments: ResolvedComment[] = [];
	private _disposables: vscode.Disposable[] = [];

	constructor() {
		this._disposables.push(
			vscode.window.onDidChangeActiveTextEditor(editor => {
				if (editor) this.applyDecorations(editor);
			}),
			vscode.window.onDidChangeVisibleTextEditors(editors => {
				for (const editor of editors) this.applyDecorations(editor);
			}),
		);
	}

	setComments(comments: ResolvedComment[]): void {
		this._comments = comments;
		// Apply to all visible editors
		for (const editor of vscode.window.visibleTextEditors) {
			this.applyDecorations(editor);
		}
	}

	clear(): void {
		this._comments = [];
		for (const editor of vscode.window.visibleTextEditors) {
			editor.setDecorations(commentDecorationType, []);
		}
	}

	private applyDecorations(editor: vscode.TextEditor): void {
		const editorPath = editor.document.uri.fsPath;

		// Find comments that match this file
		const matching = this._comments.filter(c =>
			normalizePath(c.filePath) === normalizePath(editorPath),
		);

		if (matching.length === 0) {
			editor.setDecorations(commentDecorationType, []);
			return;
		}

		const decorations: vscode.DecorationOptions[] = matching.map(c => {
			const line = Math.max(0, c.lineNumber - 1); // 0-based
			const range = new vscode.Range(line, 0, line, 0);
			const preview = c.text.length > 80 ? c.text.substring(0, 77) + '...' : c.text;
			return {
				range,
				hoverMessage: new vscode.MarkdownString(
					`**${c.owner}** (${c.type})\n\n${c.text}`,
				),
				renderOptions: {
					after: {
						contentText: `  💬 ${preview}`,
					},
				},
			};
		});

		editor.setDecorations(commentDecorationType, decorations);
	}

	dispose(): void {
		this.clear();
		this._disposables.forEach(d => d.dispose());
	}
}

function normalizePath(p: string): string {
	return p.replace(/\\/g, '/').toLowerCase();
}
```

**Step 2: Wire into extension.ts**

Add import:

```typescript
import { ReviewDecorationProvider } from './providers/reviewDecorationProvider';
```

After the navigation controller creation, add:

```typescript
	// Inline decorations for review comments
	const decorationProvider = new ReviewDecorationProvider();
	disposables.add(decorationProvider);
```

Pass `decorationProvider` to `registerCodeReviewCommands` (add as 5th parameter). In `codeReview.ts`, in the `inspectReviewComments` command handler, after `navController.setComments(resolved)`, add:

```typescript
decorationProvider.setComments(resolved);
```

**Step 3: Commit**

```bash
cd /mnt/c/Github/BetterSCM
git add src/providers/reviewDecorationProvider.ts src/extension.ts src/commands/codeReview.ts
git commit -m "feat(review): add inline editor decorations for review comments"
```

---

### Task 7: Audit Export Command

**Files:**
- Create: `src/commands/reviewAuditExport.ts`
- Test: `test/unit/commands/reviewAuditExport.test.ts`
- Modify: `src/commands/codeReview.ts` (register export command)

**Step 1: Write the failing tests**

Create `test/unit/commands/reviewAuditExport.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { generateAuditMarkdown } from '../../../src/commands/reviewAuditExport';
import type { ResolvedComment, CodeReviewInfo } from '../../../src/core/types';

describe('generateAuditMarkdown', () => {
	const review: CodeReviewInfo = {
		id: 43381,
		title: 'Refactor unit config tool',
		status: 'Rework required',
		owner: 'theo@outlook.com',
		created: '2026-02-17T10:00:00',
		modified: '2026-02-17T16:00:00',
		targetType: 'Branch',
		targetSpec: '/main/feature-x',
		targetId: 100,
		commentsCount: 2,
		reviewers: [],
	};

	it('generates markdown with code snippets and comments', () => {
		const comments: ResolvedComment[] = [
			{ id: 1, owner: 'theo@outlook.com', text: 'Fix this null check', type: 'Comment', timestamp: '2026-02-17T15:00:00', filePath: 'Assets/Scripts/Foo.cs', lineNumber: 37 },
		];
		const fileContents = new Map<string, string[]>([
			['Assets/Scripts/Foo.cs', [
				'using System;',          // line 1
				...Array(34).fill(''),     // lines 2-35
				'    if (x == null) {',    // line 36
				'        return null;',    // line 37 (target)
				'    }',                   // line 38
				...Array(2).fill(''),      // lines 39-40
			]],
		]);

		const md = generateAuditMarkdown(review, comments, fileContents, 2);

		expect(md).toContain('# Code Review Audit: Review #43381');
		expect(md).toContain('Refactor unit config tool');
		expect(md).toContain('Rework required');
		expect(md).toContain('## Assets/Scripts/Foo.cs');
		expect(md).toContain('### Line 37');
		expect(md).toContain('theo@outlook.com');
		expect(md).toContain('>> 37');
		expect(md).toContain('Fix this null check');
	});

	it('groups multiple comments under same file', () => {
		const comments: ResolvedComment[] = [
			{ id: 1, owner: 'a', text: 'First', type: 'Comment', timestamp: '', filePath: 'Foo.cs', lineNumber: 5 },
			{ id: 2, owner: 'b', text: 'Second', type: 'Question', timestamp: '', filePath: 'Foo.cs', lineNumber: 20 },
		];
		const fileContents = new Map<string, string[]>([
			['Foo.cs', Array(30).fill('code')],
		]);

		const md = generateAuditMarkdown(review, comments, fileContents, 2);

		// Only one file header
		const fileHeaders = md.match(/## Foo\.cs/g);
		expect(fileHeaders).toHaveLength(1);
		// Two comment sections
		expect(md).toContain('### Line 5');
		expect(md).toContain('### Line 20');
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /mnt/c/Github/BetterSCM && npx vitest run test/unit/commands/reviewAuditExport.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — module not found

**Step 3: Implement**

Create `src/commands/reviewAuditExport.ts`:

```typescript
import * as vscode from 'vscode';
import { logError } from '../util/logger';
import type { CodeReviewInfo, ResolvedComment } from '../core/types';

/**
 * Generate audit Markdown from resolved comments and file contents.
 * Pure function — no side effects — for easy testing.
 */
export function generateAuditMarkdown(
	review: CodeReviewInfo,
	comments: ResolvedComment[],
	fileContents: Map<string, string[]>,
	contextLines = 5,
): string {
	const lines: string[] = [];

	lines.push(`# Code Review Audit: Review #${review.id} — "${review.title}"`);
	lines.push('');
	lines.push(`**Status:** ${review.status} | **Owner:** ${review.owner} | **Target:** ${review.targetType} ${review.targetSpec ?? ''}`);
	lines.push('');
	lines.push('---');

	// Group comments by file (already sorted by file+line from resolveComments)
	const groups = new Map<string, ResolvedComment[]>();
	for (const c of comments) {
		const existing = groups.get(c.filePath) ?? [];
		existing.push(c);
		groups.set(c.filePath, existing);
	}

	for (const [filePath, fileComments] of groups) {
		lines.push('');
		lines.push(`## ${filePath}`);

		const content = fileContents.get(filePath) ?? [];

		for (const comment of fileComments) {
			lines.push('');
			lines.push(`### Line ${comment.lineNumber} — ${comment.type} by ${comment.owner}${comment.timestamp ? ` (${formatDate(comment.timestamp)})` : ''}`);
			lines.push('');

			// Code snippet with context
			const startLine = Math.max(1, comment.lineNumber - contextLines);
			const endLine = Math.min(content.length, comment.lineNumber + contextLines);

			if (content.length > 0) {
				const ext = filePath.split('.').pop() ?? '';
				lines.push('```' + ext);
				for (let i = startLine; i <= endLine; i++) {
					const prefix = i === comment.lineNumber ? '>>' : '  ';
					const lineContent = content[i - 1] ?? '';
					lines.push(`${prefix} ${String(i).padStart(4)} | ${lineContent}`);
				}
				lines.push('```');
			}

			lines.push('');
			lines.push(`> ${comment.text.replace(/\n/g, '\n> ')}`);
			lines.push('');
			lines.push('---');
		}
	}

	return lines.join('\n');
}

function formatDate(iso: string): string {
	if (!iso) return '';
	try {
		const d = new Date(iso);
		return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
	} catch {
		return iso;
	}
}

/**
 * Export audit for a review. Reads file contents and writes Markdown to workspace root.
 */
export async function exportReviewAudit(
	review: CodeReviewInfo,
	comments: ResolvedComment[],
): Promise<void> {
	const wsFolder = vscode.workspace.workspaceFolders?.[0];
	if (!wsFolder) {
		vscode.window.showErrorMessage('No workspace folder open');
		return;
	}

	// Collect unique file paths and read their contents
	const filePaths = [...new Set(comments.map(c => c.filePath))];
	const fileContents = new Map<string, string[]>();

	for (const filePath of filePaths) {
		try {
			const uri = vscode.Uri.file(filePath);
			const doc = await vscode.workspace.openTextDocument(uri);
			fileContents.set(filePath, doc.getText().split('\n'));
		} catch {
			// File might not exist locally — skip
		}
	}

	const markdown = generateAuditMarkdown(review, comments, fileContents);
	const fileName = `review-audit-${review.id}.md`;
	const filePath = vscode.Uri.joinPath(wsFolder.uri, fileName);

	await vscode.workspace.fs.writeFile(filePath, Buffer.from(markdown, 'utf-8'));

	const doc = await vscode.workspace.openTextDocument(filePath);
	await vscode.window.showTextDocument(doc);
	vscode.window.showInformationMessage(`Audit exported to ${fileName}`);
}
```

**Step 4: Wire the export command in codeReview.ts**

In the `registerCodeReviewCommands` function, add the `exportReviewAudit` command registration. Also import `getCodeReview` and `exportReviewAudit`:

```typescript
import { exportReviewAudit } from './reviewAuditExport';
```

Add inside the `context.subscriptions.push(...)` block:

```typescript
		vscode.commands.registerCommand(COMMANDS.exportReviewAudit, async () => {
			const resolved = commentsTree.comments;
			if (resolved.length === 0) {
				vscode.window.showInformationMessage('No review comments to export. Open a review first.');
				return;
			}
			// We need the review info — get the review ID from the first comment's context
			// For now, prompt user (or we could store the review on the tree provider)
			try {
				const { getCodeReview } = await import('../core/workspace');
				// Ask for review ID since we don't have it stored yet
				const idStr = await vscode.window.showInputBox({
					prompt: 'Review ID to export',
					placeHolder: 'e.g. 43381',
				});
				if (!idStr) return;
				const review = await getCodeReview(parseInt(idStr, 10));
				await exportReviewAudit(review, [...resolved]);
			} catch (err) {
				logError('Audit export failed', err);
				vscode.window.showErrorMessage(`Audit export failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}),
```

**Step 5: Run tests to verify they pass**

Run: `cd /mnt/c/Github/BetterSCM && npx vitest run test/unit/commands/reviewAuditExport.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS

**Step 6: Run full test suite**

Run: `cd /mnt/c/Github/BetterSCM && npx vitest run --reporter=verbose 2>&1 | tail -30`
Expected: All tests PASS

**Step 7: Commit**

```bash
cd /mnt/c/Github/BetterSCM
git add src/commands/reviewAuditExport.ts test/unit/commands/reviewAuditExport.test.ts src/commands/codeReview.ts
git commit -m "feat(review): add audit export command generating Markdown issue log"
```

---

### Task 8: Store review ID on tree provider + polish export flow

**Files:**
- Modify: `src/views/reviewCommentsTreeProvider.ts` (store reviewId)
- Modify: `src/commands/codeReview.ts` (use stored reviewId for export)

This task removes the manual review ID prompt from the export command. Instead, the `ReviewCommentsTreeProvider` stores the current review ID when comments are loaded, and the export command reads it automatically.

**Step 1: Add reviewId to tree provider**

In `src/views/reviewCommentsTreeProvider.ts`, add:

```typescript
	private _reviewId = 0;

	get reviewId(): number { return this._reviewId; }

	setComments(comments: ResolvedComment[], reviewTitle: string, reviewId: number): void {
		this._comments = comments;
		this._reviewTitle = reviewTitle;
		this._reviewId = reviewId;
		this._onDidChangeTreeData.fire();
	}
```

**Step 2: Update inspectReviewComments to pass reviewId**

In `src/commands/codeReview.ts`, update the `commentsTree.setComments` call:

```typescript
commentsTree.setComments(resolved, `Review #${reviewId}`, reviewId);
```

**Step 3: Simplify export command to use stored reviewId**

Replace the export command registration:

```typescript
		vscode.commands.registerCommand(COMMANDS.exportReviewAudit, async () => {
			const resolved = commentsTree.comments;
			const reviewId = commentsTree.reviewId;
			if (resolved.length === 0 || !reviewId) {
				vscode.window.showInformationMessage('No review comments to export. Inspect a review first.');
				return;
			}
			try {
				const review = await getCodeReview(reviewId);
				await exportReviewAudit(review, [...resolved]);
			} catch (err) {
				logError('Audit export failed', err);
				vscode.window.showErrorMessage(`Audit export failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}),
```

**Step 4: Run full test suite**

Run: `cd /mnt/c/Github/BetterSCM && npx vitest run --reporter=verbose 2>&1 | tail -30`
Expected: All tests PASS

**Step 5: Commit**

```bash
cd /mnt/c/Github/BetterSCM
git add src/views/reviewCommentsTreeProvider.ts src/commands/codeReview.ts
git commit -m "feat(review): store reviewId on tree provider for seamless export"
```

---

### Task 9: Also populate itemName in CLI comment parser

**Files:**
- Modify: `src/core/backendCli.ts:986` (enhance parseReviewCommentXml)
- Modify: `test/unit/core/backendCli.test.ts` (update existing tests)

Currently `parseReviewCommentXml` doesn't populate `itemName` on comments. While the new `resolveRevisionPaths` handles the resolution, it's useful to have `itemName` available for display in the review panel (line 139 in codeReviewPanel.ts already renders it).

**Step 1: Write the failing test**

Add test in `backendCli.test.ts` within the review comments describe block:

```typescript
it('populates itemName when revisionId can be displayed', async () => {
	const xml = `<REVIEWCOMMENT>
		<ID>100</ID>
		<OWNER>theo</OWNER>
		<DATE>2026-02-17T15:00:00</DATE>
		<COMMENT>Fix this</COMMENT>
		<REVISIONID>42939</REVISIONID>
		<REVIEWID>1</REVIEWID>
		<LOCATION>37</LOCATION>
	</REVIEWCOMMENT>`;

	mockExecCm.mockResolvedValue({ stdout: xml, stderr: '', exitCode: 0 });
	const comments = await backend.getReviewComments(1);

	expect(comments[0].locationSpec).toBe('42939#37');
	expect(comments[0].itemName).toBe('revid:42939');
});
```

**Step 2: Update parser**

In `src/core/backendCli.ts`, in the `parseReviewCommentXml` function, update the comment construction to include `itemName`:

```typescript
		const itemName = revisionId > 0
			? `revid:${revisionId}`
			: undefined;

		comments.push({
			id,
			owner,
			text,
			type,
			timestamp: date,
			locationSpec,
			itemName,
		});
```

**Step 3: Run tests**

Run: `cd /mnt/c/Github/BetterSCM && npx vitest run test/unit/core/backendCli.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS

**Step 4: Commit**

```bash
cd /mnt/c/Github/BetterSCM
git add src/core/backendCli.ts test/unit/core/backendCli.test.ts
git commit -m "feat(review): populate itemName on CLI review comments for display"
```

---

### Task 10: Build verification + uncommitted change cleanup

**Step 1: Commit the previously uncommitted tree provider filter change**

```bash
cd /mnt/c/Github/BetterSCM
git add src/views/codeReviewsTreeProvider.ts
git commit -m "fix(review): default code reviews filter to 'all' instead of 'pending'"
```

**Step 2: Run full build**

Run: `cd /mnt/c/Github/BetterSCM && npm run build:ext 2>&1 | tail -20`
Expected: Build succeeds with no errors

**Step 3: Run full test suite**

Run: `cd /mnt/c/Github/BetterSCM && npx vitest run --reporter=verbose 2>&1 | tail -30`
Expected: All tests PASS

**Step 4: Fix any build/test issues that arise**

Address compilation errors (likely TypeScript import issues or missing parameters). Common fixes:
- Missing imports in extension.ts for new modules
- Parameter count mismatches in registerCodeReviewCommands calls
- Missing workspace.ts re-exports for new functions
