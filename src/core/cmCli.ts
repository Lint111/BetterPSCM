import { execFile, spawn } from 'child_process';
import { createWriteStream } from 'fs';
import { unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { log, logError } from '../util/logger';
import type { PlasticContext } from './context';

const CM_PATH_WIN = 'C:\\Program Files\\PlasticSCM5\\client\\cm.exe';
const CM_PATH_UNIX = 'cm';

/** Environment variable that overrides cm binary detection. Used by integration
 *  tests running from WSL where neither `cm` is on PATH nor the Windows-only
 *  CM_PATH_WIN resolves from the Linux filesystem. */
const CM_PATH_ENV = 'PLASTIC_CM_PATH';

// Module-level globals — legacy state for call sites that have not yet been
// migrated to PlasticContext. New code should prefer passing a context
// explicitly via execCmWithContext / execCmToFileWithContext. See context.ts.
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
 * Probe for a working cm binary. Pure: returns the discovered path without
 * touching module-level state. Used by context construction and by the
 * module-level `detectCm()` which caches the result.
 * Resolution order:
 *   1. PLASTIC_CM_PATH env var (explicit override)
 *   2. Platform default (CM_PATH_WIN on Windows, `cm` on other platforms)
 *   3. The other fallback
 */
export async function probeCmBinary(): Promise<string | undefined> {
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
				log(`Found cm CLI at "${candidate}": ${result.stdout.trim()}`);
				return candidate;
			}
		} catch {
			// Try next candidate
		}
	}

	log('cm CLI not found');
	return undefined;
}

/**
 * Detect the cm CLI binary and cache the result in module state.
 * Legacy entry point for call sites that rely on module-level cmPath.
 * New code should prefer `probeCmBinary()` + explicit PlasticContext.
 */
export async function detectCm(): Promise<string | undefined> {
	if (cmPath) return cmPath;
	cmPath = await probeCmBinary();
	return cmPath;
}

/**
 * Reset all module-level cm state: cached binary path AND workspace root.
 * Used by tests that need to start from a clean slate and by integration
 * tests that force re-detection after changing PLASTIC_CM_PATH.
 *
 * Does not kill active child processes — use `killActiveChildren()` for that.
 */
export function resetCmState(): void {
	cmPath = undefined;
	workspaceRoot = undefined;
}

/**
 * Deprecated alias for `resetCmState`. Kept for backwards compatibility with
 * existing call sites; new code should use `resetCmState` which communicates
 * the full scope of the reset.
 * @deprecated Use resetCmState instead.
 */
export function resetCmPath(): void {
	resetCmState();
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
 *
 * Reads cm binary path and cwd from module-level globals (`cmPath`,
 * `workspaceRoot`). For call sites that have migrated to PlasticContext,
 * prefer `execCmWithContext` which bypasses module state entirely.
 */
export async function execCm(args: string[], maxBuffer?: number): Promise<CmResult> {
	if (!cmPath) {
		throw new Error('cm CLI not available');
	}
	return execCmRaw(cmPath, args.map(toCmArg), maxBuffer);
}

/**
 * Context-aware variant of `execCm`. Uses the binary and workspace root from
 * the supplied PlasticContext, never touching module-level state. Safe to
 * call with different contexts concurrently — each call operates on its own
 * workspace.
 */
export async function execCmWithContext(
	ctx: PlasticContext,
	args: string[],
	maxBuffer?: number,
): Promise<CmResult> {
	return execCmRaw(ctx.cmPath, args.map(toCmArg), maxBuffer, ctx.workspaceRoot);
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

export interface CmResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/**
 * Stream cm cat output to a temp file — no memory buffer limit.
 * Use for large files (.unity, .prefab, .asset, .scene, etc.)
 * Returns the temp file path on success, undefined on failure.
 *
 * Reads cm binary path and cwd from module-level globals. For call sites
 * that have migrated to PlasticContext, prefer `execCmToFileWithContext`.
 */
export async function execCmToFile(args: string[]): Promise<string | undefined> {
	if (!cmPath) {
		throw new Error('cm CLI not available');
	}
	return execCmToFileRaw(cmPath, args, workspaceRoot);
}

/**
 * Context-aware variant of `execCmToFile`. Uses the binary and workspace root
 * from the supplied PlasticContext, never touching module-level state.
 */
export async function execCmToFileWithContext(
	ctx: PlasticContext,
	args: string[],
): Promise<string | undefined> {
	return execCmToFileRaw(ctx.cmPath, args, ctx.workspaceRoot);
}

/**
 * Shared implementation of execCmToFile that accepts explicit binary and cwd
 * arguments. Both the module-level `execCmToFile` and the context-aware
 * variant delegate here.
 */
function execCmToFileRaw(
	binary: string,
	args: string[],
	cwd: string | undefined,
): Promise<string | undefined> {
	const tempPath = join(tmpdir(), `plastic-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
	return new Promise((resolve) => {
		const proc = spawn(binary, args.map(toCmArg), {
			cwd,
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

function execCmRaw(
	binary: string,
	args: string[],
	maxBuffer?: number,
	cwdOverride?: string,
): Promise<CmResult> {
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
		// Explicit override (from PlasticContext) takes precedence over the
		// module-level workspaceRoot so scoped calls don't leak each other's cwd.
		const effectiveCwd = cwdOverride ?? workspaceRoot;
		if (effectiveCwd) {
			opts.cwd = effectiveCwd;
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
