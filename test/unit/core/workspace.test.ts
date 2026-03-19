import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/core/backend', () => ({
	getBackend: vi.fn(),
}));

import { getBackend } from '../../../src/core/backend';
import {
	fetchWorkspaceStatus, getCurrentBranch, checkinFiles, fetchFileContent,
	listBranches, switchBranch, updateWorkspace,
	listCodeReviews, getCodeReview, createCodeReview, addReviewComment,
	getReviewComments, addReviewers, removeReviewer, updateReviewerStatus,
	listLockRules, createLockRule, deleteLockRules, releaseLocks,
} from '../../../src/core/workspace';

const mockGetBackend = vi.mocked(getBackend);

describe('workspace facade', () => {
	const fakeBackend = {
		name: 'fake',
		getStatus: vi.fn(),
		getCurrentBranch: vi.fn(),
		checkin: vi.fn(),
		getFileContent: vi.fn(),
		listBranches: vi.fn(),
		createBranch: vi.fn(),
		deleteBranch: vi.fn(),
		switchBranch: vi.fn(),
		listChangesets: vi.fn(),
		getChangesetDiff: vi.fn(),
		updateWorkspace: vi.fn(),
		listCodeReviews: vi.fn(),
		getCodeReview: vi.fn(),
		createCodeReview: vi.fn(),
		deleteCodeReview: vi.fn(),
		updateCodeReviewStatus: vi.fn(),
		getReviewComments: vi.fn(),
		addReviewComment: vi.fn(),
		getReviewers: vi.fn(),
		addReviewers: vi.fn(),
		removeReviewer: vi.fn(),
		updateReviewerStatus: vi.fn(),
		listLabels: vi.fn(),
		createLabel: vi.fn(),
		deleteLabel: vi.fn(),
		getFileHistory: vi.fn(),
		getBlame: vi.fn(),
		checkMergeAllowed: vi.fn(),
		executeMerge: vi.fn(),
		listLockRules: vi.fn(),
		createLockRule: vi.fn(),
		deleteLockRules: vi.fn(),
		deleteLockRulesForRepo: vi.fn(),
		releaseLocks: vi.fn(),
	};

	beforeEach(() => {
		vi.clearAllMocks();
		mockGetBackend.mockReturnValue(fakeBackend as any);
	});

	it('fetchWorkspaceStatus delegates to getStatus', async () => {
		const expected = { changes: [] };
		fakeBackend.getStatus.mockResolvedValue(expected);

		const result = await fetchWorkspaceStatus(true);
		expect(result).toBe(expected);
		expect(fakeBackend.getStatus).toHaveBeenCalledWith(true);
	});

	it('getCurrentBranch delegates', async () => {
		fakeBackend.getCurrentBranch.mockResolvedValue('/main');
		const result = await getCurrentBranch();
		expect(result).toBe('/main');
	});

	it('checkinFiles delegates', async () => {
		const expected = { changesetId: 1, branchName: '/main' };
		fakeBackend.checkin.mockResolvedValue(expected);

		const result = await checkinFiles(['/foo'], 'msg');
		expect(result).toBe(expected);
		expect(fakeBackend.checkin).toHaveBeenCalledWith(['/foo'], 'msg');
	});

	it('fetchFileContent delegates', async () => {
		const bytes = new Uint8Array([1, 2, 3]);
		fakeBackend.getFileContent.mockResolvedValue(bytes);

		const result = await fetchFileContent('rev:1');
		expect(result).toBe(bytes);
		expect(fakeBackend.getFileContent).toHaveBeenCalledWith('rev:1');
	});

	it('listBranches delegates', async () => {
		const expected = [{ id: 1, name: '/main', owner: 'alice', date: '', isMain: true }];
		fakeBackend.listBranches.mockResolvedValue(expected);

		const result = await listBranches();
		expect(result).toBe(expected);
		expect(fakeBackend.listBranches).toHaveBeenCalledOnce();
	});

	it('switchBranch delegates', async () => {
		fakeBackend.switchBranch.mockResolvedValue(undefined);

		await switchBranch('/main/feature');
		expect(fakeBackend.switchBranch).toHaveBeenCalledWith('/main/feature');
	});

	it('updateWorkspace delegates', async () => {
		const expected = { updatedFiles: 5, conflicts: [] };
		fakeBackend.updateWorkspace.mockResolvedValue(expected);

		const result = await updateWorkspace();
		expect(result).toBe(expected);
	});

	it('listCodeReviews delegates with filter', async () => {
		const expected = [{ id: 1, title: 'Review' }];
		fakeBackend.listCodeReviews.mockResolvedValue(expected);

		const result = await listCodeReviews('pending');
		expect(result).toBe(expected);
		expect(fakeBackend.listCodeReviews).toHaveBeenCalledWith('pending');
	});

	it('getCodeReview delegates', async () => {
		const expected = { id: 1, title: 'Review' };
		fakeBackend.getCodeReview.mockResolvedValue(expected);

		const result = await getCodeReview(1);
		expect(result).toBe(expected);
	});

	it('createCodeReview delegates', async () => {
		const params = { title: 'Test', targetType: 'Branch' as const, targetId: 1 };
		const expected = { id: 1, ...params };
		fakeBackend.createCodeReview.mockResolvedValue(expected);

		const result = await createCodeReview(params);
		expect(result).toBe(expected);
	});

	it('addReviewComment delegates', async () => {
		const params = { reviewId: 1, text: 'LGTM' };
		const expected = { id: 1, text: 'LGTM' };
		fakeBackend.addReviewComment.mockResolvedValue(expected);

		const result = await addReviewComment(params);
		expect(result).toBe(expected);
	});

	it('getReviewComments delegates', async () => {
		const expected = [{ id: 1, text: 'nice' }];
		fakeBackend.getReviewComments.mockResolvedValue(expected);

		const result = await getReviewComments(42);
		expect(result).toBe(expected);
		expect(fakeBackend.getReviewComments).toHaveBeenCalledWith(42);
	});

	it('addReviewers delegates', async () => {
		fakeBackend.addReviewers.mockResolvedValue(undefined);

		await addReviewers(1, ['alice', 'bob']);
		expect(fakeBackend.addReviewers).toHaveBeenCalledWith(1, ['alice', 'bob']);
	});

	it('removeReviewer delegates', async () => {
		fakeBackend.removeReviewer.mockResolvedValue(undefined);

		await removeReviewer(1, 'alice');
		expect(fakeBackend.removeReviewer).toHaveBeenCalledWith(1, 'alice');
	});

	it('updateReviewerStatus delegates', async () => {
		fakeBackend.updateReviewerStatus.mockResolvedValue(undefined);

		await updateReviewerStatus(1, 'alice', 'Reviewed');
		expect(fakeBackend.updateReviewerStatus).toHaveBeenCalledWith(1, 'alice', 'Reviewed');
	});

	it('listLockRules delegates', async () => {
		const expected = [{ name: 'Art Lock', rules: '*.psd', targetBranch: '/main', excludedBranches: [], destinationBranches: [] }];
		fakeBackend.listLockRules.mockResolvedValue(expected);

		const result = await listLockRules();
		expect(result).toBe(expected);
		expect(fakeBackend.listLockRules).toHaveBeenCalledOnce();
	});

	it('createLockRule delegates', async () => {
		const rule = { name: 'Art Lock', rules: '*.psd', targetBranch: '/main', excludedBranches: [], destinationBranches: [] };
		fakeBackend.createLockRule.mockResolvedValue(rule);

		const result = await createLockRule(rule);
		expect(result).toBe(rule);
		expect(fakeBackend.createLockRule).toHaveBeenCalledWith(rule);
	});

	it('deleteLockRules delegates', async () => {
		fakeBackend.deleteLockRules.mockResolvedValue(undefined);
		await deleteLockRules();
		expect(fakeBackend.deleteLockRules).toHaveBeenCalledOnce();
	});

	it('releaseLocks delegates', async () => {
		fakeBackend.releaseLocks.mockResolvedValue(undefined);
		await releaseLocks([1, 2], 'Release');
		expect(fakeBackend.releaseLocks).toHaveBeenCalledWith([1, 2], 'Release');
	});
});
