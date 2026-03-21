/** Normalize path separators to forward slashes. */
export function normalizePath(p: string): string {
	return p.replace(/\\/g, '/');
}
