import { execFile, spawn } from 'child_process';
import { createWriteStream } from 'fs';
import { unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { log, logError } from '../util/logger';

const CM_PATH_WIN = 'C:\\Program Files\\PlasticSCM5\\client\\cm.exe';
const CM_PATH_UNIX = 'cm';

/** Environment variable that overrides cm binary detection. Used by integration
 *  tests running from WSL where neither `cm` is on PATH nor the Windows-only
 *  CM_PATH_WIN resolves from the Linux filesystem. */
const CM_PATH_ENV = 'PLASTIC_CM_PATH';

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
 * Resolution order:
 *   1. PLASTIC_CM_PATH env var (explicit override)
 *   2. Platform default (CM_PATH_WIN on Windows, `cm` on other platforms)
 *   3. The other fallback
 */
export async function detectCm(): Promise<string | undefined> {
	if (cmPath) return cmPath;

	const envOverride = process.env[CM_PATH_ENV];
	const candidates: string[] = [];
	if (envOverride) candidates.push(envOverride);
	if (process.platform === 'win32') {
		candidates.push(CM_PATH_WIN, CM_PATH_UNIX);
	} else {
		candidates.push(CM_PATH_UNIX, CM_PATH_WIN);
	}

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
 * Reset the cached cm binary path. Used by integration tests that need
 * to force re-detection after changing PLASTIC_CM_PATH, and by tests
 * that need to start from a clean module state.
 */
export function resetCmPath(): void {
	cmPath = undefined;
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
	return execCmRaw(cmPath, args.map(toCmArg), maxBuffer);
}

/**
 * Translate a single cm CLI argument.
 *
 * When cm.exe runs on Windows but the MCP client (e.g. Claude Code under WSL)
 * passes WSL-style paths like "/mnt/c/Foo/bar.cs", cm rejects them because the
 * Windows binary cannot resolve `/mnt/c` to a workspace. Rewrite those to
 * Windows form ("C:\Foo\bar.cs") before handing off to cm. Non-path args and
 * flags are returned untouched.
 */
export function toCmArg(arg: string): string {
	if (process.platform !== 'win32') return arg;
	// Match "/mnt/<letter>" or "/mnt/<letter>/..."
	const m = /^\/mnt\/([a-zA-Z])(\/.*)?$/.exec(arg);
	if (!m) return arg;
	const drive = m[1].toUpperCase();
	const rest = (m[2] ?? '').replace(/\//g, '\\');
	return `${drive}:${rest}`;
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
		const proc = spawn(cmPath!, args.map(toCmArg), {
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
			if (err && ((err as any).killed || (err as any).signal === 'SIGTERM')) {
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
