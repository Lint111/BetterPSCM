import createClient, { type Middleware } from 'openapi-fetch';
import type { paths } from './generated/schema';
import { getConfig } from '../util/config';
import { log, logError } from '../util/logger';
import { PlasticApiError, AuthExpiredError, NotFoundError, ConflictError, ConnectionError } from './errors';

/** Default request timeout in milliseconds (30 seconds). */
const REQUEST_TIMEOUT_MS = 30_000;

export type PlasticClient = ReturnType<typeof createClient<paths>>;

let clientInstance: PlasticClient | undefined;
let currentBaseUrl = '';

/**
 * Timeout middleware that aborts requests exceeding REQUEST_TIMEOUT_MS.
 */
const timeoutMiddleware: Middleware = {
	async onRequest({ request }) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

		// Chain abort signals: if caller provided one, respect it
		const original = request.signal;
		if (original) {
			original.addEventListener('abort', () => controller.abort());
		}

		// Store timer on request for cleanup in onResponse
		(request as any).__timeoutTimer = timer;

		return new Request(request, { signal: controller.signal });
	},
	async onResponse({ request, response }) {
		clearTimeout((request as any).__timeoutTimer);
		return response;
	},
};

/**
 * Error-handling middleware that converts HTTP errors into typed exceptions.
 */
const errorMiddleware: Middleware = {
	async onResponse({ response }) {
		if (response.ok) return response;

		let message = response.statusText;
		let keyMessage: string | undefined;

		try {
			const body = await response.clone().json();
			if (body?.error?.message) message = body.error.message;
			if (body?.keyMessage) keyMessage = body.keyMessage;
			if (body?.message) message = body.message;
		} catch {
			// Body may not be JSON
		}

		const url = response.url;
		const status = response.status;
		// Log error context (message only — never log full response body which may contain tokens)
		logError(`API ${status} ${url}`, new Error(message));

		switch (status) {
			case 401:
				throw new AuthExpiredError(message);
			case 404:
				throw new NotFoundError(message);
			case 409:
				throw new ConflictError(message);
			default:
				throw new PlasticApiError(message, status, keyMessage);
		}
	},
};

/**
 * Get or create the openapi-fetch client for the Plastic SCM REST API.
 * Recreates the client if the server URL has changed.
 */
export function getClient(): PlasticClient {
	const config = getConfig();
	const baseUrl = config.serverUrl;

	if (!baseUrl) {
		throw new Error('Plastic SCM server URL is not configured. Set bpscm.serverUrl in settings.');
	}

	if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
		throw new Error(`Invalid server URL "${baseUrl}". Must start with http:// or https://`);
	}

	if (clientInstance && currentBaseUrl === baseUrl) {
		return clientInstance;
	}

	log(`Creating API client for ${baseUrl}`);
	currentBaseUrl = baseUrl;
	clientInstance = createClient<paths>({ baseUrl });
	clientInstance.use(timeoutMiddleware);
	clientInstance.use(errorMiddleware);

	return clientInstance;
}

/**
 * Reset the client (e.g., on logout or config change).
 */
export function resetClient(): void {
	clientInstance = undefined;
	currentBaseUrl = '';
	resolvedOrgName = undefined;
}

/**
 * Cached resolved org name — set once a variant succeeds against the API.
 */
let resolvedOrgName: string | undefined;

/**
 * Extra org name variants discovered from workspace detection.
 */
let orgNameHints: string[] = [];

/**
 * Get the organization name from settings (or the resolved variant if known).
 */
export function getOrgName(): string {
	if (resolvedOrgName) return resolvedOrgName;
	const org = getConfig().organizationName;
	if (!org) {
		throw new Error('Organization name is not configured. Set bpscm.organizationName in settings.');
	}
	return org;
}

/**
 * Generate org name variants to try during login.
 * The REST API may expect a different format than what unityorgs.conf provides.
 * Tries: configured slug, numeric server ID, display name (spaces replaced with hyphens).
 */
export function getOrgNameVariants(): string[] {
	const org = getConfig().organizationName;
	if (!org) {
		throw new Error('Organization name is not configured. Set bpscm.organizationName in settings.');
	}
	const seen = new Set<string>();
	const variants: string[] = [];
	const add = (v: string) => {
		if (v && !seen.has(v)) { seen.add(v); variants.push(v); }
	};
	// Previously resolved org name gets highest priority
	if (resolvedOrgName) add(resolvedOrgName);
	// Hints from workspace detection (numeric server ID first — most reliable)
	for (const hint of orgNameHints) add(hint);
	// Fallback: configured slug (e.g., "head-first-studios-bv")
	add(org);
	return variants;
}

/**
 * Set extra org name hints from workspace detection.
 * Called during auto-detect with cloudServerId and displayOrgName.
 */
export function setOrgNameHints(hints: string[]): void {
	orgNameHints = hints.filter(h => !!h);
}

/**
 * Set the resolved org name after a successful API call.
 */
export function setResolvedOrgName(name: string): void {
	resolvedOrgName = name;
}

/**
 * Get the repository name from settings.
 */
export function getRepoName(): string {
	const repo = getConfig().repositoryName;
	if (!repo) {
		throw new Error('Repository name is not configured. Set bpscm.repositoryName in settings.');
	}
	return repo;
}

/**
 * Get the workspace GUID from settings.
 */
export function getWorkspaceGuid(): string {
	const guid = getConfig().workspaceGuid;
	if (!guid) {
		throw new Error('Workspace GUID is not configured. Set bpscm.workspaceGuid in settings.');
	}
	return guid;
}
