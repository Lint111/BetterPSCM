import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/util/config', () => ({
	getConfig: vi.fn(() => ({
		serverUrl: 'https://cloud.plasticscm.com',
		organizationName: 'test-org',
		repositoryName: 'test-repo',
		workspaceGuid: 'test-guid',
	})),
}));

import { getClient, resetClient, getOrgName, getRepoName, getWorkspaceGuid } from '../../../src/api/client';
import { getConfig } from '../../../src/util/config';

describe('client', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetClient();
		// Restore default config mock
		vi.mocked(getConfig).mockReturnValue({
			serverUrl: 'https://cloud.plasticscm.com',
			organizationName: 'test-org',
			repositoryName: 'test-repo',
			workspaceGuid: 'test-guid',
		} as any);
	});

	describe('getClient', () => {
		it('creates a client with the configured base URL', () => {
			const client = getClient();
			expect(client).toBeDefined();
			expect(client.GET).toBeDefined();
			expect(client.POST).toBeDefined();
		});

		it('reuses the same client for the same URL', () => {
			const c1 = getClient();
			const c2 = getClient();
			expect(c1).toBe(c2);
		});

		it('throws when server URL is not configured', () => {
			vi.mocked(getConfig).mockReturnValue({
				serverUrl: '',
				organizationName: 'org',
				repositoryName: 'repo',
				workspaceGuid: 'guid',
			} as any);

			expect(() => getClient()).toThrow('server URL is not configured');
		});

		it('throws on invalid server URL scheme', () => {
			vi.mocked(getConfig).mockReturnValue({
				serverUrl: 'ftp://example.com',
				organizationName: 'org',
				repositoryName: 'repo',
				workspaceGuid: 'guid',
			} as any);

			expect(() => getClient()).toThrow('Must start with http');
		});

		it('recreates client when URL changes', () => {
			const c1 = getClient();
			// Change URL without resetting — client should detect URL mismatch
			vi.mocked(getConfig).mockReturnValue({
				serverUrl: 'https://other.server.com',
				organizationName: 'test-org',
				repositoryName: 'test-repo',
				workspaceGuid: 'test-guid',
			} as any);
			const c2 = getClient();
			expect(c1).not.toBe(c2);
		});
	});

	describe('getOrgName', () => {
		it('returns org name from config', () => {
			expect(getOrgName()).toBe('test-org');
		});

		it('throws when org is empty', () => {
			vi.mocked(getConfig).mockReturnValue({
				serverUrl: 'https://x.com',
				organizationName: '',
			} as any);
			expect(() => getOrgName()).toThrow('Organization name is not configured');
		});
	});

	describe('getRepoName', () => {
		it('returns repo name from config', () => {
			expect(getRepoName()).toBe('test-repo');
		});

		it('throws when repo is empty', () => {
			vi.mocked(getConfig).mockReturnValue({
				serverUrl: 'https://x.com',
				repositoryName: '',
			} as any);
			expect(() => getRepoName()).toThrow('Repository name is not configured');
		});
	});

	describe('getWorkspaceGuid', () => {
		it('returns workspace GUID from config', () => {
			expect(getWorkspaceGuid()).toBe('test-guid');
		});

		it('throws when GUID is empty', () => {
			vi.mocked(getConfig).mockReturnValue({
				serverUrl: 'https://x.com',
				workspaceGuid: '',
			} as any);
			expect(() => getWorkspaceGuid()).toThrow('Workspace GUID is not configured');
		});
	});
});
