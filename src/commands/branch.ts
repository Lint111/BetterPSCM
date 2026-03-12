import * as vscode from 'vscode';
import type { PlasticScmProvider } from '../scm/plasticScmProvider';
import type { BranchesTreeProvider, BranchTreeItem } from '../views/branchesTreeProvider';
import { listBranches, createBranch, deleteBranch, switchBranch, getCurrentBranch } from '../core/workspace';
import { COMMANDS } from '../constants';
import { logError } from '../util/logger';

export function registerBranchCommands(
	context: vscode.ExtensionContext,
	provider: PlasticScmProvider,
	branchTree: BranchesTreeProvider,
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.switchBranch, async () => {
			try {
				const [branches, current] = await Promise.all([
					listBranches(),
					getCurrentBranch(),
				]);
				const items = branches
					.filter(b => b.name !== current)
					.map(b => ({
						label: b.name,
						description: b.isMain ? 'main' : b.owner,
					}));

				const picked = await vscode.window.showQuickPick(items, {
					placeHolder: 'Select branch to switch to',
				});

				if (!picked) return;

				await switchBranch(picked.label);
				await provider.refresh();
				branchTree.refresh();

				vscode.window.showInformationMessage(`Switched to ${picked.label}`);
			} catch (err) {
				logError('Switch branch failed', err);
				vscode.window.showErrorMessage(
					`Failed to switch branch: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.createBranch, async () => {
			try {
				const name = await vscode.window.showInputBox({
					prompt: 'Enter new branch name',
					placeHolder: '/main/my-feature',
				});

				if (!name) return;

				await createBranch(name);
				branchTree.refresh();

				vscode.window.showInformationMessage(`Branch ${name} created`);
			} catch (err) {
				logError('Create branch failed', err);
				vscode.window.showErrorMessage(
					`Failed to create branch: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.deleteBranch, async (item?: BranchTreeItem) => {
			if (!item?.branch) return;

			if (item.branch.isCurrent) {
				vscode.window.showWarningMessage('Cannot delete the current branch.');
				return;
			}

			const answer = await vscode.window.showWarningMessage(
				`Delete branch "${item.branch.name}"?`,
				{ modal: true },
				'Delete',
			);

			if (answer !== 'Delete') return;

			try {
				await deleteBranch(item.branch.id);
				branchTree.refresh();

				vscode.window.showInformationMessage(`Branch ${item.branch.name} deleted`);
			} catch (err) {
				logError('Delete branch failed', err);
				vscode.window.showErrorMessage(
					`Failed to delete branch: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.refreshBranches, () => {
			branchTree.refresh();
		}),
	);
}
