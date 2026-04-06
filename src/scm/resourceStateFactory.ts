import * as vscode from 'vscode';
import type { NormalizedChange } from '../core/types';
import { getChangeDecoration, getFolderDecoration } from './decorations';
import { isFolderEntry, shouldOpenDiff } from './entryKind';
import { COMMANDS } from '../constants';

/**
 * Convert a NormalizedChange into a VS Code SourceControlResourceState.
 */
export function createResourceState(
	change: NormalizedChange,
	workspaceRoot: vscode.Uri,
): vscode.SourceControlResourceState {
	const resourceUri = vscode.Uri.joinPath(workspaceRoot, change.path);

	const isDeleted = change.changeType === 'deleted' || change.changeType === 'locallyDeleted';
	const isDirectory = isFolderEntry(change);

	return {
		resourceUri,
		decorations: isDirectory
			? getFolderDecoration(change.changeType)
			: getChangeDecoration(change.changeType),
		// Click rule is centralised in `shouldOpenDiff` so both the live SCM
		// panel and the historic changeset webview apply the same logic.
		command: !isDeleted && shouldOpenDiff(change)
			? {
				title: 'Open Changes',
				command: COMMANDS.openChange,
				arguments: [resourceUri, change],
			}
			: undefined,
		contextValue: isDirectory ? `${change.changeType}:folder` : change.changeType,
	};
}
