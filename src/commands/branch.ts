import * as vscode from 'vscode';
import type { PlasticScmProvider } from '../scm/plasticScmProvider';
import { listBranches, createBranch, deleteBranch, switchBranch, getCurrentBranch } from '../core/workspace';
import { COMMANDS } from '../constants';
import { logError } from '../util/logger';

export function registerBranchCommands(
	context: vscode.ExtensionContext,
	provider: PlasticScmProvider,
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
		vscode.commands.registerCommand(COMMANDS.deleteBranch, async () => {
			try {
				const [branches, current] = await Promise.all([
					listBranches(),
					getCurrentBranch(),
				]);

				const items = branches
					.filter(b => b.name !== current)
					.map(b => ({
						label: b.name,
						description: b.owner,
					}));

				const picked = await vscode.window.showQuickPick(items, {
					placeHolder: 'Select branch to delete',
				});

				if (!picked) return;

				const branch = branches.find(b => b.name === picked.label);
				if (!branch) return;

				const answer = await vscode.window.showWarningMessage(
					`Delete branch "${branch.name}"?`,
					{ modal: true },
					'Delete',
				);

				if (answer !== 'Delete') return;

				await deleteBranch(branch.id);

				vscode.window.showInformationMessage(`Branch ${branch.name} deleted`);
			} catch (err) {
				logError('Delete branch failed', err);
				vscode.window.showErrorMessage(
					`Failed to delete branch: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}),
	);
}
