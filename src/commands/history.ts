import * as vscode from 'vscode';
import { getFileHistory, getBlame } from '../core/workspace';
import { COMMANDS } from '../constants';
import { logError } from '../util/logger';

export function registerHistoryCommands(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.showFileHistory, async (uri?: vscode.Uri) => {
			try {
				const fileUri = uri ?? vscode.window.activeTextEditor?.document.uri;
				if (!fileUri) {
					vscode.window.showWarningMessage('No file selected');
					return;
				}

				const wsFolder = vscode.workspace.workspaceFolders?.[0];
				if (!wsFolder) return;

				const relativePath = vscode.workspace.asRelativePath(fileUri, false);
				const entries = await getFileHistory(relativePath);

				if (entries.length === 0) {
					vscode.window.showInformationMessage('No history found for this file.');
					return;
				}

				const items = entries.map(e => ({
					label: `cs:${e.changesetId}`,
					description: `${e.owner} — ${e.branch}`,
					detail: e.comment || '(no comment)',
					entry: e,
				}));

				const picked = await vscode.window.showQuickPick(items, {
					placeHolder: `History for ${relativePath} (${entries.length} revisions)`,
				});

				if (picked) {
					vscode.window.showInformationMessage(
						`cs:${picked.entry.changesetId} by ${picked.entry.owner} on ${picked.entry.date}`,
					);
				}
			} catch (err) {
				logError('File history failed', err);
				vscode.window.showErrorMessage(
					`Failed to get file history: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.annotateFile, async (uri?: vscode.Uri) => {
			try {
				const fileUri = uri ?? vscode.window.activeTextEditor?.document.uri;
				if (!fileUri) {
					vscode.window.showWarningMessage('No file selected');
					return;
				}

				const relativePath = vscode.workspace.asRelativePath(fileUri, false);

				await vscode.window.withProgress({
					location: vscode.ProgressLocation.Notification,
					title: 'Loading blame annotations...',
					cancellable: false,
				}, async () => {
					const lines = await getBlame(relativePath);

					if (lines.length === 0) {
						vscode.window.showInformationMessage('No blame data found for this file.');
						return;
					}

					// Show blame in a virtual document
					const content = lines.map(l =>
						`${String(l.lineNumber).padStart(5)} | cs:${String(l.changesetId).padStart(5)} | ${l.author.padEnd(20).substring(0, 20)} | ${l.date.padEnd(10).substring(0, 10)} | ${l.content}`,
					).join('\n');

					const doc = await vscode.workspace.openTextDocument({
						content,
						language: 'plaintext',
					});
					await vscode.window.showTextDocument(doc, { preview: true });
				});
			} catch (err) {
				logError('Annotate failed', err);
				vscode.window.showErrorMessage(
					`Failed to annotate file: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}),
	);
}
