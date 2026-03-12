import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel | undefined;

export function getLogger(): vscode.OutputChannel {
	if (!outputChannel) {
		outputChannel = vscode.window.createOutputChannel('Plastic SCM');
	}
	return outputChannel;
}

export function log(message: string): void {
	getLogger().appendLine(`[${new Date().toISOString()}] ${message}`);
}

export function logError(message: string, error?: unknown): void {
	const errMsg = error instanceof Error ? error.message : String(error ?? '');
	log(`ERROR: ${message}${errMsg ? ` — ${errMsg}` : ''}`);
}
