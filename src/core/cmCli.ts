import { execFile } from 'child_process';
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
 */
export async function execCm(args: string[]): Promise<CmResult> {
	if (!cmPath) {
		throw new Error('cm CLI not available');
	}
	return execCmRaw(cmPath, args);
}

interface CmResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

function execCmRaw(binary: string, args: string[]): Promise<CmResult> {
	return new Promise((resolve, reject) => {
		const opts: { cwd?: string; windowsHide?: boolean } = { windowsHide: true };
		if (workspaceRoot) {
			opts.cwd = workspaceRoot;
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
