import * as vscode from 'vscode';
import type { PlasticScmProvider } from '../scm/plasticScmProvider';
import { COMMANDS } from '../constants';
import { checkinFiles } from '../core/workspace';
import { log, logError } from '../util/logger';

/**
 * Register check-in commands: checkin (staged only) and checkinAll.
 */
export function registerCheckinCommands(
	context: vscode.ExtensionContext,
	provider: PlasticScmProvider,
): void {
	// Check in staged files only
	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.checkin, async () => {
			await performCheckin(provider, false);
		}),
	);

	// Check in all pending changes
	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.checkinAll, async () => {
			await performCheckin(provider, true);
		}),
	);
}

async function performCheckin(provider: PlasticScmProvider, all: boolean): Promise<void> {
	const staging = provider.getStagingManager();
	const allChanges = provider.getAllChanges();

	// Determine which paths to check in
	let paths: string[];
	if (all) {
		paths = allChanges.map(c => c.path);
	} else {
		const { staged } = staging.splitChanges(allChanges);
		paths = staged.map(c => c.path);
	}

	if (paths.length === 0) {
		vscode.window.showWarningMessage(
			all ? 'No changes to check in.' : 'No staged changes to check in. Stage files first.',
		);
		return;
	}

	// Get commit message
	let comment = provider.getInputBoxValue().trim();
	if (!comment) {
		comment = await vscode.window.showInputBox({
			prompt: 'Check-in comment',
			placeHolder: 'Enter a comment for this check-in',
		}) ?? '';
	}

	if (!comment) {
		vscode.window.showWarningMessage('Check-in cancelled: no comment provided.');
		return;
	}

	try {
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.SourceControl,
				title: `Checking in ${paths.length} file(s)...`,
			},
			async () => {
				const result = await checkinFiles(paths, comment);
				vscode.window.showInformationMessage(
					`Checked in ${paths.length} file(s) as changeset ${result.changesetId}`,
				);
				log(`Checkin result: changeset ${result.changesetId} on branch ${result.branchName}`);

				// Clear state
				provider.clearInputBox();
				if (!all) {
					staging.unstageAll();
				}

				// Refresh status
				await provider.refresh();
			},
		);
	} catch (err) {
		logError('Check-in failed', err);
		const msg = err instanceof Error ? err.message : 'Unknown error';
		vscode.window.showErrorMessage(`Check-in failed: ${msg}`);
	}
}
