import { detectWorkspace } from './plasticDetector';
import { log } from './logger';

/**
 * Core config fields derived from workspace detection.
 * No vscode dependency — usable by both extension and MCP server.
 */
export interface ResolvedConfig {
	serverUrl: string;
	organizationName: string;
	repositoryName: string;
	workspaceGuid: string;
}

/**
 * Resolve Plastic SCM config by reading the .plastic folder in the workspace root.
 * Returns the detected config, or undefined if no workspace is found.
 */
export function resolveConfig(workspacePath: string): ResolvedConfig | undefined {
	const info = detectWorkspace(workspacePath);
	if (!info) return undefined;

	log(`[resolveConfig] detected: org="${info.organizationName}", repo="${info.repositoryName}", server="${info.serverUrl}"`);

	return {
		serverUrl: info.serverUrl.replace(/\/+$/, ''),
		organizationName: info.organizationName,
		repositoryName: info.repositoryName,
		workspaceGuid: info.workspaceGuid,
	};
}
