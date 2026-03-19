import { describe, it, expect, vi } from 'vitest';
import { resolveComments } from '../../../src/core/reviewResolver';
import type { ReviewCommentInfo, ResolvedComment } from '../../../src/core/types';

describe('resolveComments', () => {
	it('enriches comments with file paths and line numbers', async () => {
		const comments: ReviewCommentInfo[] = [
			{ id: 1, owner: 'theo', text: 'Fix this', type: 'Comment', timestamp: '2026-02-17T15:00:00', locationSpec: '42939#37' },
			{ id: 2, owner: 'maria', text: 'Looks good', type: 'Comment', timestamp: '2026-02-17T16:00:00', locationSpec: '42940#12' },
		];
		const pathMap = new Map<number, string>([
			[42939, 'C:\\proj\\Assets\\Foo.cs'],
			[42940, 'C:\\proj\\Assets\\Bar.cs'],
		]);
		const resolveFn = vi.fn().mockResolvedValue(pathMap);

		const result = await resolveComments(comments, resolveFn);

		expect(resolveFn).toHaveBeenCalledWith([42939, 42940]);
		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({
			id: 2, owner: 'maria', text: 'Looks good', type: 'Comment', timestamp: '2026-02-17T16:00:00',
			filePath: 'C:\\proj\\Assets\\Bar.cs', lineNumber: 12, revisionId: 42940,
		});
		expect(result[1]).toEqual({
			id: 1, owner: 'theo', text: 'Fix this', type: 'Comment', timestamp: '2026-02-17T15:00:00',
			filePath: 'C:\\proj\\Assets\\Foo.cs', lineNumber: 37, revisionId: 42939,
		});
	});

	it('skips comments without locationSpec', async () => {
		const comments: ReviewCommentInfo[] = [
			{ id: 1, owner: 'theo', text: 'General note', type: 'Comment', timestamp: '2026-02-17T15:00:00' },
			{ id: 2, owner: 'maria', text: 'Fix line', type: 'Comment', timestamp: '2026-02-17T16:00:00', locationSpec: '42939#10' },
		];
		const pathMap = new Map([[42939, 'C:\\proj\\Foo.cs']]);
		const resolveFn = vi.fn().mockResolvedValue(pathMap);

		const result = await resolveComments(comments, resolveFn);

		expect(result).toHaveLength(1);
		expect(result[0].filePath).toBe('C:\\proj\\Foo.cs');
	});

	it('skips comments whose revision ID could not be resolved', async () => {
		const comments: ReviewCommentInfo[] = [
			{ id: 1, owner: 'theo', text: 'Orphan', type: 'Comment', timestamp: '2026-02-17', locationSpec: '99999#5' },
		];
		const resolveFn = vi.fn().mockResolvedValue(new Map());

		const result = await resolveComments(comments, resolveFn);

		expect(result).toHaveLength(0);
	});

	it('deduplicates revision IDs before calling resolve', async () => {
		const comments: ReviewCommentInfo[] = [
			{ id: 1, owner: 'a', text: 'x', type: 'Comment', timestamp: '', locationSpec: '100#1' },
			{ id: 2, owner: 'b', text: 'y', type: 'Comment', timestamp: '', locationSpec: '100#5' },
		];
		const resolveFn = vi.fn().mockResolvedValue(new Map([[100, 'C:\\f.cs']]));

		await resolveComments(comments, resolveFn);

		expect(resolveFn).toHaveBeenCalledWith([100]);
	});

	it('sorts result by filePath then lineNumber', async () => {
		const comments: ReviewCommentInfo[] = [
			{ id: 1, owner: 'a', text: 'x', type: 'Comment', timestamp: '', locationSpec: '200#50' },
			{ id: 2, owner: 'b', text: 'y', type: 'Comment', timestamp: '', locationSpec: '100#10' },
			{ id: 3, owner: 'c', text: 'z', type: 'Comment', timestamp: '', locationSpec: '100#5' },
		];
		const resolveFn = vi.fn().mockResolvedValue(new Map([
			[100, 'A.cs'],
			[200, 'B.cs'],
		]));

		const result = await resolveComments(comments, resolveFn);

		expect(result.map(r => r.id)).toEqual([3, 2, 1]);
	});
});
