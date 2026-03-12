import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/core/backend', () => ({
	getBackend: vi.fn(),
}));

import { getBackend } from '../../../src/core/backend';
import { fetchWorkspaceStatus, getCurrentBranch, checkinFiles, fetchFileContent, listBranches, switchBranch } from '../../../src/core/workspace';

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
});
