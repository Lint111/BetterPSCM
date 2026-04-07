/** Normalize path separators to forward slashes. */
export function normalizePath(p: string): string {
	return p.replace(/\\/g, '/');
}

/**
 * Translate WSL-style `/mnt/<drive>/...` paths into their Windows equivalent
 * (`<drive>:/...`). Leaves non-WSL paths untouched.
 *
 * Needed because `cm.exe` always emits Windows-form absolute paths regardless
 * of the caller, while the workspace root may be stored in WSL form (e.g. when
 * the extension or integration tests run from a Linux Node process). Matching
 * these two forms requires normalizing to a common representation.
 */
export function wslToWindowsPath(p: string): string {
	const m = /^\/mnt\/([a-zA-Z])(\/.*)?$/.exec(p);
	if (!m) return p;
	const drive = m[1].toLowerCase();
	const rest = m[2] ?? '';
	return `${drive}:${rest}`;
}
