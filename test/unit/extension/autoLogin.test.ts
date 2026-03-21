import { describe, it, expect, vi, beforeEach } from 'vitest';
import { window } from '../../mocks/vscode';

// Mock dependencies BEFORE importing the function under test

vi.mock('../../../src/util/plasticDetector', () => ({
	detectCachedToken: vi.fn(),
	detectWorkspace: vi.fn(),
	detectClientConfig: vi.fn(),
	hasPlasticWorkspace: vi.fn(),
}));

vi.mock('../../../src/api/auth', () => ({
	initAuth: vi.fn(),
	hasStoredCredentials: vi.fn(),
	createAuthMiddleware: vi.fn(),
	loginWithToken: vi.fn(),
	loginWithPAT: vi.fn(),
	logout: vi.fn(),
}));

vi.mock('../../../src/api/client', () => ({
	getClient: vi.fn(() => ({
		GET: vi.fn(),
		POST: vi.fn(),
		use: vi.fn(),
	})),
	getOrgName: vi.fn(() => 'test-org'),
	getOrgNameVariants: vi.fn(() => ['test-org']),
	setResolvedOrgName: vi.fn(),
	setOrgNameHints: vi.fn(),
	getWorkspaceGuid: vi.fn(),
	resetClient: vi.fn(),
}));

vi.mock('../../../src/util/config', () => ({
	isConfigured: vi.fn(),
	getConfig: vi.fn(() => ({ repositoryName: 'test-repo' })),
	initDetectedConfig: vi.fn(),
}));

vi.mock('../../../src/util/logger', () => ({
	log: vi.fn(),
	logError: vi.fn(),
}));

import { tryAutoLoginFromDesktopClient } from '../../../src/extension';
import { detectCachedToken } from '../../../src/util/plasticDetector';
import { loginWithPAT, loginWithToken, logout } from '../../../src/api/auth';
import { getClient, getOrgNameVariants } from '../../../src/api/client';

const mockDetectCachedToken = vi.mocked(detectCachedToken);
const mockLoginWithPAT = vi.mocked(loginWithPAT);
const mockLoginWithToken = vi.mocked(loginWithToken);
const mockLogout = vi.mocked(logout);
const mockGetClient = vi.mocked(getClient);
const mockGetOrgNameVariants = vi.mocked(getOrgNameVariants);

describe('tryAutoLoginFromDesktopClient', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetOrgNameVariants.mockReturnValue(['test-org']);
		mockGetClient.mockReturnValue({
			GET: vi.fn(),
			POST: vi.fn(),
			use: vi.fn(),
		} as any);
	});

	it('returns false when no cached token exists', async () => {
		mockDetectCachedToken.mockReturnValue(undefined);

		const result = await tryAutoLoginFromDesktopClient();

		expect(result).toBe(false);
		expect(mockLoginWithPAT).not.toHaveBeenCalled();
		expect(mockLoginWithToken).not.toHaveBeenCalled();
	});

	it('returns true when direct Bearer auth succeeds', async () => {
		mockDetectCachedToken.mockReturnValue({
			server: 'cloud',
			user: 'test@example.com',
			token: 'sso-jwt-token',
		});
		mockLoginWithPAT.mockResolvedValue(true);

		// validateCredentials succeeds — client.GET resolves
		const mockClient = {
			GET: vi.fn().mockResolvedValue({ data: [], error: null }),
			POST: vi.fn(),
			use: vi.fn(),
		};
		mockGetClient.mockReturnValue(mockClient as any);

		const result = await tryAutoLoginFromDesktopClient();

		expect(result).toBe(true);
		expect(mockLoginWithPAT).toHaveBeenCalledWith('sso-jwt-token');
		// Should NOT fall through to token exchange
		expect(mockLoginWithToken).not.toHaveBeenCalled();
		expect(window.showInformationMessage).toHaveBeenCalledWith(
			expect.stringContaining('test@example.com'),
		);
	});

	it('returns true when token exchange succeeds after Bearer fails', async () => {
		mockDetectCachedToken.mockReturnValue({
			server: 'cloud',
			user: 'test@example.com',
			token: 'sso-jwt-token',
		});
		mockLoginWithPAT.mockResolvedValue(true);

		// validateCredentials fails — client.GET rejects for all org variants
		const mockClient = {
			GET: vi.fn().mockRejectedValue(new Error('401 Unauthorized')),
			POST: vi.fn(),
			use: vi.fn(),
		};
		mockGetClient.mockReturnValue(mockClient as any);

		mockLogout.mockResolvedValue(undefined);
		mockLoginWithToken.mockResolvedValue(true);

		const result = await tryAutoLoginFromDesktopClient();

		expect(result).toBe(true);
		expect(mockLogout).toHaveBeenCalled();
		expect(mockLoginWithToken).toHaveBeenCalledWith('test@example.com', 'sso-jwt-token');
		expect(window.showInformationMessage).toHaveBeenCalledWith(
			expect.stringContaining('test@example.com'),
		);
	});

	it('returns false when both Bearer and token exchange fail', async () => {
		mockDetectCachedToken.mockReturnValue({
			server: 'cloud',
			user: 'test@example.com',
			token: 'sso-jwt-token',
		});
		mockLoginWithPAT.mockResolvedValue(true);

		// validateCredentials fails
		const mockClient = {
			GET: vi.fn().mockRejectedValue(new Error('401 Unauthorized')),
			POST: vi.fn(),
			use: vi.fn(),
		};
		mockGetClient.mockReturnValue(mockClient as any);

		mockLogout.mockResolvedValue(undefined);
		mockLoginWithToken.mockResolvedValue(false);

		const result = await tryAutoLoginFromDesktopClient();

		expect(result).toBe(false);
		expect(mockLogout).toHaveBeenCalled();
		expect(mockLoginWithToken).toHaveBeenCalledWith('test@example.com', 'sso-jwt-token');
	});

	it('returns false when loginWithPAT throws', async () => {
		mockDetectCachedToken.mockReturnValue({
			server: 'cloud',
			user: 'test@example.com',
			token: 'sso-jwt-token',
		});
		mockLoginWithPAT.mockRejectedValue(new Error('storage error'));

		const result = await tryAutoLoginFromDesktopClient();

		expect(result).toBe(false);
	});
});
