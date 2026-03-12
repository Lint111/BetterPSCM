import * as vscode from 'vscode';
import { listBranches, getCurrentBranch } from '../core/workspace';
import { logError } from '../util/logger';
import type { BranchInfo } from '../core/types';

export class BranchTreeItem {
	constructor(public readonly branch: BranchInfo & { isCurrent: boolean }) {}
}

export class BranchesTreeProvider implements vscode.TreeDataProvider<BranchTreeItem> {
	private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>();
	public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

	refresh(): void {
		this.onDidChangeTreeDataEmitter.fire();
	}

	getTreeItem(element: BranchTreeItem): vscode.TreeItem {
		const item = new vscode.TreeItem(element.branch.name, vscode.TreeItemCollapsibleState.None);
		item.description = element.branch.isCurrent
			? `${element.branch.owner} · ${element.branch.date} · current`
			: `${element.branch.owner} · ${element.branch.date}`;
		item.tooltip = [
			element.branch.name,
			`Owner: ${element.branch.owner}`,
			`Date: ${element.branch.date}`,
			element.branch.comment ? `Comment: ${element.branch.comment}` : '',
		].filter(Boolean).join('\n');
		item.contextValue = element.branch.isCurrent ? 'branch:current' : 'branch';
		item.iconPath = element.branch.isCurrent
			? new vscode.ThemeIcon('check')
			: new vscode.ThemeIcon('git-branch');
		return item;
	}

	async getChildren(element?: BranchTreeItem): Promise<BranchTreeItem[]> {
		if (element) return []; // Flat list, no nesting

		try {
			const [branches, currentBranch] = await Promise.all([
				listBranches(),
				getCurrentBranch(),
			]);

			const sorted = branches.map(b => ({
				...b,
				isCurrent: b.name === currentBranch,
			})).sort((a, b) => {
				if (a.isCurrent && !b.isCurrent) return -1;
				if (!a.isCurrent && b.isCurrent) return 1;
				if (a.isMain && !b.isMain) return -1;
				if (!a.isMain && b.isMain) return 1;
				return a.name.localeCompare(b.name);
			});

			return sorted.map(b => new BranchTreeItem(b));
		} catch (err) {
			logError('Failed to load branches', err);
			return [];
		}
	}

	dispose(): void {
		this.onDidChangeTreeDataEmitter.dispose();
	}
}
