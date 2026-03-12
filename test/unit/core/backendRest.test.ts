import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/api/client', () => ({
	getClient: vi.fn(),
	getOrgName: vi.fn(() => 'test-org'),
	getWorkspaceGuid: vi.fn(() => 'test-guid'),
	getRepoName: vi.fn(() => 'test-repo'),
}));

import { getClient } from '../../../src/api/client';
import { RestBackend } from '../../../src/core/backendRest';

const mockGetClient = vi.mocked(getClient);

function setupClient(method: 'GET' | 'POST' | 'DELETE', response: { data?: any; error?: any }) {
	const clientMock = {
		GET: vi.fn().mockResolvedValue(method === 'GET' ? response : { data: null, error: null }),
		POST: vi.fn().mockResolvedValue(method === 'POST' ? response : { data: null, error: null }),
		DELETE: vi.fn().mockResolvedValue(method === 'DELETE' ? response : { data: null, error: null }),
	};
	mockGetClient.mockReturnValue(clientMock as any);
	return clientMock;
}

function setupMultiGet(responses: { data?: any; error?: any }[]) {
	const clientMock = {
		GET: vi.fn(),
		POST: vi.fn().mockResolvedValue({ data: null, error: null }),
		DELETE: vi.fn().mockResolvedValue({ data: null, error: null }),
	};
	for (const r of responses) {
		clientMock.GET.mockResolvedValueOnce(r);
	}
	mockGetClient.mockReturnValue(clientMock as any);
	return clientMock;
}

describe('RestBackend', () => {
	let backend: RestBackend;

	beforeEach(() => {
		vi.clearAllMocks();
		backend = new RestBackend();
	});

	it('has name "REST API"', () => {
		expect(backend.name).toBe('REST API');
	});

	describe('getStatus', () => {
		it('maps changes through normalizeChange', async () => {
			const client = setupClient('GET', {
				data: {
					changes: [
						{ path: '/src/foo.ts', changeType: 'changed', dataType: 'File' },
						{ path: '/src/bar.ts', changeType: 'added', dataType: 'File' },
					],
				},
			});

			const result = await backend.getStatus(true);
			expect(result.changes).toHaveLength(2);
			expect(result.changes[0].path).toBe('/src/foo.ts');
			expect(client.GET).toHaveBeenCalledOnce();
		});

		it('filters private files when showPrivate=false', async () => {
			setupClient('GET', {
				data: {
					changes: [
						{ path: '/src/foo.ts', changeType: 'changed', dataType: 'File' },
						{ path: '/unversioned.txt', changeType: 'private', dataType: 'File' },
					],
				},
			});

			const result = await backend.getStatus(false);
			expect(result.changes).toHaveLength(1);
		});

		it('throws on error response', async () => {
			setupClient('GET', { error: new Error('network') });
			await expect(backend.getStatus(true)).rejects.toThrow();
		});

		it('returns empty changes when data has no changes array', async () => {
			setupClient('GET', { data: {} });
			const result = await backend.getStatus(true);
			expect(result.changes).toHaveLength(0);
		});
	});

	describe('getCurrentBranch', () => {
		it('extracts branch spec from workspace details', async () => {
			setupClient('GET', {
				data: {
					uvcsConnections: [{
						target: { type: 'Branch', spec: '/main/Feature' },
					}],
				},
			});

			const branch = await backend.getCurrentBranch();
			expect(branch).toBe('/main/Feature');
		});

		it('returns undefined when no connections', async () => {
			setupClient('GET', { data: {} });
			const branch = await backend.getCurrentBranch();
			expect(branch).toBeUndefined();
		});

		it('throws on error', async () => {
			setupClient('GET', { error: new Error('auth') });
			await expect(backend.getCurrentBranch()).rejects.toThrow();
		});
	});

	describe('checkin', () => {
		it('returns CheckinResult from response', async () => {
			const client = setupClient('POST', {
				data: { changesetId: 42, branchName: '/main' },
			});

			const result = await backend.checkin(['/foo.ts'], 'msg');
			expect(result.changesetId).toBe(42);
			expect(result.branchName).toBe('/main');
			expect(client.POST).toHaveBeenCalledOnce();
		});

		it('throws on error', async () => {
			setupClient('POST', { error: new Error('conflict') });
			await expect(backend.checkin(['/foo'], 'msg')).rejects.toThrow();
		});
	});

	describe('getFileContent', () => {
		it('returns Uint8Array from ArrayBuffer', async () => {
			const buf = new ArrayBuffer(4);
			new Uint8Array(buf).set([72, 105, 33, 10]);
			setupClient('GET', { data: buf });

			const result = await backend.getFileContent('rev-guid');
			expect(result).toBeInstanceOf(Uint8Array);
			expect(result?.length).toBe(4);
		});

		it('returns undefined on error', async () => {
			setupClient('GET', { error: new Error('not found') });
			const result = await backend.getFileContent('rev-guid');
			expect(result).toBeUndefined();
		});
	});

	describe('listBranches', () => {
		it('returns mapped BranchInfo list', async () => {
			setupClient('GET', {
				data: [
					{ id: 1, name: '/main', owner: 'alice', date: '2026-01-01', isMainBranch: true, headChangeset: 10, changesetsCount: 5 },
					{ id: 2, name: '/main/feature', owner: 'bob', date: '2026-01-02', comment: 'wip', isMainBranch: false },
				],
			});

			const branches = await backend.listBranches();
			expect(branches).toHaveLength(2);
			expect(branches[0]).toEqual({
				id: 1, name: '/main', owner: 'alice', date: '2026-01-01',
				comment: undefined, isMain: true, headChangeset: 10, changesetsCount: 5,
			});
			expect(branches[1].name).toBe('/main/feature');
			expect(branches[1].comment).toBe('wip');
			expect(branches[1].isMain).toBe(false);
		});

		it('throws on error', async () => {
			setupClient('GET', { error: new Error('forbidden') });
			await expect(backend.listBranches()).rejects.toThrow();
		});
	});

	describe('createBranch', () => {
		it('calls GET main-branch then POST branches', async () => {
			const client = setupMultiGet([
				{ data: { headChangeset: 99 } },
			]);
			client.POST.mockResolvedValue({
				data: { id: 5, name: '/main/new-branch', owner: 'alice', date: '2026-01-03' },
				error: null,
			});

			const result = await backend.createBranch('new-branch', 'my comment');
			expect(result.name).toBe('/main/new-branch');
			expect(result.id).toBe(5);
			expect(client.GET).toHaveBeenCalledOnce();
			expect(client.POST).toHaveBeenCalledOnce();
		});

		it('throws on POST error', async () => {
			const client = setupMultiGet([
				{ data: { headChangeset: 99 } },
			]);
			client.POST.mockResolvedValue({ data: null, error: new Error('conflict') });

			await expect(backend.createBranch('bad')).rejects.toThrow();
		});
	});

	describe('deleteBranch', () => {
		it('calls DELETE with branchId', async () => {
			const client = setupClient('DELETE', { data: null });

			await backend.deleteBranch(42);
			expect(client.DELETE).toHaveBeenCalledOnce();
		});

		it('throws on error', async () => {
			setupClient('DELETE', { error: new Error('not found') });
			await expect(backend.deleteBranch(999)).rejects.toThrow();
		});
	});

	describe('switchBranch', () => {
		it('calls POST update', async () => {
			const client = setupClient('POST', { data: null });

			await backend.switchBranch('/main/feature');
			expect(client.POST).toHaveBeenCalledOnce();
		});

		it('throws on error', async () => {
			setupClient('POST', { error: new Error('workspace locked') });
			await expect(backend.switchBranch('/main')).rejects.toThrow();
		});
	});
});
