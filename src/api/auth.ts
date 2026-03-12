import * as vscode from 'vscode';
import type { Middleware } from 'openapi-fetch';
import { getClient, getOrgName, resetClient } from './client';
import { AuthExpiredError } from './errors';
import { log, logError } from '../util/logger';

const SECRET_ACCESS_TOKEN = 'plasticScm.accessToken';
const SECRET_REFRESH_TOKEN = 'plasticScm.refreshToken';

let secretStorage: vscode.SecretStorage | undefined;
let cachedAccessToken: string | undefined;
let cachedRefreshToken: string | undefined;
let isRefreshing = false;

/**
 * Initialize auth with the extension's secret storage.
 */
export function initAuth(secrets: vscode.SecretStorage): void {
	secretStorage = secrets;
}

/**
 * Auth middleware that attaches the Bearer token and handles refresh on 401.
 */
export function createAuthMiddleware(): Middleware {
	return {
		async onRequest({ request }) {
			const token = await getAccessToken();
			if (token) {
				request.headers.set('Authorization', `Bearer ${token}`);
			}
			return request;
		},
		async onResponse({ response, request }) {
			if (response.status !== 401 || isRefreshing) return response;

			// Attempt silent refresh
			const refreshed = await tryRefreshToken();
			if (!refreshed) return response;

			// Retry original request with new token
			const newToken = await getAccessToken();
			if (newToken) {
				request.headers.set('Authorization', `Bearer ${newToken}`);
			}
			return fetch(request);
		},
	};
}

/**
 * Sign in with username/password. Stores tokens in SecretStorage.
 */
export async function loginWithCredentials(username: string, password: string): Promise<boolean> {
	try {
		const client = getClient();
		const orgName = getOrgName();

		const { data, error } = await client.POST('/api/v1/organizations/{orgName}/login', {
			params: { path: { orgName } },
			body: { user: username, password },
		});

		if (error || !data) {
			logError('Login failed', error);
			return false;
		}

		await storeTokens(data.accessToken, data.refreshToken);
		log('Login successful');

		// Add auth middleware to client
		client.use(createAuthMiddleware());

		return true;
	} catch (err) {
		logError('Login error', err);
		return false;
	}
}

/**
 * Sign in with a token (SSO/token-based auth).
 */
export async function loginWithToken(email: string, authToken: string): Promise<boolean> {
	try {
		const client = getClient();
		const orgName = getOrgName();

		const { data, error } = await client.POST('/api/v1/organizations/{orgName}/login/verify', {
			params: { path: { orgName } },
			body: { email, authToken },
		});

		if (error || !data) {
			logError('Token login failed', error);
			return false;
		}

		await storeTokens(data.accessToken, data.refreshToken);
		log('Token login successful');

		client.use(createAuthMiddleware());
		return true;
	} catch (err) {
		logError('Token login error', err);
		return false;
	}
}

/**
 * Sign in with a Personal Access Token (PAT).
 * PATs are used directly as Bearer tokens without the login flow.
 */
export async function loginWithPAT(pat: string): Promise<boolean> {
	await storeTokens(pat, undefined);
	log('PAT authentication configured');

	const client = getClient();
	client.use(createAuthMiddleware());
	return true;
}

/**
 * Sign in using a cached Unity SSO token from the Plastic desktop client.
 * The token is used directly as a Bearer token (same as PAT).
 */
export async function loginWithCachedSsoToken(token: string): Promise<boolean> {
	await storeTokens(token, undefined);
	log('Cached Unity SSO token configured');

	const client = getClient();
	client.use(createAuthMiddleware());
	return true;
}

/**
 * Sign out and clear stored tokens.
 */
export async function logout(): Promise<void> {
	cachedAccessToken = undefined;
	cachedRefreshToken = undefined;
	if (secretStorage) {
		await secretStorage.delete(SECRET_ACCESS_TOKEN);
		await secretStorage.delete(SECRET_REFRESH_TOKEN);
	}
	resetClient();
	log('Logged out');
}

/**
 * Check if we have stored credentials.
 */
export async function hasStoredCredentials(): Promise<boolean> {
	const token = await getAccessToken();
	return !!token;
}

/**
 * Get the current access token.
 */
export async function getAccessToken(): Promise<string | undefined> {
	if (cachedAccessToken) return cachedAccessToken;
	if (!secretStorage) return undefined;
	cachedAccessToken = await secretStorage.get(SECRET_ACCESS_TOKEN);
	return cachedAccessToken;
}

async function tryRefreshToken(): Promise<boolean> {
	if (isRefreshing) return false;
	isRefreshing = true;

	try {
		if (!cachedRefreshToken && secretStorage) {
			cachedRefreshToken = await secretStorage.get(SECRET_REFRESH_TOKEN);
		}

		if (!cachedRefreshToken) {
			log('No refresh token available');
			return false;
		}

		const client = getClient();
		const orgName = getOrgName();

		const { data, error } = await client.POST('/api/v1/organizations/{orgName}/login/refresh', {
			params: { path: { orgName } },
			body: { refreshToken: cachedRefreshToken },
		});

		if (error || !data) {
			logError('Token refresh failed', error);
			await logout();
			return false;
		}

		await storeTokens(data.accessToken, data.refreshToken);
		log('Token refreshed');
		return true;
	} catch (err) {
		logError('Token refresh error', err);
		return false;
	} finally {
		isRefreshing = false;
	}
}

async function storeTokens(accessToken?: string, refreshToken?: string): Promise<void> {
	if (!secretStorage) return;

	if (accessToken) {
		cachedAccessToken = accessToken;
		await secretStorage.store(SECRET_ACCESS_TOKEN, accessToken);
	}

	if (refreshToken) {
		cachedRefreshToken = refreshToken;
		await secretStorage.store(SECRET_REFRESH_TOKEN, refreshToken);
	}
}
