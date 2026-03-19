import { getBackend } from '../core/backend';
import { resolveComments } from '../core/reviewResolver';
import type { CodeReviewInfo, ReviewCommentType } from '../core/types';

export interface ReviewAuditParams {
	reviewId?: number;
	branch?: string;
}

export interface ReviewAuditComment {
	id: number;
	line: number;
	owner: string;
	type: ReviewCommentType;
	text: string;
	timestamp: string;
}

export interface ReviewAuditResult {
	review: CodeReviewInfo;
	commentsByFile: Record<string, ReviewAuditComment[]>;
	totalComments: number;
}

export async function buildReviewAudit(params: ReviewAuditParams): Promise<ReviewAuditResult> {
	const { reviewId, branch } = params;

	if (!reviewId && !branch) {
		throw new Error('Provide either reviewId or branch');
	}

	const backend = getBackend();

	let review: CodeReviewInfo;
	if (reviewId) {
		review = await backend.getCodeReview(reviewId);
	} else {
		const all = await backend.listCodeReviews('all');
		const match = all.find(r => r.targetSpec === branch);
		if (!match) {
			throw new Error(`No code review found targeting branch "${branch}"`);
		}
		review = match;
	}

	const rawComments = await backend.getReviewComments(review.id);
	const resolved = await resolveComments(
		rawComments,
		(ids) => backend.resolveRevisionPaths(ids),
	);

	const commentsByFile: Record<string, ReviewAuditComment[]> = {};
	for (const c of resolved) {
		const group = commentsByFile[c.filePath] ??= [];
		group.push({
			id: c.id,
			line: c.lineNumber,
			owner: c.owner,
			type: c.type,
			text: c.text,
			timestamp: c.timestamp,
		});
	}

	return { review, commentsByFile, totalComments: resolved.length };
}
