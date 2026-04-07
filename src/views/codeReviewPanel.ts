import * as vscode from 'vscode';
import { coreStyles, errorStyles } from './webviewStyles';
import { codeReviewStyles } from './panels/codeReview/styles';
import { codeReviewClientJs } from './panels/codeReview/client';
import { BetterPanel } from './panels/betterPanel';
import {
	getCodeReview, getReviewComments, addReviewComment,
	updateCodeReviewStatus, updateReviewerStatus, addReviewers, removeReviewer,
} from '../core/workspace';
import { log, logError } from '../util/logger';
import { escapeHtml } from '../util/html';
import type { CodeReviewInfo, ReviewCommentInfo, ReviewStatus } from '../core/types';
import { formatDateTime } from '../util/date';

export class CodeReviewPanel extends BetterPanel {
	static readonly viewType = 'bpscm.codeReviewPanel';
	private static panels = new Map<number, CodeReviewPanel>();

	private reviewId: number;

	static open(reviewId: number, extensionUri: vscode.Uri): void {
		const existing = CodeReviewPanel.panels.get(reviewId);
		if (existing) {
			existing.reveal();
			existing.loadReview();
			return;
		}
		new CodeReviewPanel(reviewId, extensionUri);
	}

	private constructor(reviewId: number, _extensionUri: vscode.Uri) {
		super({
			viewType: CodeReviewPanel.viewType,
			title: `Review #${reviewId}`,
			viewColumn: vscode.ViewColumn.One,
		});
		this.reviewId = reviewId;
		CodeReviewPanel.panels.set(reviewId, this);
		this.loadReview();
	}

	protected override onPanelDispose(): void {
		CodeReviewPanel.panels.delete(this.reviewId);
	}

	private async loadReview(): Promise<void> {
		try {
			const [review, comments] = await Promise.all([
				getCodeReview(this.reviewId),
				getReviewComments(this.reviewId),
			]);

			this.panel.title = review.title || `Review #${review.id}`;
			this.panel.webview.html = this.buildHtml(review, comments);
		} catch (err) {
			logError(`Failed to load review ${this.reviewId}`, err);
			this.panel.webview.html = this.buildErrorHtml(err);
		}
	}

	protected override async handleMessage(msg: any): Promise<void> {
		try {
			switch (msg.type) {
				case 'addComment': {
					await addReviewComment({
						reviewId: this.reviewId,
						text: msg.text,
						parentCommentId: msg.parentId,
					});
					await this.loadReview();
					break;
				}
				case 'changeStatus': {
					await updateCodeReviewStatus(this.reviewId, msg.status);
					await this.loadReview();
					break;
				}
				case 'changeReviewerStatus': {
					await updateReviewerStatus(this.reviewId, msg.reviewer, msg.status);
					await this.loadReview();
					break;
				}
				case 'addReviewer': {
					await addReviewers(this.reviewId, [msg.reviewer]);
					await this.loadReview();
					break;
				}
				case 'removeReviewer': {
					await removeReviewer(this.reviewId, msg.reviewer);
					await this.loadReview();
					break;
				}
			}
		} catch (err) {
			logError(`Review action failed: ${msg.type}`, err);
			vscode.window.showErrorMessage(
				`Review action failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	private buildHtml(review: CodeReviewInfo, comments: ReviewCommentInfo[]): string {
		const statusColor: Record<ReviewStatus, string> = {
			'Under review': 'var(--color-changed)',
			'Reviewed': 'var(--color-added)',
			'Rework required': 'var(--color-deleted)',
		};

		const reviewersHtml = review.reviewers.length > 0
			? review.reviewers.map(r => `
				<div class="reviewer-row">
					<span class="reviewer-name">${escapeHtml(r.name)}</span>
					<span class="reviewer-status" style="color:${statusColor[r.status]}">${escapeHtml(r.status)}</span>
					<select class="reviewer-status-select" data-reviewer="${escapeHtml(r.name)}">
						<option value="Under review" ${r.status === 'Under review' ? 'selected' : ''}>Under review</option>
						<option value="Reviewed" ${r.status === 'Reviewed' ? 'selected' : ''}>Reviewed</option>
						<option value="Rework required" ${r.status === 'Rework required' ? 'selected' : ''}>Rework required</option>
					</select>
					<button class="remove-reviewer-btn" data-reviewer="${escapeHtml(r.name)}" title="Remove reviewer">x</button>
				</div>
			`).join('')
			: '<div class="text-muted">No reviewers assigned</div>';

		const commentsHtml = comments.length > 0
			? comments.map(c => `
				<div class="comment ${c.type === 'Question' ? 'question' : ''}">
					<div class="comment-header">
						<span class="comment-author">${escapeHtml(c.owner)}</span>
						<span class="comment-type text-muted">${escapeHtml(c.type)}</span>
						<span class="comment-time text-muted">${formatDateTime(c.timestamp)}</span>
					</div>
					${c.itemName ? `<div class="comment-location text-muted text-mono">${escapeHtml(c.itemName)}${c.locationSpec ? ' @ ' + escapeHtml(c.locationSpec) : ''}</div>` : ''}
					<div class="comment-body">${escapeHtml(c.text)}</div>
					<button class="reply-btn" data-comment-id="${c.id}">Reply</button>
				</div>
			`).join('')
			: '<div class="text-muted" style="padding:8px">No comments yet</div>';

		return `<!DOCTYPE html>
<html>
<head>
<style>
${coreStyles}
${codeReviewStyles}
</style>
</head>
<body style="overflow-y:auto;">
	<div class="review-header">
		<div class="review-title">${escapeHtml(review.title)}</div>
		<div class="review-meta">
			<span>
				<span class="review-status" style="background:${statusColor[review.status]}33; color:${statusColor[review.status]}">
					${escapeHtml(review.status)}
				</span>
			</span>
			<span>Owner: ${escapeHtml(review.owner)}</span>
			<span>Target: ${escapeHtml(review.targetType)} ${escapeHtml(review.targetSpec ?? '')}</span>
			<span>${review.commentsCount} comment(s)</span>
			<span>Created: ${formatDateTime(review.created)}</span>
		</div>
		${review.description ? `<div style="margin-top:8px;white-space:pre-wrap">${escapeHtml(review.description)}</div>` : ''}
	</div>

	<div class="toolbar">
		<span style="font-size:var(--font-label);font-weight:bold">Status:</span>
		<select id="statusSelect">
			<option value="Under review" ${review.status === 'Under review' ? 'selected' : ''}>Under review</option>
			<option value="Reviewed" ${review.status === 'Reviewed' ? 'selected' : ''}>Reviewed</option>
			<option value="Rework required" ${review.status === 'Rework required' ? 'selected' : ''}>Rework required</option>
		</select>
		<button id="statusBtn" class="btn">Update Status</button>
	</div>

	<div class="section">
		<div class="section-title">Reviewers</div>
		${reviewersHtml}
		<div class="add-reviewer-row">
			<input type="text" id="newReviewerInput" placeholder="Reviewer name..." style="background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border, transparent);padding:2px 6px;border-radius:2px;font-size:var(--font-label);">
			<button id="addReviewerBtn" class="btn" style="font-size:var(--font-label)">Add</button>
		</div>
	</div>

	<div class="section">
		<div class="section-title">Comments</div>
	</div>
	<div class="scroll" id="commentsList">
		${commentsHtml}
	</div>

	<div class="new-comment">
		<textarea id="commentInput" placeholder="Write a comment..."></textarea>
		<div class="actions">
			<button id="submitCommentBtn" class="btn">Add Comment</button>
		</div>
	</div>

	<script>
		const vscode = acquireVsCodeApi();
		${codeReviewClientJs}
	</script>
</body>
</html>`;
	}

	private buildErrorHtml(err: unknown): string {
		const msg = err instanceof Error ? err.message : String(err);
		return `<!DOCTYPE html><html><head><style>${errorStyles}</style></head><body>
			<div class="err"><h3>Failed to load review</h3><pre>${escapeHtml(msg)}</pre>
			<button onclick="location.reload()">Retry</button></div>
		</body></html>`;
	}

	// dispose() inherited from BetterPanel
}

