import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Uri, createMockMemento, scm } from '../../mocks/vscode';

vi.mock('../../../src/core/workspace', () => ({
	fetchWorkspaceStatus: vi.fn(),
	getCurrentBranch: vi.fn(),
}));

vi.mock('../../../src/api/client', () => ({
	getWorkspaceGuid: vi.fn(() => 'test-ws-guid'),
}));

vi.mock('../../../src/util/config', () => ({
	getConfig: vi.fn(() => ({
		pollInterval: 3000,
		showPrivateFiles: true,
	})),
}));

vi.mock('../../../src/api/errors', () => ({
	AuthExpiredError: class extends Error { constructor() { super(); this.name = 'AuthExpiredError'; } },
	isPlasticApiError: () => false,
}));

vi.mock('../../../src/core/backend', () => ({
	getBackend: vi.fn(() => ({
		name: 'mock',
		getStatus: vi.fn().mockResolvedValue({ changes: [] }),
		getCurrentBranch: vi.fn().mockResolvedValue('/main'),
	})),
}));

import { fetchWorkspaceStatus, getCurrentBranch } from '../../../src/core/workspace';
import { PlasticScmProvider } from '../../../src/scm/plasticScmProvider';

const mockFetchStatus = vi.mocked(fetchWorkspaceStatus);
const mockGetCurrentBranch = vi.mocked(getCurrentBranch);

describe('PlasticScmProvider', () => {
	let provider: PlasticScmProvider;
	const root = Uri.file('/workspace');
	let memento: ReturnType<typeof createMockMemento>;

	beforeEach(() => {
		vi.clearAllMocks();
		memento = createMockMemento();
		mockGetCurrentBranch.mockResolvedValue('/main');
		provider = new PlasticScmProvider(root as any, memento);
	});

	afterEach(() => {
		provider.dispose();
	});

	it('starts with no changes', () => {
		expect(provider.getAllChanges()).toEqual([]);
		expect(provider.getPendingCount()).toBe(0);
	});

	it('returns service', () => {
		expect(provider.getService()).toBeDefined();
	});

	it('gets and clears input box value', () => {
		const sc = scm.createSourceControl.mock.results[0]?.value;
		if (sc) {
			sc.inputBox.value = 'test message';
			expect(provider.getInputBoxValue()).toBe('test message');

			provider.clearInputBox();
			expect(sc.inputBox.value).toBe('');
		}
	});

	describe('refresh', () => {
		it('updates changes from fetchWorkspaceStatus', async () => {
			mockFetchStatus.mockResolvedValue({
				changes: [
					{ path: '/src/a.ts', changeType: 'changed', dataType: 'File' },
					{ path: '/src/b.ts', changeType: 'added', dataType: 'File' },
				],
			});

			await provider.refresh();

			expect(provider.getAllChanges()).toHaveLength(2);
			expect(provider.getPendingCount()).toBe(2);
		});

		it('fires onDidChangeStatus after successful poll', async () => {
			mockFetchStatus.mockResolvedValue({ changes: [] });

			const listener = vi.fn();
			provider.onDidChangeStatus(listener);

			await provider.refresh();
			expect(listener).toHaveBeenCalledTimes(1);
		});
	});

	describe('branch polling', () => {
		it('fires onDidChangeBranch when branch changes', async () => {
			mockFetchStatus.mockResolvedValue({ changes: [] });
			mockGetCurrentBranch.mockResolvedValue('/main');

			const listener = vi.fn();
			provider.onDidChangeBranch(listener);

			await provider.refresh(); // first poll — sets initial branch, fires
			expect(listener).toHaveBeenCalledWith('/main');

			listener.mockClear();
			mockGetCurrentBranch.mockResolvedValue('/main/feature');
			await provider.refresh(); // second poll — branch changed, fires again
			expect(listener).toHaveBeenCalledWith('/main/feature');
		});

		it('does not fire onDidChangeBranch when branch stays same', async () => {
			mockFetchStatus.mockResolvedValue({ changes: [] });
			mockGetCurrentBranch.mockResolvedValue('/main');

			await provider.refresh(); // first poll sets baseline

			const listener = vi.fn();
			provider.onDidChangeBranch(listener);

			await provider.refresh(); // same branch — no fire
			expect(listener).not.toHaveBeenCalled();
		});

		it('exposes current branch name after refresh', async () => {
			mockFetchStatus.mockResolvedValue({ changes: [] });
			mockGetCurrentBranch.mockResolvedValue('/main/feature');

			await provider.refresh();
			expect(provider.getCurrentBranchName()).toBe('/main/feature');
		});
	});

	describe('dispose', () => {
		it('does not throw', () => {
			expect(() => provider.dispose()).not.toThrow();
		});
	});
});
