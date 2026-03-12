import * as vscode from 'vscode';
import type { NormalizedChange } from '../core/types';
import { getChangeDecoration } from './decorations';
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

	return {
		resourceUri,
		decorations: getChangeDecoration(change.changeType),
		command: isDeleted
			? undefined
			: {
				title: 'Open Changes',
				command: COMMANDS.openChange,
				arguments: [resourceUri, change],
			},
		contextValue: change.changeType,
	};
}
