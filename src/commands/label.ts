import * as vscode from 'vscode';
import { listLabels, createLabel, deleteLabel } from '../core/workspace';
import { COMMANDS } from '../constants';
import { logError } from '../util/logger';

export function registerLabelCommands(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.createLabel, async () => {
			try {
				const name = await vscode.window.showInputBox({
					prompt: 'Label name',
					placeHolder: 'v1.0.0',
				});
				if (!name) return;

				const csInput = await vscode.window.showInputBox({
					prompt: 'Changeset ID to label (leave empty for latest)',
					placeHolder: '123',
				});

				const changesetId = csInput ? parseInt(csInput, 10) : 0;
				if (csInput && isNaN(changesetId)) {
					vscode.window.showWarningMessage('Invalid changeset ID');
					return;
				}

				const comment = await vscode.window.showInputBox({
					prompt: 'Label comment (optional)',
				});

				const label = await createLabel({
					name,
					changesetId,
					comment: comment || undefined,
				});

				vscode.window.showInformationMessage(`Label "${label.name}" created`);
			} catch (err) {
				logError('Create label failed', err);
				vscode.window.showErrorMessage(
					`Failed to create label: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}),
	);
}
