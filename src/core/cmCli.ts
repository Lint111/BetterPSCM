import { execFile, spawn } from 'child_process';
import { createWriteStream } from 'fs';
import { unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { log, logError } from '../util/logger';

const CM_PATH_WIN = 'C:\\Program Files\\PlasticSCM5\\client\\cm.exe';
const CM_PATH_UNIX = 'cm';

let cmPath: string | undefined;
let workspaceRoot: string | undefined;

const _activeChildren = new Set<import('child_process').ChildProcess>();

/** Kill all active cm child processes. Used during branch switch cancellation. */
export function killActiveChildren(): void {
	for (const child of _activeChildren) {
		try { child.kill('SIGTERM'); } catch { /* already exited */ }
	}
	_activeChildren.clear();
}

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
			env: { ...process.env, ...CM_HEADLESS_ENV },
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
				unlink(tempPath).catch(() => {});
				resolve(undefined);
			}
		});
		proc.on('error', (err) => {
			out.end();
			log(`[execCmToFile] spawn error: ${err.message}`);
			unlink(tempPath).catch(() => {});
			resolve(undefined);
		});
	});
}

/**
 * Environment variables that force cm CLI into headless mode.
 * Without these, commands like `cm diff`, `cm undocheckout`, etc. can
 * launch Plastic SCM's GUI revision viewer / merge tool, which blocks
 * the process indefinitely until the window is manually closed.
 */
const CM_HEADLESS_ENV: Record<string, string> = {
	// Suppress the external merge/diff tool launcher
	PLASTICSCM_MERGETOOL: 'none',
	PLASTICSCM_DIFFTOOL: 'none',
	// Disable GUI prompts in general
	PLASTIC_NO_GUI: '1',
};

function execCmRaw(binary: string, args: string[], maxBuffer?: number): Promise<CmResult> {
	return new Promise((resolve, reject) => {
		const opts: {
			cwd?: string;
			windowsHide?: boolean;
			maxBuffer?: number;
			env?: NodeJS.ProcessEnv;
		} = {
			windowsHide: true,
			// Merge headless env vars with the current process environment
			env: { ...process.env, ...CM_HEADLESS_ENV },
		};
		if (workspaceRoot) {
			opts.cwd = workspaceRoot;
		}
		if (maxBuffer) {
			opts.maxBuffer = maxBuffer;
		}
		const child = execFile(binary, args, opts, (err, stdout, stderr) => {
			_activeChildren.delete(child);
			if (err && (err as any).killed || (err as any).signal === 'SIGTERM') {
				resolve({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode: 1 });
				return;
			}
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
		_activeChildren.add(child);
	});
}
