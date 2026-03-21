import * as vscode from 'vscode';
import { getBackend } from '../core/backend';
import { log, logError } from '../util/logger';
import type { CodeReviewInfo, ResolvedComment } from '../core/types';
import { formatShortDate } from '../util/date';

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
			lines.push(`### Line ${comment.lineNumber} — ${comment.type} by ${comment.owner}${comment.timestamp ? ` (${formatShortDate(comment.timestamp)})` : ''}`);
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


export async function exportReviewAudit(
	review: CodeReviewInfo,
	comments: ResolvedComment[],
): Promise<void> {
	const wsFolder = vscode.workspace.workspaceFolders?.[0];
	if (!wsFolder) {
		vscode.window.showErrorMessage('No workspace folder open');
		return;
	}

	// Group comments by file path and collect revision IDs for fallback
	const filePaths = [...new Set(comments.map(c => c.filePath))];
	const revisionByPath = new Map<string, number>();
	for (const c of comments) {
		if (c.revisionId && !revisionByPath.has(c.filePath)) {
			revisionByPath.set(c.filePath, c.revisionId);
		}
	}

	const fileContents = new Map<string, string[]>();

	for (const filePath of filePaths) {
		// Try reading from local disk first
		try {
			const uri = vscode.Uri.file(filePath);
			const doc = await vscode.workspace.openTextDocument(uri);
			fileContents.set(filePath, doc.getText().split('\n'));
			continue;
		} catch {
			// File doesn't exist locally — try revision fallback
		}

		// Fallback: fetch revision content via backend (cm cat)
		const revId = revisionByPath.get(filePath);
		if (revId) {
			try {
				log(`[exportAudit] file not on disk, trying revid:${revId} for ${filePath}`);
				const content = await getBackend().getFileContent(`revid:${revId}`);
				if (content) {
					const text = new TextDecoder('utf-8').decode(content);
					fileContents.set(filePath, text.split('\n'));
					continue;
				}
			} catch (err) {
				logError(`[exportAudit] revision fallback failed for revid:${revId}`, err);
			}
		}

		log(`[exportAudit] could not load content for ${filePath}`);
	}

	const markdown = generateAuditMarkdown(review, comments, fileContents);
	const fileName = `review-audit-${review.id}.md`;
	const fileUri = vscode.Uri.joinPath(wsFolder.uri, fileName);

	await vscode.workspace.fs.writeFile(fileUri, Buffer.from(markdown, 'utf-8'));

	const doc = await vscode.workspace.openTextDocument(fileUri);
	await vscode.window.showTextDocument(doc);
	vscode.window.showInformationMessage(`Audit exported to ${fileName}`);
}
