import type { StatusChangeType } from './types';

/** Maximum files that can be reverted/undone in a single operation without explicit confirmation. */
export const BULK_OPERATION_THRESHOLD = 20;

/** File extensions that are critical for Unity reference integrity. */
export const UNITY_CRITICAL_EXTENSIONS = ['.meta', '.unity', '.prefab', '.asset', '.asmdef', '.asmref'];

/** Change types that represent real file modifications safe to commit.
 *  Files with any other status (checkedOut, private, ignored, etc.) are auto-excluded. */
export const COMMITTABLE_CHANGE_TYPES = new Set<string>([
	'added', 'changed', 'deleted', 'moved', 'replaced', 'copied', 'locallyDeleted',
]);

/** Change types that have a base revision and support inline diffing. */
export const DIFF_CHANGE_TYPES = new Set<string>([
	'changed', 'checkedOut', 'replaced', 'moved', 'copied',
]);

/**
 * Check if a change type represents a real modification safe to commit.
 */
export function isCommittableChange(changeType: string | undefined): boolean {
	return !!changeType && COMMITTABLE_CHANGE_TYPES.has(changeType);
}

/**
 * Expand a list of paths to include .meta companion files (and vice versa).
 * Only adds companions that exist in the candidates set.
 */
export function expandMetaCompanions(paths: string[], candidates: Set<string>): string[] {
	const result = new Set(paths);
	for (const p of paths) {
		if (p.endsWith('.meta')) {
			const base = p.slice(0, -5);
			if (candidates.has(base)) result.add(base);
		} else {
			const meta = p + '.meta';
			if (candidates.has(meta)) result.add(meta);
		}
	}
	return [...result];
}
