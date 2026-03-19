import * as vscode from 'vscode';
import { join } from 'path';
import { log } from '../util/logger';

/**
 * Registers the Plastic SCM MCP server with VS Code's MCP infrastructure.
 * This makes the server discoverable by Copilot and other MCP-aware agents
 * without manual configuration in settings.json.
 *
 * Requires VS Code 1.99+ — gracefully no-ops on older versions.
 */
export function registerMcpServerDefinition(
	context: vscode.ExtensionContext,
	workspaceRoot: string,
): void {
	// vscode.lm.registerMcpServerDefinitionProvider was added in VS Code 1.99
	const lm = vscode.lm as any;
	if (!lm?.registerMcpServerDefinitionProvider) {
		log('MCP server definition API not available (requires VS Code 1.99+)');
		return;
	}

	const McpStdioServerDef = (vscode as any).McpStdioServerDefinition;
	if (!McpStdioServerDef) {
		log('McpStdioServerDefinition not available (requires VS Code 1.99+)');
		return;
	}

	const serverScript = join(context.extensionUri.fsPath, 'dist', 'mcp-server.js');

	const didChangeEmitter = new vscode.EventEmitter<void>();

	const disposable = lm.registerMcpServerDefinitionProvider('bpscmMcp', {
		onDidChangeMcpServerDefinitions: didChangeEmitter.event,

		provideMcpServerDefinitions: async () => {
			return [
				new McpStdioServerDef(
					'BetterPSCM',
					'node',
					[serverScript, '--workspace', workspaceRoot],
					undefined,
					'0.1.0',
				),
			];
		},

		resolveMcpServerDefinition: async (server: unknown) => {
			return server;
		},
	});

	context.subscriptions.push(disposable);
	context.subscriptions.push(didChangeEmitter);
	log('Registered MCP server definition provider');
}
