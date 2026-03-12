import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/core/workspace', () => ({
	listBranches: vi.fn(),
	getCurrentBranch: vi.fn(),
}));

vi.mock('../../../src/util/logger', () => ({
	logError: vi.fn(),
}));

import { BranchesTreeProvider } from '../../../src/views/branchesTreeProvider';
import { listBranches, getCurrentBranch } from '../../../src/core/workspace';
import type { BranchInfo } from '../../../src/core/types';

const mockListBranches = vi.mocked(listBranches);
const mockGetCurrentBranch = vi.mocked(getCurrentBranch);

describe('BranchesTreeProvider', () => {
	let provider: BranchesTreeProvider;

	beforeEach(() => {
		vi.clearAllMocks();
		provider = new BranchesTreeProvider();
	});

	it('returns branch items as children', async () => {
		mockListBranches.mockResolvedValue([
			{ id: 1, name: '/main', owner: 'user', date: '2026-01-01', isMain: true },
			{ id: 2, name: '/main/feature', owner: 'dev', date: '2026-03-01', isMain: false },
		]);
		mockGetCurrentBranch.mockResolvedValue('/main');

		const children = await provider.getChildren();
		expect(children).toHaveLength(2);
	});

	it('sorts current branch first', async () => {
		mockListBranches.mockResolvedValue([
			{ id: 2, name: '/main/feature', owner: 'dev', date: '2026-03-01', isMain: false },
			{ id: 1, name: '/main', owner: 'user', date: '2026-01-01', isMain: true },
		]);
		mockGetCurrentBranch.mockResolvedValue('/main');

		const children = await provider.getChildren();
		expect(children![0].branch.name).toBe('/main');
	});

	it('marks current branch with checkmark description including date', async () => {
		mockListBranches.mockResolvedValue([
			{ id: 1, name: '/main', owner: 'user', date: '2026-01-01', isMain: true },
		]);
		mockGetCurrentBranch.mockResolvedValue('/main');

		const children = await provider.getChildren();
		const item = provider.getTreeItem(children![0]);
		expect(item.description).toContain('current');
		expect(item.description).toContain('2026-01-01');
		expect(item.description).toContain('user');
	});

	it('returns empty array on error', async () => {
		mockListBranches.mockRejectedValue(new Error('fail'));
		mockGetCurrentBranch.mockResolvedValue(undefined);

		const children = await provider.getChildren();
		expect(children).toEqual([]);
	});

	it('fires onDidChangeTreeData on refresh', () => {
		const listener = vi.fn();
		provider.onDidChangeTreeData(listener);
		provider.refresh();
		expect(listener).toHaveBeenCalled();
	});
});
