import * as vscode from 'vscode';
import type { PlasticScmProvider } from '../scm/plasticScmProvider';
import { COMMANDS } from '../constants';

/**
 * Register staging commands: stage, unstage, stageAll, unstageAll.
 */
export function registerStagingCommands(
	context: vscode.ExtensionContext,
	provider: PlasticScmProvider,
): void {
	const staging = provider.getStagingManager();

	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.stage, (...resourceStates: vscode.SourceControlResourceState[]) => {
			const paths = extractPaths(resourceStates);
			if (paths.length > 0) {
				const allChangePaths = new Set(provider.getAllChanges().map(c => c.path));
				staging.stage(expandMetaPairs(paths, allChangePaths));
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.unstage, (...resourceStates: vscode.SourceControlResourceState[]) => {
			const paths = extractPaths(resourceStates);
			if (paths.length > 0) {
				const allChangePaths = new Set(provider.getAllChanges().map(c => c.path));
				staging.unstage(expandMetaPairs(paths, allChangePaths));
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.stageAll, () => {
			const changes = provider.getAllChanges();
			const { unstaged } = staging.splitChanges(changes);
			staging.stageAll(unstaged);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.unstageAll, () => {
			staging.unstageAll();
		}),
	);
}

/**
 * Extract workspace-relative paths from resource states.
 * The SCM API may pass resource states as individual args or as an array.
 */
function extractPaths(args: unknown[]): string[] {
	const paths: string[] = [];

	for (const arg of args) {
		if (Array.isArray(arg)) {
			for (const item of arg) {
				const p = getPathFromResourceState(item);
				if (p) paths.push(p);
			}
		} else {
			const p = getPathFromResourceState(arg);
			if (p) paths.push(p);
		}
	}

	return paths;
}

/**
 * Expand paths to include .meta counterparts (Unity convention).
 * If staging foo.cs, also stage foo.cs.meta if it exists in changes (and vice versa).
 */
function expandMetaPairs(paths: string[], allChangePaths: Set<string>): string[] {
	const result = new Set(paths);
	for (const p of paths) {
		if (p.endsWith('.meta')) {
			const base = p.slice(0, -5);
			if (allChangePaths.has(base)) result.add(base);
		} else {
			const meta = p + '.meta';
			if (allChangePaths.has(meta)) result.add(meta);
		}
	}
	return [...result];
}

function getPathFromResourceState(state: unknown): string | undefined {
	if (state && typeof state === 'object' && 'resourceUri' in state) {
		const uri = (state as vscode.SourceControlResourceState).resourceUri;
		// Extract workspace-relative path
		const wsFolder = vscode.workspace.workspaceFolders?.[0];
		if (wsFolder) {
			const relative = vscode.workspace.asRelativePath(uri, false);
			return relative;
		}
		return uri.fsPath;
	}
	return undefined;
}
