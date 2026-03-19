import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/core/workspace', () => ({
	listCodeReviews: vi.fn(),
}));

vi.mock('../../../src/util/logger', () => ({
	logError: vi.fn(),
}));

import { CodeReviewsTreeProvider } from '../../../src/views/codeReviewsTreeProvider';
import { listCodeReviews } from '../../../src/core/workspace';
import type { CodeReviewInfo } from '../../../src/core/types';
import { NotSupportedError } from '../../../src/core/types';

const mockListCodeReviews = vi.mocked(listCodeReviews);

const makeReview = (overrides: Partial<CodeReviewInfo> = {}): CodeReviewInfo => ({
	id: 1,
	title: 'Review #1',
	status: 'Under review',
	owner: 'alice',
	created: '2026-01-01',
	modified: '2026-01-02',
	targetType: 'Branch',
	targetSpec: '/main/feature',
	targetId: 10,
	commentsCount: 3,
	reviewers: [],
	...overrides,
});

describe('CodeReviewsTreeProvider', () => {
	let provider: CodeReviewsTreeProvider;

	beforeEach(() => {
		vi.clearAllMocks();
		provider = new CodeReviewsTreeProvider();
	});

	it('starts with all filter', () => {
		expect(provider.filter).toBe('all');
	});

	it('returns review items', async () => {
		mockListCodeReviews.mockResolvedValue([
			makeReview({ id: 1, title: 'Fix auth' }),
			makeReview({ id: 2, title: 'Add logging', status: 'Reviewed' }),
		]);

		const children = await provider.getChildren();
		expect(children).toHaveLength(2);
	});

	it('sets contextValue on review items', async () => {
		mockListCodeReviews.mockResolvedValue([makeReview()]);
		const children = await provider.getChildren();
		expect(children[0].contextValue).toBe('codeReview');
	});

	it('attaches open command to items', async () => {
		mockListCodeReviews.mockResolvedValue([makeReview({ id: 42 })]);
		const children = await provider.getChildren();
		expect(children[0].command?.command).toBe('bpscm.openCodeReview');
		expect(children[0].command?.arguments).toEqual([42]);
	});

	it('shows placeholder when no reviews found', async () => {
		mockListCodeReviews.mockResolvedValue([]);
		const children = await provider.getChildren();
		expect(children).toHaveLength(1);
		expect(children[0].label).toContain('No code reviews');
	});

	it('shows message when CLI backend (NotSupportedError)', async () => {
		mockListCodeReviews.mockRejectedValue(new NotSupportedError('listCodeReviews', 'cm CLI'));
		const children = await provider.getChildren();
		expect(children).toHaveLength(1);
		expect(String(children[0].label)).toContain('REST API');
	});

	it('shows error message on failure', async () => {
		mockListCodeReviews.mockRejectedValue(new Error('network error'));
		const children = await provider.getChildren();
		expect(children).toHaveLength(1);
		expect(String(children[0].label)).toContain('Failed');
	});

	it('setFilter changes filter and triggers refresh', async () => {
		const listener = vi.fn();
		provider.onDidChangeTreeData(listener);

		provider.setFilter('assignedToMe');
		expect(provider.filter).toBe('assignedToMe');
		expect(listener).toHaveBeenCalled();
	});

	it('passes filter to listCodeReviews', async () => {
		mockListCodeReviews.mockResolvedValue([]);
		provider.setFilter('createdByMe');
		await provider.getChildren();
		expect(mockListCodeReviews).toHaveBeenCalledWith('createdByMe');
	});

	it('fires onDidChangeTreeData on refresh', () => {
		const listener = vi.fn();
		provider.onDidChangeTreeData(listener);
		provider.refresh();
		expect(listener).toHaveBeenCalled();
	});

	it('returns no children for sub-items', async () => {
		mockListCodeReviews.mockResolvedValue([makeReview()]);
		const children = await provider.getChildren();
		const subChildren = await provider.getChildren(children[0]);
		expect(subChildren).toEqual([]);
	});

	it('includes tooltip with review details', async () => {
		mockListCodeReviews.mockResolvedValue([
			makeReview({ title: 'Big Fix', owner: 'bob', commentsCount: 5 }),
		]);

		const children = await provider.getChildren();
		const tooltip = String(children[0].tooltip);
		expect(tooltip).toContain('Big Fix');
		expect(tooltip).toContain('bob');
		expect(tooltip).toContain('5');
	});
});
