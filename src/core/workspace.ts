import { getBackend } from './backend';
import type { StatusResult, CheckinResult, BranchInfo, ChangesetInfo, ChangesetDiffItem } from './types';

// Re-export for consumers that import from workspace.ts
export type { StatusResult as WorkspaceStatusResult } from './types';

/**
 * Fetch the current workspace status (pending changes).
 */
export async function fetchWorkspaceStatus(showPrivateFiles: boolean): Promise<StatusResult> {
	return getBackend().getStatus(showPrivateFiles);
}

/**
 * Get the current branch name.
 */
export async function getCurrentBranch(): Promise<string | undefined> {
	return getBackend().getCurrentBranch();
}

/**
 * Check in specified files to the workspace.
 */
export async function checkinFiles(
	paths: string[],
	comment: string,
): Promise<CheckinResult> {
	return getBackend().checkin(paths, comment);
}

/**
 * Fetch file content for a specific revision (for diffs).
 */
export async function fetchFileContent(revSpec: string): Promise<Uint8Array | undefined> {
	return getBackend().getFileContent(revSpec);
}

/**
 * List all branches in the repository.
 */
export async function listBranches(): Promise<BranchInfo[]> {
	return getBackend().listBranches();
}

/**
 * Create a new branch.
 */
export async function createBranch(name: string, comment?: string): Promise<BranchInfo> {
	return getBackend().createBranch(name, comment);
}

/**
 * Delete a branch by ID.
 */
export async function deleteBranch(branchId: number): Promise<void> {
	return getBackend().deleteBranch(branchId);
}

/**
 * Switch the workspace to a different branch.
 */
export async function switchBranch(branchName: string): Promise<void> {
	return getBackend().switchBranch(branchName);
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
