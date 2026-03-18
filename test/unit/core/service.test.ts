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

describe('PlasticService — checkin', () => {
	let store: InMemoryStagingStore;
	let backend: ReturnType<typeof mockBackend>;

	function makeService(changes: NormalizedChange[]) {
		backend = mockBackend(changes) as ReturnType<typeof mockBackend>;
		store = new InMemoryStagingStore();
		return new PlasticService(backend, store);
	}

	it('checkin with all=true commits all non-directory changes', async () => {
		const service = makeService([
			{ path: 'Assets/foo.cs', changeType: 'changed', dataType: 'File' },
			{ path: 'Assets', changeType: 'changed', dataType: 'Directory' },
		]);
		const result = await service.checkin({ comment: 'test', all: true });
		expect(backend.checkin).toHaveBeenCalledWith(['Assets/foo.cs'], 'test');
	});

	it('checkin with staged paths uses store', async () => {
		const service = makeService([
			{ path: 'Assets/foo.cs', changeType: 'changed', dataType: 'File' },
			{ path: 'Assets/bar.cs', changeType: 'changed', dataType: 'File' },
		]);
		store.add(['Assets/foo.cs']);
		const result = await service.checkin({ comment: 'test' });
		expect(backend.checkin).toHaveBeenCalledWith(['Assets/foo.cs'], 'test');
	});

	it('checkin excludes specified paths', async () => {
		const service = makeService([
			{ path: 'Assets/foo.cs', changeType: 'changed', dataType: 'File' },
			{ path: 'Assets/bar.cs', changeType: 'changed', dataType: 'File' },
		]);
		const result = await service.checkin({
			comment: 'test', all: true, excludePaths: ['Assets/bar.cs'],
		});
		expect(backend.checkin).toHaveBeenCalledWith(['Assets/foo.cs'], 'test');
	});

	it('checkin auto-adds private files', async () => {
		const service = makeService([
			{ path: 'Assets/new.cs', changeType: 'private', dataType: 'File' },
			{ path: 'Assets/new.cs.meta', changeType: 'private', dataType: 'File' },
		]);
		const result = await service.checkin({
			comment: 'test', all: true, autoAddPrivate: true,
		});
		expect(backend.addToSourceControl).toHaveBeenCalled();
		const addedPaths = (backend.addToSourceControl as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(addedPaths).toContain('Assets/new.cs');
		expect(addedPaths).toContain('Assets/new.cs.meta');
	});

	it('checkin filters out non-committable changes', async () => {
		const service = makeService([
			{ path: 'Assets/foo.cs', changeType: 'changed', dataType: 'File' },
			{ path: 'Assets/stale.cs', changeType: 'checkedOut', dataType: 'File' },
		]);
		const result = await service.checkin({ comment: 'test', all: true });
		expect(backend.checkin).toHaveBeenCalledWith(['Assets/foo.cs'], 'test');
		expect(result.autoExcluded).toContain('Assets/stale.cs');
	});

	it('checkin clears staging store on success', async () => {
		const service = makeService([
			{ path: 'Assets/foo.cs', changeType: 'changed', dataType: 'File' },
		]);
		store.add(['Assets/foo.cs']);
		await service.checkin({ comment: 'test' });
		expect(service.getStagedPaths().length).toBe(0);
	});

	it('checkin retries on "not changed" rejection', async () => {
		const service = makeService([
			{ path: 'Assets/foo.cs', changeType: 'changed', dataType: 'File' },
			{ path: 'Assets/stale', changeType: 'locallyDeleted', dataType: 'Directory' },
		]);
		(backend.checkin as ReturnType<typeof vi.fn>)
			.mockRejectedValueOnce(new Error("The item 'Assets/stale' is not changed in current workspace"))
			.mockResolvedValueOnce({ changesetId: 1, branchName: '/main' });

		const result = await service.checkin({ comment: 'test', all: true });
		expect(backend.checkin).toHaveBeenCalledTimes(2);
		expect(result.autoExcluded).toContain('Assets/stale');
	});

	it('checkin throws if no paths to commit', async () => {
		const service = makeService([
			{ path: 'Assets/stale.cs', changeType: 'checkedOut', dataType: 'File' },
		]);
		await expect(service.checkin({ comment: 'test', all: true }))
			.rejects.toThrow('No files with real changes');
	});

	it('checkin throws if no staged and all=false', async () => {
		const service = makeService([
			{ path: 'Assets/foo.cs', changeType: 'changed', dataType: 'File' },
		]);
		await expect(service.checkin({ comment: 'test' }))
			.rejects.toThrow('No files staged');
	});
});

describe('PlasticService — addToSourceControl', () => {
	it('resolves directory prefixes to matching private files', async () => {
		const backend = mockBackend([
			{ path: 'Assets/Scripts/Foo.cs', changeType: 'private', dataType: 'File' },
			{ path: 'Assets/Scripts/Bar.cs', changeType: 'private', dataType: 'File' },
			{ path: 'Assets/Data/baz.asset', changeType: 'private', dataType: 'File' },
			{ path: 'Assets/Scripts/Tracked.cs', changeType: 'changed', dataType: 'File' },
		]);
		const store = new InMemoryStagingStore();
		const service = new PlasticService(backend, store);

		const added = await service.addToSourceControl(['Assets/Scripts'], { autoMeta: false });
		expect(backend.addToSourceControl).toHaveBeenCalled();
		const paths = (backend.addToSourceControl as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(paths).toContain('Assets/Scripts/Foo.cs');
		expect(paths).toContain('Assets/Scripts/Bar.cs');
		expect(paths).not.toContain('Assets/Data/baz.asset');
		expect(paths).not.toContain('Assets/Scripts/Tracked.cs');
	});

	it('expands .meta companions when autoMeta=true', async () => {
		const backend = mockBackend([
			{ path: 'Assets/new.cs', changeType: 'private', dataType: 'File' },
			{ path: 'Assets/new.cs.meta', changeType: 'private', dataType: 'File' },
		]);
		const store = new InMemoryStagingStore();
		const service = new PlasticService(backend, store);

		await service.addToSourceControl(['Assets/new.cs'], { autoMeta: true });
		const paths = (backend.addToSourceControl as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(paths).toContain('Assets/new.cs');
		expect(paths).toContain('Assets/new.cs.meta');
	});
});
