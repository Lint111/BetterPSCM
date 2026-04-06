/**
 * Shared classification and presentation rules for "changed entries" — the
 * conceptual union of live pending changes (NormalizedChange) and historic
 * changeset diffs (ChangesetDiffItem).
 *
 * Both data sources describe the same domain: "a path that changed". They
 * currently use different field names for historical reasons (NormalizedChange
 * predates changeset browsing), but the user-facing rules must match:
 *
 *   - Directories show a folder icon, not a file-diff icon.
 *   - Directories have no meaningful diff view; click handlers are skipped.
 *   - Change-type letter (A/M/D/…) and color come from one lookup table.
 *
 * Anything that differentiates folder vs file presentation MUST go through
 * this module so the two views never drift.
 */
import type { NormalizedChange, ChangesetDiffItem } from '../core/types';

export type EntryKind = 'file' | 'directory';

/** Structural test — accepts either source type. */
export type ChangedEntryLike =
	| Pick<NormalizedChange, 'dataType'>
	| Pick<ChangesetDiffItem, 'isDirectory'>;

/**
 * Classify any changed entry. Returns 'directory' for folder entries from
 * either source, 'file' otherwise (including unknown).
 */
export function getEntryKind(entry: ChangedEntryLike): EntryKind {
	if ('dataType' in entry && entry.dataType === 'Directory') return 'directory';
	if ('isDirectory' in entry && entry.isDirectory === true) return 'directory';
	return 'file';
}

export function isFolderEntry(entry: ChangedEntryLike): boolean {
	return getEntryKind(entry) === 'directory';
}

/**
 * Whether a click on this entry should open a diff view. Folders have no
 * diff to show — the unified rule is: never open diffs for directories.
 */
export function shouldOpenDiff(entry: ChangedEntryLike): boolean {
	return !isFolderEntry(entry);
}
