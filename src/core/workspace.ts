import { getBackend } from './backend';
import { TtlCache } from '../util/cache';
import type {
	StatusResult, CheckinResult, BranchInfo, ChangesetInfo, ChangesetDiffItem,
	UpdateResult, CodeReviewInfo, ReviewCommentInfo, ReviewerInfo,
	CreateReviewParams, CreateCommentParams, ReviewStatus,
	LabelInfo, CreateLabelParams, FileHistoryEntry, BlameLine,
	MergeReport, MergeResult,
	LockRuleInfo,
} from './types';

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
 * Undo checkout on specified files (reverts to server revision).
 */
export async function undoCheckout(paths: string[]): Promise<string[]> {
	return getBackend().undoCheckout(paths);
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

// ── Phase 4: Code Reviews ──────────────────────────────────────────

export async function listCodeReviews(filter?: 'all' | 'assignedToMe' | 'createdByMe' | 'pending'): Promise<CodeReviewInfo[]> {
	return getBackend().listCodeReviews(filter);
}

export async function getCodeReview(id: number): Promise<CodeReviewInfo> {
	return getBackend().getCodeReview(id);
}

export async function createCodeReview(params: CreateReviewParams): Promise<CodeReviewInfo> {
	return getBackend().createCodeReview(params);
}

export async function deleteCodeReview(id: number): Promise<void> {
	return getBackend().deleteCodeReview(id);
}

export async function updateCodeReviewStatus(id: number, status: ReviewStatus): Promise<void> {
	return getBackend().updateCodeReviewStatus(id, status);
}

export async function getReviewComments(reviewId: number): Promise<ReviewCommentInfo[]> {
	return getBackend().getReviewComments(reviewId);
}

export async function addReviewComment(params: CreateCommentParams): Promise<ReviewCommentInfo> {
	return getBackend().addReviewComment(params);
}

export async function getReviewers(reviewId: number): Promise<ReviewerInfo[]> {
	return getBackend().getReviewers(reviewId);
}

export async function addReviewers(reviewId: number, reviewers: string[]): Promise<void> {
	return getBackend().addReviewers(reviewId, reviewers);
}

export async function removeReviewer(reviewId: number, reviewer: string): Promise<void> {
	return getBackend().removeReviewer(reviewId, reviewer);
}

export async function updateReviewerStatus(reviewId: number, reviewer: string, status: ReviewStatus): Promise<void> {
	return getBackend().updateReviewerStatus(reviewId, reviewer, status);
}

// ── Phase 5: Labels, History, Merges ───────────────────────────────

export async function listLabels(): Promise<LabelInfo[]> {
	return getBackend().listLabels();
}

export async function createLabel(params: CreateLabelParams): Promise<LabelInfo> {
	return getBackend().createLabel(params);
}

export async function deleteLabel(id: number): Promise<void> {
	return getBackend().deleteLabel(id);
}

export async function getFileHistory(path: string): Promise<FileHistoryEntry[]> {
	return getBackend().getFileHistory(path);
}

export async function getBlame(path: string): Promise<BlameLine[]> {
	return getBackend().getBlame(path);
}

export async function checkMergeAllowed(sourceBranch: string, targetBranch: string): Promise<MergeReport> {
	return getBackend().checkMergeAllowed(sourceBranch, targetBranch);
}

export async function executeMerge(sourceBranch: string, targetBranch: string, comment?: string): Promise<MergeResult> {
	const result = await getBackend().executeMerge(sourceBranch, targetBranch, comment);
	branchCache.clear();
	branchListCache.clear();
	return result;
}

// ── Phase 5: Locks ─────────────────────────────────────────────────

export async function listLockRules(): Promise<LockRuleInfo[]> {
	return getBackend().listLockRules();
}

export async function createLockRule(rule: LockRuleInfo): Promise<LockRuleInfo> {
	return getBackend().createLockRule(rule);
}

export async function deleteLockRules(): Promise<void> {
	return getBackend().deleteLockRules();
}

export async function deleteLockRulesForRepo(): Promise<void> {
	return getBackend().deleteLockRulesForRepo();
}

export async function releaseLocks(itemIds: number[], mode: 'Delete' | 'Release'): Promise<void> {
	return getBackend().releaseLocks(itemIds, mode);
}

export async function resolveRevisionPaths(revisionIds: number[]): Promise<Map<number, string>> {
	return getBackend().resolveRevisionPaths(revisionIds);
}
