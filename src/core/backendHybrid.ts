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
				const backend = HYBRID_CLI_METHODS.has(prop) ? target.cli : target.rest;
				if (typeof (backend as any)[prop] === 'function') {
					return (backend as any)[prop].bind(backend);
				}
				return (backend as any)[prop];
			},
		}) as HybridBackend;
	}
}
