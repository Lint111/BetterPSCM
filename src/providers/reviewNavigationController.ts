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
