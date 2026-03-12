import * as vscode from 'vscode';
import { SETTINGS } from '../constants';
import { isCmAvailable } from '../core/cmCli';

export interface PlasticConfig {
	serverUrl: string;
	organizationName: string;
	repositoryName: string;
	workspaceGuid: string;
	pollInterval: number;
	showPrivateFiles: boolean;
	mcpEnabled: boolean;
}

export function getConfig(): PlasticConfig {
	const cfg = vscode.workspace.getConfiguration();
	return {
		serverUrl: cfg.get<string>(SETTINGS.serverUrl, '').replace(/\/+$/, ''),
		organizationName: cfg.get<string>(SETTINGS.organizationName, ''),
		repositoryName: cfg.get<string>(SETTINGS.repositoryName, ''),
		workspaceGuid: cfg.get<string>(SETTINGS.workspaceGuid, ''),
		pollInterval: cfg.get<number>(SETTINGS.pollInterval, 3000),
		showPrivateFiles: cfg.get<boolean>(SETTINGS.showPrivateFiles, true),
		mcpEnabled: cfg.get<boolean>(SETTINGS.mcpEnabled, false),
	};
}

export function isConfigured(): boolean {
	const cfg = getConfig();
	// Configured if REST API settings are present OR cm CLI is available
	return !!(cfg.serverUrl && cfg.organizationName) || isCmAvailable();
}
