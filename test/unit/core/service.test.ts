import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PlasticService } from '../../../src/core/service';
import { InMemoryStagingStore } from '../../../src/core/stagingStore';
import type { PlasticBackend } from '../../../src/core/backend';
import type { StatusResult, NormalizedChange } from '../../../src/core/types';

function mockBackend(changes: NormalizedChange[] = []): PlasticBackend {
	return {
		name: 'mock',
		getStatus: vi.fn().mockResolvedValue({ changes } as StatusResult),
		getCurrentBranch: vi.fn().mockResolvedValue('/main'),
		checkin: vi.fn().mockResolvedValue({ changesetId: 1, branchName: '/main' }),
		addToSourceControl: vi.fn().mockResolvedValue([]),
		// Stub remaining interface methods
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
		undoCheckout: vi.fn(),
		getBaseRevisionContent: vi.fn(),
		checkMergeAllowed: vi.fn(),
		executeMerge: vi.fn(),
		listLockRules: vi.fn(),
		createLockRule: vi.fn(),
		deleteLockRules: vi.fn(),
		deleteLockRulesForRepo: vi.fn(),
		releaseLocks: vi.fn(),
	} as unknown as PlasticBackend;
}

describe('PlasticService — staging', () => {
	let service: PlasticService;
	let store: InMemoryStagingStore;
	let backend: PlasticBackend;

	beforeEach(() => {
		backend = mockBackend([
			{ path: 'Assets/foo.cs', changeType: 'changed', dataType: 'File' },
			{ path: 'Assets/foo.cs.meta', changeType: 'changed', dataType: 'File' },
			{ path: 'Assets/bar.cs', changeType: 'added', dataType: 'File' },
		]);
		store = new InMemoryStagingStore();
		service = new PlasticService(backend, store);
	});

	it('stage adds paths to store', async () => {
		await service.stage(['Assets/foo.cs']);
		expect(service.isStaged('Assets/foo.cs')).toBe(true);
	});

	it('stage with autoMeta expands .meta companions', async () => {
		await service.stage(['Assets/foo.cs'], { autoMeta: true });
		expect(service.isStaged('Assets/foo.cs')).toBe(true);
		expect(service.isStaged('Assets/foo.cs.meta')).toBe(true);
	});

	it('stage without autoMeta does not expand', async () => {
		await service.stage(['Assets/foo.cs'], { autoMeta: false });
		expect(service.isStaged('Assets/foo.cs')).toBe(true);
		expect(service.isStaged('Assets/foo.cs.meta')).toBe(false);
	});

	it('unstage removes paths', async () => {
		await service.stage(['Assets/foo.cs']);
		await service.unstage(['Assets/foo.cs']);
		expect(service.isStaged('Assets/foo.cs')).toBe(false);
	});

	it('stageAll stages all current changes', async () => {
		await service.stageAll();
		expect(service.getStagedPaths().length).toBe(3);
	});

	it('unstageAll clears all staged', async () => {
		await service.stageAll();
		await service.unstageAll();
		expect(service.getStagedPaths().length).toBe(0);
	});

	it('pruneStale removes paths not in current changes', async () => {
		store.add(['Assets/deleted.cs']);
		await service.pruneStale();
		expect(service.isStaged('Assets/deleted.cs')).toBe(false);
	});
});
