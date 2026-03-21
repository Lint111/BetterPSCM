import * as vscode from 'vscode';
import type { ResolvedComment } from '../core/types';
import { normalizePath } from '../util/path';

const commentDecorationType = vscode.window.createTextEditorDecorationType({
	backgroundColor: 'rgba(255, 200, 0, 0.08)',
	isWholeLine: true,
	overviewRulerColor: 'rgba(255, 200, 0, 0.6)',
	overviewRulerLane: vscode.OverviewRulerLane.Right,
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
		const matching = this._comments.filter(c =>
			normalizePathCaseInsensitive(c.filePath) === normalizePathCaseInsensitive(editorPath),
		);

		if (matching.length === 0) {
			editor.setDecorations(commentDecorationType, []);
			return;
		}

		const decorations: vscode.DecorationOptions[] = matching.map(c => {
			const line = Math.max(0, c.lineNumber - 1);
			const range = new vscode.Range(line, 0, line, 0);
			const preview = c.text.length > 80 ? c.text.substring(0, 77) + '...' : c.text;
			return {
				range,
				hoverMessage: new vscode.MarkdownString(
					`**${c.owner}** (${c.type})\n\n${c.text}`,
				),
				renderOptions: {
					after: {
						contentText: `  \u{1F4AC} ${preview}`,
						color: new vscode.ThemeColor('editorCodeLens.foreground'),
						margin: '0 0 0 2em',
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

function normalizePathCaseInsensitive(p: string): string {
	return normalizePath(p).toLowerCase();
}
