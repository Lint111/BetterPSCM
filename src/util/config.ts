import { SETTINGS } from '../constants';
import { isCmAvailable } from '../core/cmCli';
import { resolveConfig, type ResolvedConfig } from './configResolver';

// vscode is optional — unavailable when running as standalone MCP server.
// Use dynamic import so the module loads even when 'vscode' isn't present.
// In the extension context, vscode is resolved by the host; in tests, vitest
// aliases it to a mock; in the MCP server, it simply stays undefined.
let vsc: typeof import('vscode') | undefined;
try {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	vsc = require('vscode');
} catch {
	// Running outside VS Code (e.g., MCP server process)
}

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
 * Called once during extension activation or MCP server startup.
 */
export function initDetectedConfig(workspacePath: string): void {
	detectedConfig = resolveConfig(workspacePath);
}

/**
 * Allow tests/MCP to inject a vscode-like module for getConfig().
 */
export function setVscModule(mod: typeof import('vscode') | undefined): void {
	vsc = mod;
}

/**
 * Get the effective config.
 * - In VS Code: detection as base, VS Code settings override if explicitly set.
 * - Standalone (MCP server): detection-only, no VS Code settings layer.
 */
export function getConfig(): PlasticConfig {
	// Base: detected values from .plastic folder
	const base: PlasticConfig = {
		serverUrl: (detectedConfig?.serverUrl || '').replace(/\/+$/, ''),
		organizationName: detectedConfig?.organizationName || '',
		repositoryName: detectedConfig?.repositoryName || '',
		workspaceGuid: detectedConfig?.workspaceGuid || '',
		pollInterval: 3000,
		showPrivateFiles: true,
		mcpEnabled: false,
	};

	// If vscode is not available, return detection-only config
	if (!vsc) return base;

	// Override with any explicitly-set VS Code settings
	const cfg = vsc.workspace.getConfiguration();

	const vscServerUrl = cfg.get<string>(SETTINGS.serverUrl, '');
	const vscOrgName = cfg.get<string>(SETTINGS.organizationName, '');
	const vscRepoName = cfg.get<string>(SETTINGS.repositoryName, '');
	const vscWsGuid = cfg.get<string>(SETTINGS.workspaceGuid, '');

	return {
		serverUrl: (vscServerUrl || base.serverUrl).replace(/\/+$/, ''),
		organizationName: vscOrgName || base.organizationName,
		repositoryName: vscRepoName || base.repositoryName,
		workspaceGuid: vscWsGuid || base.workspaceGuid,
		pollInterval: cfg.get<number>(SETTINGS.pollInterval, 3000),
		showPrivateFiles: cfg.get<boolean>(SETTINGS.showPrivateFiles, true),
		mcpEnabled: cfg.get<boolean>(SETTINGS.mcpEnabled, false),
	};
}

export function isConfigured(): boolean {
	const cfg = getConfig();
	return !!(cfg.serverUrl && cfg.organizationName) || isCmAvailable();
}
