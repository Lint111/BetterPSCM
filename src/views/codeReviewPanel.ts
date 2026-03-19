import * as vscode from 'vscode';
import { coreStyles, errorStyles } from './webviewStyles';
import {
	getCodeReview, getReviewComments, addReviewComment,
	updateCodeReviewStatus, updateReviewerStatus, addReviewers, removeReviewer,
} from '../core/workspace';
import { log, logError } from '../util/logger';
import type { CodeReviewInfo, ReviewCommentInfo, ReviewStatus } from '../core/types';

export class CodeReviewPanel implements vscode.Disposable {
	static readonly viewType = 'bpscm.codeReviewPanel';
	private static panels = new Map<number, CodeReviewPanel>();

	private readonly panel: vscode.WebviewPanel;
	private reviewId: number;
	private disposables: vscode.Disposable[] = [];

	static open(reviewId: number, extensionUri: vscode.Uri): void {
		const existing = CodeReviewPanel.panels.get(reviewId);
		if (existing) {
			existing.panel.reveal();
			existing.loadReview();
			return;
		}
		new CodeReviewPanel(reviewId, extensionUri);
	}

	private constructor(reviewId: number, extensionUri: vscode.Uri) {
		this.reviewId = reviewId;
		this.panel = vscode.window.createWebviewPanel(
			CodeReviewPanel.viewType,
			`Review #${reviewId}`,
			vscode.ViewColumn.One,
			{ enableScripts: true, retainContextWhenHidden: true },
		);

		CodeReviewPanel.panels.set(reviewId, this);

		this.panel.onDidDispose(() => {
			CodeReviewPanel.panels.delete(reviewId);
			this.dispose();
		}, null, this.disposables);

		this.panel.webview.onDidReceiveMessage(
			msg => this.handleMessage(msg),
			null,
			this.disposables,
		);

		this.loadReview();
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

	private async handleMessage(msg: any): Promise<void> {
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
					<span class="reviewer-name">${esc(r.name)}</span>
					<span class="reviewer-status" style="color:${statusColor[r.status]}">${esc(r.status)}</span>
					<select class="reviewer-status-select" data-reviewer="${esc(r.name)}">
						<option value="Under review" ${r.status === 'Under review' ? 'selected' : ''}>Under review</option>
						<option value="Reviewed" ${r.status === 'Reviewed' ? 'selected' : ''}>Reviewed</option>
						<option value="Rework required" ${r.status === 'Rework required' ? 'selected' : ''}>Rework required</option>
					</select>
					<button class="remove-reviewer-btn" data-reviewer="${esc(r.name)}" title="Remove reviewer">x</button>
				</div>
			`).join('')
			: '<div class="text-muted">No reviewers assigned</div>';

		const commentsHtml = comments.length > 0
			? comments.map(c => `
				<div class="comment ${c.type === 'Question' ? 'question' : ''}">
					<div class="comment-header">
						<span class="comment-author">${esc(c.owner)}</span>
						<span class="comment-type text-muted">${esc(c.type)}</span>
						<span class="comment-time text-muted">${formatDate(c.timestamp)}</span>
					</div>
					${c.itemName ? `<div class="comment-location text-muted text-mono">${esc(c.itemName)}${c.locationSpec ? ' @ ' + esc(c.locationSpec) : ''}</div>` : ''}
					<div class="comment-body">${esc(c.text)}</div>
					<button class="reply-btn" data-comment-id="${c.id}">Reply</button>
				</div>
			`).join('')
			: '<div class="text-muted" style="padding:8px">No comments yet</div>';

		return `<!DOCTYPE html>
<html>
<head>
<style>
${coreStyles}
.review-header { padding: 12px 16px; border-bottom: 1px solid var(--vscode-panel-border); }
.review-title { font-size: 16px; font-weight: bold; margin-bottom: 4px; }
.review-meta { display: flex; gap: 16px; flex-wrap: wrap; font-size: var(--font-label); color: var(--vscode-descriptionForeground); }
.review-status { font-weight: bold; padding: 2px 8px; border-radius: 10px; font-size: var(--font-caption); }
.section { padding: 8px 16px; }
.section-title { font-weight: bold; font-size: var(--font-label); margin-bottom: 6px; color: var(--vscode-descriptionForeground); }
.reviewer-row { display: flex; align-items: center; gap: 8px; padding: 3px 0; }
.reviewer-name { flex: 1; }
.reviewer-status { font-size: var(--font-caption); }
.reviewer-status-select { font-size: var(--font-caption); }
.remove-reviewer-btn { background: none; border: none; color: var(--vscode-errorForeground); cursor: pointer; padding: 0 4px; }
.comment { padding: 8px 16px; border-bottom: 1px solid var(--vscode-panel-border); }
.comment.question { border-left: 3px solid var(--color-changed); }
.comment-header { display: flex; gap: 8px; align-items: center; margin-bottom: 4px; }
.comment-author { font-weight: bold; font-size: var(--font-label); }
.comment-type { font-size: var(--font-caption); }
.comment-time { font-size: var(--font-caption); margin-left: auto; }
.comment-location { font-size: var(--font-caption); margin-bottom: 4px; }
.comment-body { white-space: pre-wrap; }
.reply-btn { background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; font-size: var(--font-caption); padding: 4px 0; }
.new-comment { padding: 12px 16px; border-top: 1px solid var(--vscode-panel-border); }
.new-comment textarea { width: 100%; min-height: 60px; resize: vertical; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 6px; font-family: var(--vscode-font-family); font-size: var(--font-body); border-radius: 2px; }
.new-comment .actions { display: flex; gap: 6px; margin-top: 6px; }
.add-reviewer-row { display: flex; gap: 4px; margin-top: 6px; }
.add-reviewer-row input { flex: 1; }
</style>
</head>
<body style="overflow-y:auto;">
	<div class="review-header">
		<div class="review-title">${esc(review.title)}</div>
		<div class="review-meta">
			<span>
				<span class="review-status" style="background:${statusColor[review.status]}33; color:${statusColor[review.status]}">
					${esc(review.status)}
				</span>
			</span>
			<span>Owner: ${esc(review.owner)}</span>
			<span>Target: ${esc(review.targetType)} ${esc(review.targetSpec ?? '')}</span>
			<span>${review.commentsCount} comment(s)</span>
			<span>Created: ${formatDate(review.created)}</span>
		</div>
		${review.description ? `<div style="margin-top:8px;white-space:pre-wrap">${esc(review.description)}</div>` : ''}
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

		document.getElementById('statusBtn').addEventListener('click', () => {
			const status = document.getElementById('statusSelect').value;
			vscode.postMessage({ type: 'changeStatus', status });
		});

		document.getElementById('submitCommentBtn').addEventListener('click', () => {
			const input = document.getElementById('commentInput');
			const text = input.value.trim();
			if (!text) return;
			vscode.postMessage({ type: 'addComment', text });
			input.value = '';
		});

		document.getElementById('addReviewerBtn').addEventListener('click', () => {
			const input = document.getElementById('newReviewerInput');
			const reviewer = input.value.trim();
			if (!reviewer) return;
			vscode.postMessage({ type: 'addReviewer', reviewer });
			input.value = '';
		});

		document.querySelectorAll('.reviewer-status-select').forEach(sel => {
			sel.addEventListener('change', (e) => {
				const reviewer = e.target.dataset.reviewer;
				vscode.postMessage({ type: 'changeReviewerStatus', reviewer, status: e.target.value });
			});
		});

		document.querySelectorAll('.remove-reviewer-btn').forEach(btn => {
			btn.addEventListener('click', (e) => {
				const reviewer = e.target.dataset.reviewer;
				vscode.postMessage({ type: 'removeReviewer', reviewer });
			});
		});

		document.querySelectorAll('.reply-btn').forEach(btn => {
			btn.addEventListener('click', (e) => {
				const parentId = parseInt(e.target.dataset.commentId);
				const text = prompt('Reply:');
				if (text) {
					vscode.postMessage({ type: 'addComment', text, parentId });
				}
			});
		});
	</script>
</body>
</html>`;
	}

	private buildErrorHtml(err: unknown): string {
		const msg = err instanceof Error ? err.message : String(err);
		return `<!DOCTYPE html><html><head><style>${errorStyles}</style></head><body>
			<div class="err"><h3>Failed to load review</h3><pre>${esc(msg)}</pre>
			<button onclick="location.reload()">Retry</button></div>
		</body></html>`;
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
		this.panel.dispose();
	}
}

function esc(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDate(iso: string): string {
	if (!iso) return '';
	try {
		const d = new Date(iso);
		return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
			+ ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
	} catch {
		return iso;
	}
}
