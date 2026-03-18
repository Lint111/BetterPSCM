import * as vscode from 'vscode';
import { logError } from '../util/logger';
import type { CodeReviewInfo, ResolvedComment } from '../core/types';

export function generateAuditMarkdown(
	review: CodeReviewInfo,
	comments: ResolvedComment[],
	fileContents: Map<string, string[]>,
	contextLines = 5,
): string {
	const lines: string[] = [];

	lines.push(`# Code Review Audit: Review #${review.id} — "${review.title}"`);
	lines.push('');
	lines.push(`**Status:** ${review.status} | **Owner:** ${review.owner} | **Target:** ${review.targetType} ${review.targetSpec ?? ''}`);
	lines.push('');
	lines.push('---');

	const groups = new Map<string, ResolvedComment[]>();
	for (const c of comments) {
		const existing = groups.get(c.filePath) ?? [];
		existing.push(c);
		groups.set(c.filePath, existing);
	}

	for (const [filePath, fileComments] of groups) {
		lines.push('');
		lines.push(`## ${filePath}`);

		const content = fileContents.get(filePath) ?? [];

		for (const comment of fileComments) {
			lines.push('');
			lines.push(`### Line ${comment.lineNumber} — ${comment.type} by ${comment.owner}${comment.timestamp ? ` (${formatDate(comment.timestamp)})` : ''}`);
			lines.push('');

			const startLine = Math.max(1, comment.lineNumber - contextLines);
			const endLine = Math.min(content.length, comment.lineNumber + contextLines);

			if (content.length > 0) {
				const ext = filePath.split('.').pop() ?? '';
				lines.push('```' + ext);
				for (let i = startLine; i <= endLine; i++) {
					const lineNum = String(i);
					const lineContent = content[i - 1] ?? '';
					if (i === comment.lineNumber) {
						lines.push(`>> ${lineNum} | ${lineContent}`);
					} else {
						lines.push(`   ${lineNum.padStart(4)} | ${lineContent}`);
					}
				}
				lines.push('```');
			}

			lines.push('');
			lines.push(`> ${comment.text.replace(/\n/g, '\n> ')}`);
			lines.push('');
			lines.push('---');
		}
	}

	return lines.join('\n');
}

function formatDate(iso: string): string {
	if (!iso) return '';
	try {
		const d = new Date(iso);
		return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
	} catch {
		return iso;
	}
}

export async function exportReviewAudit(
	review: CodeReviewInfo,
	comments: ResolvedComment[],
): Promise<void> {
	const wsFolder = vscode.workspace.workspaceFolders?.[0];
	if (!wsFolder) {
		vscode.window.showErrorMessage('No workspace folder open');
		return;
	}

	const filePaths = [...new Set(comments.map(c => c.filePath))];
	const fileContents = new Map<string, string[]>();

	for (const filePath of filePaths) {
		try {
			const uri = vscode.Uri.file(filePath);
			const doc = await vscode.workspace.openTextDocument(uri);
			fileContents.set(filePath, doc.getText().split('\n'));
		} catch {
			// File might not exist locally
		}
	}

	const markdown = generateAuditMarkdown(review, comments, fileContents);
	const fileName = `review-audit-${review.id}.md`;
	const fileUri = vscode.Uri.joinPath(wsFolder.uri, fileName);

	await vscode.workspace.fs.writeFile(fileUri, Buffer.from(markdown, 'utf-8'));

	const doc = await vscode.workspace.openTextDocument(fileUri);
	await vscode.window.showTextDocument(doc);
	vscode.window.showInformationMessage(`Audit exported to ${fileName}`);
}
