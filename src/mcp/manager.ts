import * as vscode from 'vscode';
import { fork, ChildProcess } from 'child_process';
import { join } from 'path';
import { log, logError } from '../util/logger';

/**
 * Manages the lifecycle of the MCP server child process.
 * Spawns dist/mcp-server.js as a separate Node process with stdio transport.
 * Listens for IPC messages from the MCP process to notify the extension
 * when workspace state changes (checkin, stage, undo, etc.).
 */
export class McpServerManager implements vscode.Disposable {
	private process: ChildProcess | undefined;
	private readonly serverScript: string;
	private readonly workspaceRoot: string;

	private readonly _onStateChanged = new vscode.EventEmitter<string>();
	/** Fires when the MCP server performs a state-mutating operation. */
	public readonly onStateChanged = this._onStateChanged.event;

	constructor(extensionUri: vscode.Uri, workspaceRoot: string) {
		// The built MCP server bundle lives alongside extension.js in dist/
		this.serverScript = join(extensionUri.fsPath, 'dist', 'mcp-server.js');
		this.workspaceRoot = workspaceRoot;
	}

	start(): void {
		if (this.process) {
			log('MCP server already running');
			return;
		}

		try {
			this.process = fork(this.serverScript, [
				'--workspace', this.workspaceRoot,
			], {
				stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
				silent: true,
			});

			this.process.stderr?.on('data', (data: Buffer) => {
				log(`[MCP] ${data.toString().trimEnd()}`);
			});

			this.process.on('message', (msg: unknown) => {
				if (msg && typeof msg === 'object' && (msg as any).type === 'stateChanged') {
					const tool = (msg as any).tool ?? 'unknown';
					log(`[MCP] state changed (tool: ${tool}), triggering extension refresh`);
					this._onStateChanged.fire(tool);
				}
			});

			this.process.on('exit', (code) => {
				log(`MCP server exited (code ${code})`);
				this.process = undefined;
			});

			this.process.on('error', (err) => {
				logError('MCP server error', err);
				this.process = undefined;
			});

			log(`MCP server started (pid ${this.process.pid})`);
			vscode.window.showInformationMessage('BetterPSCM: MCP server started');
		} catch (err) {
			logError('Failed to start MCP server', err);
		}
	}

	stop(): void {
		if (!this.process) return;

		log('Stopping MCP server...');
		const proc = this.process;
		this.process = undefined;

		// Send SIGTERM first for graceful shutdown, force-kill after 3s
		proc.kill('SIGTERM');
		const forceTimer = setTimeout(() => {
			try { proc.kill('SIGKILL'); } catch { /* already exited */ }
		}, 3000);
		proc.on('exit', () => clearTimeout(forceTimer));

		vscode.window.showInformationMessage('BetterPSCM: MCP server stopped');
	}

	get isRunning(): boolean {
		return !!this.process;
	}

	dispose(): void {
		this.stop();
		this._onStateChanged.dispose();
	}
}
