import { log } from '../util/logger';
import type { PlasticBackend } from './backend';

/**
 * Set of methods routed to the CLI backend (workspace-level operations).
 * Everything else goes to the REST backend (repo-level operations).
 */
const HYBRID_CLI_METHODS = new Set<string>([
	'getStatus', 'getCurrentBranch', 'checkin', 'getFileContent',
	'switchBranch', 'updateWorkspace', 'undoCheckout', 'addToSourceControl',
	'getBaseRevisionContent', 'getBlame', 'getFileHistory',
	'resolveRevisionPaths', 'checkMergeAllowed', 'executeMerge',
]);

/** Methods where CLI is tried first, falling back to REST on failure. */
const HYBRID_CLI_FIRST_METHODS = new Set<string>([
	'getChangesetDiff', 'listChangesets',
]);

/**
 * Hybrid backend using Proxy — routes workspace ops to CLI, repo ops to REST.
 *
 * Locally-created Plastic SCM workspaces are NOT registered in the cloud API,
 * so workspace GUID-based REST endpoints return 404. The CLI handles workspace
 * operations via the local cm executable, while REST handles repo-level operations.
 */
export class HybridBackend implements PlasticBackend {
	readonly name = 'Hybrid (CLI + REST)';

	constructor(
		private readonly cli: PlasticBackend,
		private readonly rest: PlasticBackend,
	) {
		log('Hybrid backend: CLI for workspace ops, REST for repo ops');

		return new Proxy(this, {
			get(target, prop: string) {
				if (prop === 'name') return target.name;
				if (prop === 'cli' || prop === 'rest') return target[prop as 'cli' | 'rest'];

				// CLI-first methods: try CLI, fall back to REST on failure
				if (HYBRID_CLI_FIRST_METHODS.has(prop)) {
					const cliFn = (target.cli as any)[prop];
					const restFn = (target.rest as any)[prop];
					if (typeof cliFn === 'function' && typeof restFn === 'function') {
						return async (...args: any[]) => {
							try {
								const result = await cliFn.apply(target.cli, args);
								// Treat empty array as failure for diff/list methods
								if (Array.isArray(result) && result.length === 0) {
									log(`[Hybrid] ${prop} CLI returned empty, trying REST`);
									return restFn.apply(target.rest, args);
								}
								return result;
							} catch (err) {
								log(`[Hybrid] ${prop} CLI failed, trying REST: ${err instanceof Error ? err.message : err}`);
								return restFn.apply(target.rest, args);
							}
						};
					}
				}

				const backend = HYBRID_CLI_METHODS.has(prop) ? target.cli : target.rest;
				if (typeof (backend as any)[prop] === 'function') {
					return (backend as any)[prop].bind(backend);
				}
				return (backend as any)[prop];
			},
		}) as HybridBackend;
	}
}
