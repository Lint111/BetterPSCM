/**
 * Decoration lookup shared by the native SCM panel and the webview changeset
 * diff list. The table below is the single source of truth: both renderers
 * read from `getEntryDecorationInfo`, then wrap the data in their own
 * native container (ThemeIcon vs CSS + codicon HTML).
 *
 * If you add a new change type or change an icon/color, touch this file only.
 */
import * as vscode from 'vscode';
import type { StatusChangeType } from '../core/types';
import { isFolderEntry, type ChangedEntryLike } from './entryKind';

// ── Color IDs ───────────────────────────────────────────────────────
// Kept as plain strings so they can be serialized to the webview
// (which can't construct `vscode.ThemeColor`).
const COLOR_ADDED     = 'gitDecoration.addedResourceForeground';
const COLOR_MODIFIED  = 'gitDecoration.modifiedResourceForeground';
const COLOR_DELETED   = 'gitDecoration.deletedResourceForeground';
const COLOR_RENAMED   = 'gitDecoration.renamedResourceForeground';
const COLOR_UNTRACKED = 'gitDecoration.untrackedResourceForeground';
const COLOR_IGNORED   = 'gitDecoration.ignoredResourceForeground';
const COLOR_DEFAULT   = 'foreground';

// ── Plain-data decoration info ──────────────────────────────────────

/**
 * Presentation data for a changed entry. Everything needed to render in
 * either VS Code's native SCM or plain HTML. No VS Code types — plain
 * strings, serializable, safe to post into a webview.
 */
export interface EntryDecorationInfo {
	/** Codicon id for a file entry (e.g. 'diff-modified', 'diff-added'). */
	iconId: string;
	/** VS Code theme color id (e.g. 'gitDecoration.modifiedResourceForeground'). */
	colorId: string;
	/** Short letter shown next to the path ('A', 'M', 'D', …). */
	letter: string;
	/** Human-readable tooltip. */
	tooltip: string;
	/** Whether the row should be rendered with strikethrough. */
	strikeThrough: boolean;
}

interface ChangeTypeEntry {
	iconId: string;
	colorId: string;
	letter: string;
	tooltip: string;
}

/**
 * Single source of truth for change-type presentation. Add new change types
 * here; both the SCM panel and the history webview will pick them up.
 */
const INFO_MAP: Record<StatusChangeType, ChangeTypeEntry> = {
	added:          { iconId: 'diff-added',    colorId: COLOR_ADDED,     letter: 'A',  tooltip: 'Added' },
	changed:        { iconId: 'diff-modified', colorId: COLOR_MODIFIED,  letter: 'M',  tooltip: 'Modified' },
	deleted:        { iconId: 'diff-removed',  colorId: COLOR_DELETED,   letter: 'D',  tooltip: 'Deleted' },
	locallyDeleted: { iconId: 'diff-removed',  colorId: COLOR_DELETED,   letter: 'D',  tooltip: 'Locally Deleted' },
	checkedOut:     { iconId: 'edit',          colorId: COLOR_MODIFIED,  letter: 'CO', tooltip: 'Checked Out' },
	moved:          { iconId: 'diff-renamed',  colorId: COLOR_RENAMED,   letter: 'MV', tooltip: 'Moved' },
	copied:         { iconId: 'files',         colorId: COLOR_ADDED,     letter: 'C',  tooltip: 'Copied' },
	replaced:       { iconId: 'diff-modified', colorId: COLOR_MODIFIED,  letter: 'R',  tooltip: 'Replaced' },
	private:        { iconId: 'question',      colorId: COLOR_UNTRACKED, letter: '?',  tooltip: 'Private (unversioned)' },
	ignored:        { iconId: 'circle-slash',  colorId: COLOR_IGNORED,   letter: 'I',  tooltip: 'Ignored' },
	none:           { iconId: 'circle-outline', colorId: COLOR_DEFAULT,  letter: '',   tooltip: 'No changes' },
};

/**
 * Unified decoration lookup. Returns all the presentation data needed to
 * render a changed entry, regardless of its source (live or historic) or
 * kind (file or directory).
 *
 * Folders use the 'folder' codicon with the change-type color — a deleted
 * folder is red, a modified folder is orange, etc. — matching the live SCM
 * panel's folder presentation.
 */
export function getEntryDecorationInfo(
	changeType: StatusChangeType,
	entry?: ChangedEntryLike,
): EntryDecorationInfo {
	const base = INFO_MAP[changeType] ?? INFO_MAP.none;
	const isFolder = entry !== undefined && isFolderEntry(entry);
	return {
		iconId: isFolder ? 'folder' : base.iconId,
		colorId: base.colorId,
		letter: base.letter,
		tooltip: isFolder ? `${base.tooltip} (folder)` : base.tooltip,
		strikeThrough: changeType === 'deleted' || changeType === 'locallyDeleted',
	};
}

// ── Native SCM panel wrappers ───────────────────────────────────────

/**
 * Produce a VS Code `SourceControlResourceDecorations` for a file entry.
 */
export function getChangeDecoration(changeType: StatusChangeType): vscode.SourceControlResourceDecorations {
	return toResourceDecorations(getEntryDecorationInfo(changeType));
}

/**
 * Produce a VS Code `SourceControlResourceDecorations` for a directory entry.
 * Uses the folder icon colored by the change type.
 */
export function getFolderDecoration(changeType: StatusChangeType): vscode.SourceControlResourceDecorations {
	return toResourceDecorations(getEntryDecorationInfo(changeType, { dataType: 'Directory' }));
}

function toResourceDecorations(info: EntryDecorationInfo): vscode.SourceControlResourceDecorations {
	return {
		tooltip: info.tooltip,
		iconPath: new vscode.ThemeIcon(info.iconId, new vscode.ThemeColor(info.colorId)),
		strikeThrough: info.strikeThrough,
	};
}

/**
 * Get the short letter abbreviation for a change type (used in resource state).
 */
export function getChangeLetter(changeType: StatusChangeType): string {
	return INFO_MAP[changeType]?.letter ?? '';
}
