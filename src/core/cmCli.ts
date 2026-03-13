import { execFile, spawn } from 'child_process';
import { createWriteStream } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { log, logError } from '../util/logger';

const CM_PATH_WIN = 'C:\\Program Files\\PlasticSCM5\\client\\cm.exe';
const CM_PATH_UNIX = 'cm';

let cmPath: string | undefined;
let workspaceRoot: string | undefined;

/**
 * Set the workspace root for cm commands.
 */
export function setCmWorkspaceRoot(root: string): void {
	workspaceRoot = root;
}

/**
 * Detect the cm CLI binary. Returns the path or undefined if not found.
 */
export async function detectCm(): Promise<string | undefined> {
	if (cmPath) return cmPath;

	// Try platform-specific path first
	const candidates = process.platform === 'win32'
		? [CM_PATH_WIN, 'cm']
		: ['cm', CM_PATH_WIN];

	for (const candidate of candidates) {
		try {
			const result = await execCmRaw(candidate, ['version']);
			if (result.exitCode === 0) {
				cmPath = candidate;
				log(`Found cm CLI at "${candidate}": ${result.stdout.trim()}`);
				return cmPath;
			}
		} catch {
			// Try next candidate
		}
	}

	log('cm CLI not found');
	return undefined;
}

/**
 * Check if cm CLI is available.
 */
export function isCmAvailable(): boolean {
	return !!cmPath;
}

/**
 * Get the workspace root path (for stripping absolute paths from cm output).
 */
export function getCmWorkspaceRoot(): string | undefined {
	return workspaceRoot;
}

/**
 * Execute a cm CLI command and return parsed output.
 * Use maxBuffer for commands that may return large output (e.g. cm cat on big files).
 */
export async function execCm(args: string[], maxBuffer?: number): Promise<CmResult> {
	if (!cmPath) {
		throw new Error('cm CLI not available');
	}
	return execCmRaw(cmPath, args, maxBuffer);
}

interface CmResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/**
 * Stream cm cat output to a temp file — no memory buffer limit.
 * Use for large files (.unity, .prefab, .asset, .scene, etc.)
 * Returns the temp file path on success, undefined on failure.
 */
export async function execCmToFile(args: string[]): Promise<string | undefined> {
	if (!cmPath) {
		throw new Error('cm CLI not available');
	}
	const tempPath = join(tmpdir(), `plastic-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
	return new Promise((resolve) => {
		const proc = spawn(cmPath!, args, {
			cwd: workspaceRoot,
			windowsHide: true,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		const out = createWriteStream(tempPath);
		proc.stdout.pipe(out);
		let stderr = '';
		proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
		proc.on('close', (code) => {
			out.end();
			if (code === 0) {
				resolve(tempPath);
			} else {
				log(`[execCmToFile] failed (exit ${code}): ${stderr}`);
				resolve(undefined);
			}
		});
		proc.on('error', (err) => {
			out.end();
			log(`[execCmToFile] spawn error: ${err.message}`);
			resolve(undefined);
		});
	});
}

function execCmRaw(binary: string, args: string[], maxBuffer?: number): Promise<CmResult> {
	return new Promise((resolve, reject) => {
		const opts: { cwd?: string; windowsHide?: boolean; maxBuffer?: number } = { windowsHide: true };
		if (workspaceRoot) {
			opts.cwd = workspaceRoot;
		}
		if (maxBuffer) {
			opts.maxBuffer = maxBuffer;
		}
		execFile(binary, args, opts, (err, stdout, stderr) => {
			if (err && !('code' in err)) {
				reject(err);
				return;
			}
			resolve({
				stdout: stdout ?? '',
				stderr: stderr ?? '',
				exitCode: (err as any)?.code ?? 0,
			});
		});
	});
}
