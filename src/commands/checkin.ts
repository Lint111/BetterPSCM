import * as vscode from 'vscode';
import type { PlasticScmProvider } from '../scm/plasticScmProvider';
import { COMMANDS } from '../constants';
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
	const service = provider.getService();

	// Quick check: any changes at all?
	const allChanges = provider.getAllChanges();
	if (allChanges.length === 0) {
		vscode.window.showWarningMessage('No changes to check in.');
		return;
	}

	// For staged-only mode, check if anything is staged
	if (!all && service.getStagedPaths().length === 0) {
		vscode.window.showWarningMessage('No staged changes to check in. Stage files first.');
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
				title: 'Checking in...',
			},
			async () => {
				const result = await service.checkin({ comment, all });
				vscode.window.showInformationMessage(
					`Checked in as changeset ${result.changesetId}`,
				);
				log(`Checkin result: changeset ${result.changesetId} on branch ${result.branchName}`);

				// Clear state
				provider.clearInputBox();

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
