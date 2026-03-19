import * as vscode from 'vscode';
import { SETTINGS } from '../constants';
import { isCmAvailable } from '../core/cmCli';
import { resolveConfig, type ResolvedConfig } from './configResolver';

export interface PlasticConfig {
	serverUrl: string;
	organizationName: string;
	repositoryName: string;
	workspaceGuid: string;
	pollInterval: number;
	showPrivateFiles: boolean;
	mcpEnabled: boolean;
}

/** Cached detected config from .plastic folder. Set once during activation. */
let detectedConfig: ResolvedConfig | undefined;

/**
 * Initialize detected config from workspace path.
 * Called once during extension activation.
 */
export function initDetectedConfig(workspacePath: string): void {
	detectedConfig = resolveConfig(workspacePath);
}

/**
 * Get the effective config: detection as base, VS Code settings as overrides.
 * VS Code settings only override when explicitly set (non-empty string).
 */
export function getConfig(): PlasticConfig {
	const cfg = vscode.workspace.getConfiguration();

	// VS Code settings (empty string = not set by user)
	const vscServerUrl = cfg.get<string>(SETTINGS.serverUrl, '');
	const vscOrgName = cfg.get<string>(SETTINGS.organizationName, '');
	const vscRepoName = cfg.get<string>(SETTINGS.repositoryName, '');
	const vscWsGuid = cfg.get<string>(SETTINGS.workspaceGuid, '');

	return {
		// Detection first, VS Code settings override if explicitly set
		serverUrl: (vscServerUrl || detectedConfig?.serverUrl || '').replace(/\/+$/, ''),
		organizationName: vscOrgName || detectedConfig?.organizationName || '',
		repositoryName: vscRepoName || detectedConfig?.repositoryName || '',
		workspaceGuid: vscWsGuid || detectedConfig?.workspaceGuid || '',
		// Extension-only settings (no detection equivalent)
		pollInterval: cfg.get<number>(SETTINGS.pollInterval, 3000),
		showPrivateFiles: cfg.get<boolean>(SETTINGS.showPrivateFiles, true),
		mcpEnabled: cfg.get<boolean>(SETTINGS.mcpEnabled, false),
	};
}

export function isConfigured(): boolean {
	const cfg = getConfig();
	return !!(cfg.serverUrl && cfg.organizationName) || isCmAvailable();
}
