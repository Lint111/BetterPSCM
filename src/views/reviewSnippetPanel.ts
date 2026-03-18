import * as vscode from 'vscode';
import { coreStyles } from './webviewStyles';
import { logError } from '../util/logger';
import type { ResolvedComment } from '../core/types';

export class ReviewSnippetPanel implements vscode.Disposable {
	static readonly viewType = 'plasticScm.reviewSnippetPanel';
	private static instance: ReviewSnippetPanel | undefined;

	private readonly panel: vscode.WebviewPanel;
	private disposables: vscode.Disposable[] = [];
	private currentComment: ResolvedComment | undefined;

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
			const content = await this.fetchFileLines(comment);
			const totalLines = content.length;
			const targetLine = comment.lineNumber;
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
		try {
			const uri = vscode.Uri.file(comment.filePath);
			const doc = await vscode.workspace.openTextDocument(uri);
			return doc.getText().split('\n');
		} catch {
			return [];
		}
	}

	private buildHtml(
		comment: ResolvedComment,
		lines: string[],
		startLine: number,
		targetLine: number,
		contextLines: number,
		_totalLines: number,
	): string {
		const linesHtml = lines.map((line, i) => {
			const lineNum = startLine + i;
			const isTarget = lineNum === targetLine;
			return `<div class="code-line ${isTarget ? 'target-line' : ''}"><span class="line-num">${lineNum}</span><span class="line-text">${esc(line)}</span></div>`;
		}).join('');

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
