import * as vscode from 'vscode';
import { PLASTIC_URI_SCHEME } from '../constants';

/**
 * Build a plastic: URI for fetching original file content (for diffs).
 * Format: plastic://{workspaceGuid}/{filePath}?{revisionGuid}
 *
 * The revSpec goes in the query string because it can contain '/' characters
 * (e.g. serverpath:/Assets/Scripts/foo.cs) which would break path-based parsing.
 */
export function buildPlasticUri(workspaceGuid: string, revisionGuid: string, filePath: string): vscode.Uri {
	return vscode.Uri.from({
		scheme: PLASTIC_URI_SCHEME,
		authority: workspaceGuid,
		path: `/${filePath}`,
		query: revisionGuid,
	});
}

/**
 * Parse a plastic: URI back into its components.
 */
export function parsePlasticUri(uri: vscode.Uri): { workspaceGuid: string; revisionGuid: string; filePath: string } | undefined {
	if (uri.scheme !== PLASTIC_URI_SCHEME) return undefined;
	const workspaceGuid = uri.authority;
	const revisionGuid = uri.query;
	const filePath = uri.path.startsWith('/') ? uri.path.substring(1) : uri.path;
	if (!revisionGuid || !filePath) return undefined;
	return { workspaceGuid, revisionGuid, filePath };
}
