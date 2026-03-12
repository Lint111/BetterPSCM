import * as vscode from 'vscode';
import type { StatusChangeType } from '../core/types';

interface ChangeDecoration {
	letter: string;
	tooltip: string;
	color: vscode.ThemeColor;
}

const DECORATION_MAP: Record<StatusChangeType, ChangeDecoration> = {
	added: {
		letter: 'A',
		tooltip: 'Added',
		color: new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
	},
	changed: {
		letter: 'M',
		tooltip: 'Modified',
		color: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
	},
	deleted: {
		letter: 'D',
		tooltip: 'Deleted',
		color: new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
	},
	locallyDeleted: {
		letter: 'D',
		tooltip: 'Locally Deleted',
		color: new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
	},
	checkedOut: {
		letter: 'CO',
		tooltip: 'Checked Out',
		color: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
	},
	moved: {
		letter: 'MV',
		tooltip: 'Moved',
		color: new vscode.ThemeColor('gitDecoration.renamedResourceForeground'),
	},
	copied: {
		letter: 'C',
		tooltip: 'Copied',
		color: new vscode.ThemeColor('gitDecoration.addedResourceForeground'),
	},
	replaced: {
		letter: 'R',
		tooltip: 'Replaced',
		color: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
	},
	private: {
		letter: '?',
		tooltip: 'Private (unversioned)',
		color: new vscode.ThemeColor('gitDecoration.untrackedResourceForeground'),
	},
	ignored: {
		letter: 'I',
		tooltip: 'Ignored',
		color: new vscode.ThemeColor('gitDecoration.ignoredResourceForeground'),
	},
	none: {
		letter: '',
		tooltip: 'No changes',
		color: new vscode.ThemeColor('foreground'),
	},
};

/**
 * Get the decoration for a given change type.
 */
export function getChangeDecoration(changeType: StatusChangeType): vscode.SourceControlResourceDecorations {
	const dec = DECORATION_MAP[changeType] ?? DECORATION_MAP.none;
	return {
		tooltip: dec.tooltip,
		iconPath: new vscode.ThemeIcon(getThemeIconId(changeType), dec.color),
		strikeThrough: changeType === 'deleted' || changeType === 'locallyDeleted',
	};
}

function getThemeIconId(changeType: StatusChangeType): string {
	switch (changeType) {
		case 'added': return 'diff-added';
		case 'changed': return 'diff-modified';
		case 'checkedOut': return 'edit';
		case 'deleted':
		case 'locallyDeleted': return 'diff-removed';
		case 'moved': return 'diff-renamed';
		case 'copied': return 'files';
		case 'replaced': return 'diff-modified';
		case 'private': return 'question';
		case 'ignored': return 'circle-slash';
		default: return 'circle-outline';
	}
}

/**
 * Get the short letter abbreviation for a change type (used in resource state).
 */
export function getChangeLetter(changeType: StatusChangeType): string {
	return DECORATION_MAP[changeType]?.letter ?? '';
}
