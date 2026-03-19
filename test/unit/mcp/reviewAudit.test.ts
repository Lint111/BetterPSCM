import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CodeReviewInfo, ReviewCommentInfo } from '../../../src/core/types';

vi.mock('../../../src/core/backend', () => {
	const mockBackend = {
		getCodeReview: vi.fn(),
		listCodeReviews: vi.fn(),
		getReviewComments: vi.fn(),
		resolveRevisionPaths: vi.fn(),
	};
	return {
		getBackend: vi.fn(() => mockBackend),
		__mockBackend: mockBackend,
	};
});

vi.mock('../../../src/util/logger', () => ({
	log: vi.fn(),
	logError: vi.fn(),
}));

const mockBackend = (await import('../../../src/core/backend') as any).__mockBackend;

import { buildReviewAudit } from '../../../src/mcp/reviewAudit';

const sampleReview: CodeReviewInfo = {
	id: 100,
	title: 'Fix null checks',
	status: 'Under review',
	owner: 'alice@example.com',
	created: '2026-03-19T10:00:00',
	modified: '2026-03-19T12:00:00',
	targetType: 'Branch',
	targetSpec: '/main/feature-x',
	targetId: 50,
	commentsCount: 2,
	reviewers: [],
};

const sampleComments: ReviewCommentInfo[] = [
	{
		id: 1, owner: 'bob@example.com', text: 'This null check is wrong',
		type: 'Comment', timestamp: '2026-03-19T11:00:00', locationSpec: '200#37',
	},
	{
		id: 2, owner: 'carol@example.com', text: 'Missing error handling',
		type: 'Question', timestamp: '2026-03-19T11:30:00', locationSpec: '201#15',
	},
	{
		id: 3, owner: 'dave@example.com', text: 'General note',
		type: 'Comment', timestamp: '2026-03-19T11:45:00',
	},
];

describe('buildReviewAudit', () => {
	beforeEach(() => vi.clearAllMocks());

	it('returns audit for a review by ID', async () => {
		mockBackend.getCodeReview.mockResolvedValue(sampleReview);
		mockBackend.getReviewComments.mockResolvedValue(sampleComments);
		mockBackend.resolveRevisionPaths.mockResolvedValue(
			new Map([[200, 'Assets/Scripts/Foo.cs'], [201, 'Assets/Scripts/Bar.cs']]),
		);

		const result = await buildReviewAudit({ reviewId: 100 });

		expect(result.review.id).toBe(100);
		expect(result.totalComments).toBe(2);
		expect(result.commentsByFile['Assets/Scripts/Foo.cs']).toHaveLength(1);
		expect(result.commentsByFile['Assets/Scripts/Foo.cs'][0].line).toBe(37);
		expect(result.commentsByFile['Assets/Scripts/Bar.cs']).toHaveLength(1);
		expect(result.commentsByFile['Assets/Scripts/Bar.cs'][0].line).toBe(15);
	});

	it('finds review by branch name', async () => {
		mockBackend.listCodeReviews.mockResolvedValue([
			{ ...sampleReview, id: 99, targetSpec: '/main/other' },
			sampleReview,
		]);
		mockBackend.getReviewComments.mockResolvedValue([]);
		mockBackend.resolveRevisionPaths.mockResolvedValue(new Map());

		const result = await buildReviewAudit({ branch: '/main/feature-x' });

		expect(result.review.id).toBe(100);
		expect(mockBackend.listCodeReviews).toHaveBeenCalledWith('all');
	});

	it('throws when neither reviewId nor branch provided', async () => {
		await expect(buildReviewAudit({})).rejects.toThrow('Provide either reviewId or branch');
	});

	it('throws when no review matches branch', async () => {
		mockBackend.listCodeReviews.mockResolvedValue([
			{ ...sampleReview, targetSpec: '/main/other' },
		]);
		await expect(buildReviewAudit({ branch: '/main/nonexistent' }))
			.rejects.toThrow('No code review found targeting branch');
	});

	it('excludes comments without locationSpec', async () => {
		mockBackend.getCodeReview.mockResolvedValue(sampleReview);
		mockBackend.getReviewComments.mockResolvedValue(sampleComments);
		mockBackend.resolveRevisionPaths.mockResolvedValue(
			new Map([[200, 'Assets/Scripts/Foo.cs'], [201, 'Assets/Scripts/Bar.cs']]),
		);

		const result = await buildReviewAudit({ reviewId: 100 });

		const all = Object.values(result.commentsByFile).flat();
		expect(all.find(c => c.id === 3)).toBeUndefined();
		expect(result.totalComments).toBe(2);
	});

	it('groups multiple comments under same file', async () => {
		mockBackend.getCodeReview.mockResolvedValue(sampleReview);
		mockBackend.getReviewComments.mockResolvedValue([
			{ id: 10, owner: 'a', text: 'First', type: 'Comment', timestamp: '', locationSpec: '200#10' },
			{ id: 11, owner: 'b', text: 'Second', type: 'Comment', timestamp: '', locationSpec: '200#25' },
		]);
		mockBackend.resolveRevisionPaths.mockResolvedValue(new Map([[200, 'Foo.cs']]));

		const result = await buildReviewAudit({ reviewId: 100 });

		expect(result.commentsByFile['Foo.cs']).toHaveLength(2);
		expect(result.commentsByFile['Foo.cs'][0].line).toBe(10);
		expect(result.commentsByFile['Foo.cs'][1].line).toBe(25);
	});
});
