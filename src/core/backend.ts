import { log } from '../util/logger';
import type { StatusResult, CheckinResult, BranchInfo, ChangesetInfo } from './types';

/**
 * Contract for all workspace operations.
 * CLI and REST backends implement this interface.
 */
export interface PlasticBackend {
	readonly name: string;

	// Phase 1
	getStatus(showPrivate: boolean): Promise<StatusResult>;
	getCurrentBranch(): Promise<string | undefined>;
	checkin(paths: string[], comment: string): Promise<CheckinResult>;
	getFileContent(revSpec: string): Promise<Uint8Array | undefined>;

	// Phase 3a — branch operations
	listBranches(): Promise<BranchInfo[]>;
	createBranch(name: string, comment?: string): Promise<BranchInfo>;
	deleteBranch(branchId: number): Promise<void>;
	switchBranch(branchName: string): Promise<void>;

	// Phase 3b — changeset history
	listChangesets(branchName?: string, limit?: number): Promise<ChangesetInfo[]>;
}

let activeBackend: PlasticBackend | undefined;

/**
 * Get the active backend. Throws if none configured.
 */
export function getBackend(): PlasticBackend {
	if (!activeBackend) {
		throw new Error('No Plastic SCM backend configured');
	}
	return activeBackend;
}

/**
 * Set the active backend instance.
 */
export function setBackend(backend: PlasticBackend): void {
	log(`Backend set to: ${backend.name}`);
	activeBackend = backend;
}

/**
 * Check if any backend is configured.
 */
export function hasBackend(): boolean {
	return !!activeBackend;
}

export { NotSupportedError } from './types';
