import * as vscode from 'vscode';
import type { PlasticScmProvider } from '../scm/plasticScmProvider';
import type { NormalizedChange } from '../core/types';
import { COMMANDS } from '../constants';
import { buildPlasticUri } from '../util/uri';
import { getWorkspaceGuid } from '../api/client';
import { logError } from '../util/logger';

const DIFF_CHANGE_TYPES = new Set([
	'changed', 'checkedOut', 'replaced', 'moved', 'copied',
]);

export function registerGeneralCommands(
	context: vscode.ExtensionContext,
	provider: PlasticScmProvider,
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.refresh, async () => {
			await provider.refresh();
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.openFile, (uri: vscode.Uri) => {
			if (uri) {
				vscode.window.showTextDocument(uri);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			COMMANDS.openChange,
			async (uri: vscode.Uri, change?: NormalizedChange) => {
				if (!uri) return;

				try {
					if (!change || !DIFF_CHANGE_TYPES.has(change.changeType)) {
						await vscode.window.showTextDocument(uri);
						return;
					}

					const wsGuid = getWorkspaceGuid();
					const revSpec = change.revisionGuid ?? `serverpath:/${change.path}`;
					const originalUri = buildPlasticUri(wsGuid, revSpec, change.path);

					const fileName = change.path.split('/').pop() ?? change.path;
					const title = `${fileName} (Base ↔ Working)`;

					await vscode.commands.executeCommand('vscode.diff', originalUri, uri, title);
				} catch (err) {
					logError('Failed to open change', err);
					// Fall back to opening the file directly
					try {
						await vscode.window.showTextDocument(uri);
					} catch {
						// File may be binary or deleted — nothing more we can do
					}
				}
			},
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.revertChange, async (...resourceStates: vscode.SourceControlResourceState[]) => {
			const uris: vscode.Uri[] = [];
			for (const arg of resourceStates) {
				if (Array.isArray(arg)) {
					for (const item of arg) {
						if (item?.resourceUri) uris.push(item.resourceUri);
					}
				} else if (arg?.resourceUri) {
					uris.push(arg.resourceUri);
				}
			}

			if (uris.length === 0) return;

			const fileNames = uris.map(u => vscode.workspace.asRelativePath(u)).join(', ');
			const answer = await vscode.window.showWarningMessage(
				`Are you sure you want to revert ${uris.length} file(s)?\n${fileNames}`,
				{ modal: true },
				'Revert',
			);

			if (answer !== 'Revert') return;

			vscode.window.showInformationMessage('Revert will be implemented in a future update.');
		}),
	);
}
