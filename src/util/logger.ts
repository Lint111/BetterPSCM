interface LogChannel {
	appendLine(msg: string): void;
	show?(): void;
}

let outputChannel: LogChannel | undefined;

/**
 * Try to use the vscode OutputChannel if available, otherwise fall back to stderr.
 * This allows the logger to work in both the VS Code extension and the standalone MCP server.
 */
function ensureChannel(): LogChannel {
	if (outputChannel) return outputChannel;
	try {
		// Dynamic require so esbuild can mark vscode as external without breaking
		// the MCP server bundle where vscode is not available.
		const vscode = require('vscode') as typeof import('vscode');
		outputChannel = vscode.window.createOutputChannel('Plastic SCM');
	} catch {
		// vscode not available (e.g. standalone MCP server process)
		outputChannel = {
			appendLine(msg: string) {
				process.stderr.write(msg + '\n');
			},
		};
	}
	return outputChannel;
}

export function getLogger(): LogChannel {
	return ensureChannel();
}

export function log(message: string): void {
	ensureChannel().appendLine(`[${new Date().toISOString()}] ${message}`);
}

export function logError(message: string, error?: unknown): void {
	const errMsg = error instanceof Error ? error.message : String(error ?? '');
	log(`ERROR: ${message}${errMsg ? ` — ${errMsg}` : ''}`);
}
