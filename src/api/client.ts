import createClient, { type Middleware } from 'openapi-fetch';
import type { paths } from './generated/schema';
import { getConfig } from '../util/config';
import { log, logError } from '../util/logger';
import { PlasticApiError, AuthExpiredError, NotFoundError, ConflictError, ConnectionError } from './errors';

export type PlasticClient = ReturnType<typeof createClient<paths>>;

let clientInstance: PlasticClient | undefined;
let currentBaseUrl = '';

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

		switch (response.status) {
			case 401:
				throw new AuthExpiredError(message);
			case 404:
				throw new NotFoundError(message);
			case 409:
				throw new ConflictError(message);
			default:
				throw new PlasticApiError(message, response.status, keyMessage);
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
		throw new Error('Plastic SCM server URL is not configured. Set plasticScm.serverUrl in settings.');
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
	clientInstance.use(errorMiddleware);

	return clientInstance;
}

/**
 * Reset the client (e.g., on logout or config change).
 */
export function resetClient(): void {
	clientInstance = undefined;
	currentBaseUrl = '';
}

/**
 * Get the organization name from settings.
 */
export function getOrgName(): string {
	const org = getConfig().organizationName;
	if (!org) {
		throw new Error('Organization name is not configured. Set plasticScm.organizationName in settings.');
	}
	return org;
}

/**
 * Get the repository name from settings.
 */
export function getRepoName(): string {
	const repo = getConfig().repositoryName;
	if (!repo) {
		throw new Error('Repository name is not configured. Set plasticScm.repositoryName in settings.');
	}
	return repo;
}

/**
 * Get the workspace GUID from settings.
 */
export function getWorkspaceGuid(): string {
	const guid = getConfig().workspaceGuid;
	if (!guid) {
		throw new Error('Workspace GUID is not configured. Set plasticScm.workspaceGuid in settings.');
	}
	return guid;
}
