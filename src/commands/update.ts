import * as vscode from 'vscode';
import { COMMANDS } from '../constants';
import { updateWorkspace } from '../core/workspace';
import { logError } from '../util/logger';
import type { PlasticScmProvider } from '../scm/plasticScmProvider';

export function registerUpdateCommands(
	context: vscode.ExtensionContext,
	provider: PlasticScmProvider,
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.update, async () => {
			try {
				await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: 'Updating workspace...',
						cancellable: false,
					},
					async () => {
						const result = await updateWorkspace();

						if (result.conflicts.length > 0) {
							const msg = `Workspace updated with ${result.conflicts.length} conflict(s). Resolve them before continuing.`;
							const action = await vscode.window.showWarningMessage(msg, 'Show Conflicts');
							if (action === 'Show Conflicts') {
								const doc = await vscode.workspace.openTextDocument({
									content: result.conflicts.join('\n'),
									language: 'plaintext',
								});
								await vscode.window.showTextDocument(doc);
							}
						} else {
							vscode.window.showInformationMessage(
								`Workspace updated (${result.updatedFiles} file(s)).`,
							);
						}

						await provider.refresh();
					},
				);
			} catch (err) {
				logError('Update workspace failed', err);
				vscode.window.showErrorMessage(
					`Failed to update workspace: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}),
	);
}
