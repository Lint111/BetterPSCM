import * as vscode from 'vscode';
import { listCodeReviews } from '../core/workspace';
import { logError } from '../util/logger';
import type { CodeReviewInfo, ReviewStatus } from '../core/types';

type ReviewFilter = 'all' | 'assignedToMe' | 'createdByMe' | 'pending';

export class CodeReviewsTreeProvider implements vscode.TreeDataProvider<ReviewTreeItem>, vscode.Disposable {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private _filter: ReviewFilter = 'pending';
	private _reviews: CodeReviewInfo[] = [];

	get filter(): ReviewFilter { return this._filter; }

	setFilter(filter: ReviewFilter): void {
		this._filter = filter;
		this.refresh();
	}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	dispose(): void {
		this._onDidChangeTreeData.dispose();
	}

	getTreeItem(element: ReviewTreeItem): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: ReviewTreeItem): Promise<ReviewTreeItem[]> {
		if (element) return [];

		try {
			this._reviews = await listCodeReviews(this._filter);
		} catch (err) {
			if ((err as any)?.name === 'NotSupportedError') {
				return [new ReviewTreeItem('Code reviews require REST API backend', '', 'none')];
			}
			logError('Failed to load code reviews', err);
			return [new ReviewTreeItem('Failed to load reviews', '', 'none')];
		}

		if (this._reviews.length === 0) {
			return [new ReviewTreeItem('No code reviews found', '', 'none')];
		}

		return this._reviews.map(r => {
			const item = new ReviewTreeItem(
				r.title || `Review #${r.id}`,
				`#${r.id} by ${r.owner}`,
				r.status,
			);
			item.tooltip = `${r.title}\nStatus: ${r.status}\nOwner: ${r.owner}\nTarget: ${r.targetType} ${r.targetSpec ?? ''}\nComments: ${r.commentsCount}`;
			item.contextValue = 'codeReview';
			item.command = {
				command: 'plasticScm.openCodeReview',
				title: 'Open Code Review',
				arguments: [r.id],
			};
			return item;
		});
	}
}

const STATUS_ICONS: Record<ReviewStatus | 'none', vscode.ThemeIcon> = {
	'Under review': new vscode.ThemeIcon('eye', new vscode.ThemeColor('charts.yellow')),
	'Reviewed': new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green')),
	'Rework required': new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.red')),
	'none': new vscode.ThemeIcon('info'),
};

class ReviewTreeItem extends vscode.TreeItem {
	constructor(label: string, description: string, status: ReviewStatus | 'none') {
		super(label, vscode.TreeItemCollapsibleState.None);
		this.description = description;
		this.iconPath = STATUS_ICONS[status];
	}
}
