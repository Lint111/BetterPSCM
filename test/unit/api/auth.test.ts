import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock vscode SecretStorage
const mockSecretStorage = {
	get: vi.fn(),
	store: vi.fn(),
	delete: vi.fn(),
	onDidChange: vi.fn(),
};

// Mock the client module
vi.mock('../../../src/api/client', () => ({
	getClient: vi.fn(() => ({
		POST: vi.fn().mockResolvedValue({ data: { accessToken: 'new-at', refreshToken: 'new-rt' }, error: null }),
		use: vi.fn(),
	})),
	getOrgName: vi.fn(() => 'test-org'),
	resetClient: vi.fn(),
}));

import {
	initAuth,
	createAuthMiddleware,
	loginWithCredentials,
	loginWithPAT,
	loginWithCachedSsoToken,
	logout,
	hasStoredCredentials,
	getAccessToken,
} from '../../../src/api/auth';
import { getClient } from '../../../src/api/client';

describe('Auth', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Re-initialize auth to clear internal state (cached tokens)
		initAuth(mockSecretStorage as any);
	});

	describe('initAuth', () => {
		it('sets up secret storage for subsequent calls', async () => {
			mockSecretStorage.get.mockResolvedValue('stored-token');
			const token = await getAccessToken();
			expect(token).toBe('stored-token');
			expect(mockSecretStorage.get).toHaveBeenCalledWith('bpscm.accessToken');
		});
	});

	describe('loginWithPAT', () => {
		it('stores PAT as access token and attaches auth middleware', async () => {
			const result = await loginWithPAT('my-pat');
			expect(result).toBe(true);
			expect(mockSecretStorage.store).toHaveBeenCalledWith('bpscm.accessToken', 'my-pat');
		});
	});

	describe('loginWithCachedSsoToken', () => {
		it('stores SSO token as access token', async () => {
			const result = await loginWithCachedSsoToken('sso-token');
			expect(result).toBe(true);
			expect(mockSecretStorage.store).toHaveBeenCalledWith('bpscm.accessToken', 'sso-token');
		});
	});

	describe('logout', () => {
		it('clears cached tokens and secret storage', async () => {
			await loginWithPAT('my-pat');
			await logout();
			expect(mockSecretStorage.delete).toHaveBeenCalledWith('bpscm.accessToken');
			expect(mockSecretStorage.delete).toHaveBeenCalledWith('bpscm.refreshToken');
		});
	});

	describe('hasStoredCredentials', () => {
		it('returns true when access token exists', async () => {
			await loginWithPAT('my-pat');
			const result = await hasStoredCredentials();
			expect(result).toBe(true);
		});
	});

	describe('createAuthMiddleware', () => {
		it('attaches Bearer token to outgoing requests', async () => {
			await loginWithPAT('my-pat');
			const middleware = createAuthMiddleware();

			const mockRequest = {
				headers: new Map<string, string>(),
				set(key: string, value: string) { this.headers.set(key, value); },
			};
			// Simulate the Headers API
			const headers = new Headers();
			const request = { headers } as unknown as Request;
			const result = await middleware.onRequest!({ request } as any);

			expect((result as Request).headers.get('Authorization')).toBe('Bearer my-pat');
		});
	});

	describe('token refresh race condition', () => {
		it('concurrent 401 responses coalesce on a single refresh', async () => {
			// Setup: store a refresh token
			mockSecretStorage.get.mockImplementation(async (key: string) => {
				if (key === 'bpscm.refreshToken') return 'refresh-token';
				if (key === 'bpscm.accessToken') return 'expired-token';
				return undefined;
			});

			const postMock = vi.fn().mockResolvedValue({
				data: { accessToken: 'new-access', refreshToken: 'new-refresh' },
				error: null,
			});
			vi.mocked(getClient).mockReturnValue({
				POST: postMock,
				use: vi.fn(),
				GET: vi.fn(),
				DELETE: vi.fn(),
				PUT: vi.fn(),
			} as any);

			const middleware = createAuthMiddleware();

			// Simulate two concurrent 401 responses
			const make401Response = () => ({
				response: new Response(null, { status: 401 }),
				request: new Request('http://example.com', { headers: { Authorization: 'Bearer expired' } }),
			});

			const [result1, result2] = await Promise.all([
				middleware.onResponse!(make401Response() as any),
				middleware.onResponse!(make401Response() as any),
			]);

			// The refresh POST should only be called once (not twice)
			const refreshCalls = postMock.mock.calls.filter(
				(call: any[]) => call[0]?.includes?.('refresh') ||
					(typeof call[0] === 'string' && call[0].includes('refresh')),
			);
			// At most 1 actual refresh (both 401s should coalesce)
			expect(refreshCalls.length).toBeLessThanOrEqual(1);
		});
	});
});
