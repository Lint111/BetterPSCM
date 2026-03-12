import * as vscode from 'vscode';
import type { PlasticScmProvider } from '../scm/plasticScmProvider';
import { getCurrentBranch } from '../core/workspace';
import { COMMANDS } from '../constants';
import { logError } from '../util/logger';

/**
 * Status bar item showing current branch and pending changes count.
 */
export class PlasticStatusBar implements vscode.Disposable {
	private readonly branchItem: vscode.StatusBarItem;
	private readonly changesItem: vscode.StatusBarItem;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly provider: PlasticScmProvider) {
		this.branchItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
		this.branchItem.command = COMMANDS.switchBranch;
		this.branchItem.tooltip = 'Plastic SCM: Current Branch (click to switch)';

		this.changesItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
		this.changesItem.command = COMMANDS.refresh;
		this.changesItem.tooltip = 'Plastic SCM: Pending Changes (click to refresh)';

		// Update changes and branch on status poll
		this.disposables.push(
			provider.onDidChangeStatus(() => {
				this.updateChanges();
				this.updateBranchFromProvider();
			}),
		);

		// Update branch on external branch switch
		this.disposables.push(
			provider.onDidChangeBranch((branch) => {
				this.setBranchText(branch);
			}),
		);

		this.branchItem.show();
		this.changesItem.show();

		// Initial update
		this.update();
	}

	async update(): Promise<void> {
		await this.updateBranch();
		this.updateChanges();
	}

	private async updateBranch(): Promise<void> {
		try {
			const branch = await getCurrentBranch();
			this.setBranchText(branch);
		} catch (err) {
			this.setBranchText(undefined);
			logError('Failed to get current branch', err);
		}
	}

	private updateBranchFromProvider(): void {
		const branch = this.provider.getCurrentBranchName();
		if (branch !== undefined) {
			this.setBranchText(branch);
		}
	}

	private setBranchText(branch: string | undefined): void {
		if (branch) {
			this.branchItem.text = `$(source-control) ${branch}`;
		} else {
			this.branchItem.text = '$(source-control) Plastic SCM';
		}
	}

	private updateChanges(): void {
		const total = this.provider.getPendingCount();
		const staged = this.provider.getStagedCount();

		if (total === 0) {
			this.changesItem.text = '$(check) No changes';
		} else if (staged > 0) {
			this.changesItem.text = `$(git-commit) ${staged}/${total} staged`;
		} else {
			this.changesItem.text = `$(edit) ${total} change${total !== 1 ? 's' : ''}`;
		}
	}

	dispose(): void {
		this.branchItem.dispose();
		this.changesItem.dispose();
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
