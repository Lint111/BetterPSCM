import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { window, EventEmitter } from '../../mocks/vscode';

vi.mock('../../../src/core/workspace', () => ({
	getCurrentBranch: vi.fn(),
}));

import { getCurrentBranch } from '../../../src/core/workspace';
import { PlasticStatusBar } from '../../../src/statusBar/plasticStatusBar';

const mockGetCurrentBranch = vi.mocked(getCurrentBranch);

function createMockProvider() {
	const statusEmitter = new EventEmitter<void>();
	const branchEmitter = new EventEmitter<string>();
	return {
		onDidChangeStatus: statusEmitter.event,
		onDidChangeBranch: branchEmitter.event,
		getPendingCount: vi.fn(() => 0),
		getStagedCount: vi.fn(() => 0),
		getCurrentBranchName: vi.fn(() => undefined as string | undefined),
		_fireStatusChange: () => statusEmitter.fire(),
		_fireBranchChange: (branch: string) => branchEmitter.fire(branch),
	};
}

describe('PlasticStatusBar', () => {
	let statusBar: PlasticStatusBar;
	let provider: ReturnType<typeof createMockProvider>;

	beforeEach(() => {
		vi.clearAllMocks();
		mockGetCurrentBranch.mockResolvedValue('/main/Feature');
		provider = createMockProvider();
		statusBar = new PlasticStatusBar(provider as any);
	});

	afterEach(() => {
		statusBar.dispose();
	});

	it('creates two status bar items', () => {
		expect(window.createStatusBarItem).toHaveBeenCalledTimes(2);
	});

	it('shows branch name after update', async () => {
		await statusBar.update();

		const branchItem = window.createStatusBarItem.mock.results[0].value;
		expect(branchItem.text).toContain('/main/Feature');
	});

	it('shows fallback when branch is undefined', async () => {
		mockGetCurrentBranch.mockResolvedValue(undefined);
		await statusBar.update();

		const branchItem = window.createStatusBarItem.mock.results[0].value;
		expect(branchItem.text).toContain('BetterPSCM');
	});

	it('shows fallback on branch error', async () => {
		mockGetCurrentBranch.mockRejectedValue(new Error('fail'));
		await statusBar.update();

		const branchItem = window.createStatusBarItem.mock.results[0].value;
		expect(branchItem.text).toContain('BetterPSCM');
	});

	it('shows "No changes" when count is 0', async () => {
		provider.getPendingCount.mockReturnValue(0);
		await statusBar.update();

		const changesItem = window.createStatusBarItem.mock.results[1].value;
		expect(changesItem.text).toContain('No changes');
	});

	it('shows change count when changes exist', async () => {
		provider.getPendingCount.mockReturnValue(5);
		provider.getStagedCount.mockReturnValue(0);

		await statusBar.update();

		const changesItem = window.createStatusBarItem.mock.results[1].value;
		expect(changesItem.text).toContain('5');
	});

	it('shows staged/total when files are staged', async () => {
		provider.getPendingCount.mockReturnValue(5);
		provider.getStagedCount.mockReturnValue(2);

		await statusBar.update();

		const changesItem = window.createStatusBarItem.mock.results[1].value;
		expect(changesItem.text).toContain('2/5');
	});

	it('updates changes on status change event', () => {
		provider.getPendingCount.mockReturnValue(3);
		provider.getStagedCount.mockReturnValue(0);

		provider._fireStatusChange();

		const changesItem = window.createStatusBarItem.mock.results[1].value;
		expect(changesItem.text).toContain('3');
	});

	it('updates branch on branch change event', () => {
		provider._fireBranchChange('/main/newBranch');

		const branchItem = window.createStatusBarItem.mock.results[0].value;
		expect(branchItem.text).toContain('/main/newBranch');
	});

	it('updates branch from provider on status change event', () => {
		provider.getCurrentBranchName.mockReturnValue('/main/updated');
		provider._fireStatusChange();

		const branchItem = window.createStatusBarItem.mock.results[0].value;
		expect(branchItem.text).toContain('/main/updated');
	});

	it('dispose does not throw', () => {
		expect(() => statusBar.dispose()).not.toThrow();
	});
});
