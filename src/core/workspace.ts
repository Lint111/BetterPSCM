import { getBackend } from './backend';
import { TtlCache } from '../util/cache';
import type { StatusResult, CheckinResult, BranchInfo, ChangesetInfo, ChangesetDiffItem, UpdateResult } from './types';

// Re-export for consumers that import from workspace.ts
export type { StatusResult as WorkspaceStatusResult } from './types';

/** Short-lived cache for data that changes occasionally */
const branchCache = new TtlCache<string, string | undefined>(20_000);	// 20s
const branchListCache = new TtlCache<string, BranchInfo[]>(20_000);		// 20s

/**
 * Fetch the current workspace status (pending changes).
 * Not cached — changes frequently and the poller needs fresh data.
 */
export async function fetchWorkspaceStatus(showPrivateFiles: boolean): Promise<StatusResult> {
	return getBackend().getStatus(showPrivateFiles);
}

/**
 * Get the current branch name. Cached for 20s.
 */
export async function getCurrentBranch(): Promise<string | undefined> {
	if (branchCache.has('current')) return branchCache.get('current');
	const branch = await getBackend().getCurrentBranch();
	branchCache.set('current', branch);
	return branch;
}

/**
 * Check in specified files to the workspace.
 */
export async function checkinFiles(
	paths: string[],
	comment: string,
): Promise<CheckinResult> {
	const result = await getBackend().checkin(paths, comment);
	branchCache.clear();
	return result;
}

/**
 * Fetch file content for a specific revision (for diffs).
 */
export async function fetchFileContent(revSpec: string): Promise<Uint8Array | undefined> {
	return getBackend().getFileContent(revSpec);
}

/**
 * List all branches in the repository. Cached for 20s.
 */
export async function listBranches(): Promise<BranchInfo[]> {
	const cached = branchListCache.get('all');
	if (cached) return cached;
	const branches = await getBackend().listBranches();
	branchListCache.set('all', branches);
	return branches;
}

/**
 * Create a new branch. Invalidates branch caches.
 */
export async function createBranch(name: string, comment?: string): Promise<BranchInfo> {
	const result = await getBackend().createBranch(name, comment);
	branchListCache.clear();
	return result;
}

/**
 * Delete a branch by ID. Invalidates branch caches.
 */
export async function deleteBranch(branchId: number): Promise<void> {
	await getBackend().deleteBranch(branchId);
	branchListCache.clear();
}

/**
 * Switch the workspace to a different branch. Invalidates branch caches.
 */
export async function switchBranch(branchName: string): Promise<void> {
	await getBackend().switchBranch(branchName);
	branchCache.clear();
	branchListCache.clear();
}

/**
 * Update workspace to latest. Invalidates all caches.
 */
export async function updateWorkspace(): Promise<UpdateResult> {
	const result = await getBackend().updateWorkspace();
	branchCache.clear();
	branchListCache.clear();
	return result;
}

/**
 * List changesets, optionally filtered by branch.
 */
export async function listChangesets(branchName?: string, limit?: number): Promise<ChangesetInfo[]> {
	return getBackend().listChangesets(branchName, limit);
}

/**
 * Get files changed in a specific changeset.
 */
export async function getChangesetDiff(changesetId: number, parentId: number): Promise<ChangesetDiffItem[]> {
	return getBackend().getChangesetDiff(changesetId, parentId);
}
