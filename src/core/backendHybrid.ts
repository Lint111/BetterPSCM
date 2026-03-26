import { log } from '../util/logger';
import type { PlasticBackend } from './backend';

/**
 * Set of methods routed to the CLI backend (workspace-level operations).
 * Everything else goes to the REST backend (repo-level operations).
 */
const HYBRID_CLI_METHODS = new Set<string>([
	'getStatus', 'getCurrentBranch', 'checkin', 'getFileContent',
	'switchBranch', 'updateWorkspace', 'undoCheckout', 'addToSourceControl', 'removeFromSourceControl',
	'getBaseRevisionContent', 'getBlame', 'getFileHistory',
	'resolveRevisionPaths', 'checkMergeAllowed', 'executeMerge',
]);

/** Methods where CLI is tried first, falling back to REST on failure. */
const HYBRID_CLI_FIRST_METHODS = new Set<string>([
	'getChangesetDiff', 'listChangesets',
]);

/**
 * Create a hybrid backend that routes workspace ops to CLI and repo ops to REST.
 *
 * Uses a Proxy to dynamically dispatch method calls — TypeScript can't statically
 * verify Proxy-based delegation, so we return PlasticBackend directly instead of
 * using `implements PlasticBackend` on a class that would produce false TS errors.
 */
export function createHybridBackend(cli: PlasticBackend, rest: PlasticBackend): PlasticBackend {
	log('Hybrid backend: CLI for workspace ops, REST for repo ops');

	const target = {
		name: 'Hybrid (CLI + REST)' as const,
		cli,
		rest,
	};

	return new Proxy(target, {
		get(t, prop: string) {
			if (prop === 'name') return t.name;

			// CLI-first methods: try CLI, fall back to REST on failure
			if (HYBRID_CLI_FIRST_METHODS.has(prop)) {
				const cliFn = (t.cli as any)[prop];
				const restFn = (t.rest as any)[prop];
				if (typeof cliFn === 'function' && typeof restFn === 'function') {
					return async (...args: any[]) => {
						try {
							const result = await cliFn.apply(t.cli, args);
							// Treat empty array as failure for diff/list methods
							if (Array.isArray(result) && result.length === 0) {
								log(`[Hybrid] ${prop} CLI returned empty, trying REST`);
								return restFn.apply(t.rest, args);
							}
							return result;
						} catch (err) {
							log(`[Hybrid] ${prop} CLI failed, trying REST: ${err instanceof Error ? err.message : err}`);
							return restFn.apply(t.rest, args);
						}
					};
				}
			}

			const backend = HYBRID_CLI_METHODS.has(prop) ? t.cli : t.rest;
			if (typeof (backend as any)[prop] === 'function') {
				return (backend as any)[prop].bind(backend);
			}
			return (backend as any)[prop];
		},
	}) as unknown as PlasticBackend;
}
