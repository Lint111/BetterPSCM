import * as vscode from 'vscode';
import type { PlasticScmProvider } from '../scm/plasticScmProvider';
import type { NormalizedChange } from '../core/types';
import { COMMANDS } from '../constants';
import { buildPlasticUri, parsePlasticUri } from '../util/uri';
import { getWorkspaceGuid } from '../api/client';
import { logError } from '../util/logger';
import { PLASTIC_URI_SCHEME } from '../constants';
import { DIFF_CHANGE_TYPES } from '../core/safety';

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
		vscode.commands.registerCommand(COMMANDS.openFile, (...args: unknown[]) => {
			const uri = resolveFileUri(args);
			if (uri) {
				vscode.window.showTextDocument(uri);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			COMMANDS.openChange,
			async (uriOrState: vscode.Uri | vscode.SourceControlResourceState, changeOrStates?: NormalizedChange | vscode.SourceControlResourceState[]) => {
				// Normalize: inline icon passes (ResourceState, ResourceState[]),
				// clicking file name passes (Uri, NormalizedChange) from command.arguments
				let uri: vscode.Uri;
				let change: NormalizedChange | undefined;

				if (uriOrState && typeof uriOrState === 'object' && 'resourceUri' in uriOrState) {
					// Called from inline icon — first arg is SourceControlResourceState
					const state = uriOrState as vscode.SourceControlResourceState;
					uri = state.resourceUri;
					// Extract change from the resource state's command arguments
					change = state.command?.arguments?.[1] as NormalizedChange | undefined;
				} else {
					uri = uriOrState as vscode.Uri;
					change = changeOrStates as NormalizedChange | undefined;
				}

				if (!uri) return;

				// Skip directories — can't open or diff them
				if (change?.dataType === 'Directory') return;

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
					logError(`Failed to open change — ${err instanceof Error ? err.message : err}`, err);
					try {
						await vscode.window.showTextDocument(uri);
					} catch {
						// File may be binary or deleted
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

/**
 * Resolve a file: URI from various command argument shapes:
 * - SourceControlResourceState (from SCM panel inline icons)
 * - SourceControlResourceState[] (multi-select from SCM panel)
 * - vscode.Uri (direct URI)
 * - TabInputTextDiff (from diff editor title bar)
 * - No args (fall back to active editor)
 */
function resolveFileUri(args: unknown[]): vscode.Uri | undefined {
	// Flatten: VS Code may pass array-of-arrays for multi-select
	const first = Array.isArray(args[0]) ? args[0][0] : args[0];

	// SourceControlResourceState — has resourceUri
	if (first && typeof first === 'object' && 'resourceUri' in first) {
		return (first as vscode.SourceControlResourceState).resourceUri;
	}

	// Direct vscode.Uri
	if (first && typeof first === 'object' && 'scheme' in first) {
		const uri = first as vscode.Uri;
		if (uri.scheme !== PLASTIC_URI_SCHEME) return uri;

		// plastic: URI — resolve to workspace file
		const parsed = parsePlasticUri(uri);
		if (!parsed) return undefined;
		const wsFolder = vscode.workspace.workspaceFolders?.[0];
		if (!wsFolder) return undefined;
		return vscode.Uri.joinPath(wsFolder.uri, parsed.filePath);
	}

	// No usable args — try diff editor tab, then active editor
	const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
	const tabInput = activeTab?.input;
	if (tabInput && typeof tabInput === 'object' && 'modified' in tabInput) {
		return (tabInput as vscode.TabInputTextDiff).modified;
	}

	return vscode.window.activeTextEditor?.document.uri;
}
