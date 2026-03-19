import * as vscode from 'vscode';
import type { ResolvedComment } from '../core/types';

type TreeElement = FileGroupItem | CommentItem;

export class ReviewCommentsTreeProvider implements vscode.TreeDataProvider<TreeElement>, vscode.Disposable {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private _comments: ResolvedComment[] = [];
	private _reviewTitle = '';
	private _reviewId = 0;

	get reviewId(): number { return this._reviewId; }
	get comments(): readonly ResolvedComment[] { return this._comments; }

	setComments(comments: ResolvedComment[], reviewTitle: string, reviewId: number): void {
		this._comments = comments;
		this._reviewTitle = reviewTitle;
		this._reviewId = reviewId;
		this._onDidChangeTreeData.fire();
	}

	clear(): void {
		this._comments = [];
		this._reviewTitle = '';
		this._reviewId = 0;
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
			command: 'bpscm.inspectReviewComments',
			title: 'Inspect Comment',
			arguments: [comment],
		};
	}
}
