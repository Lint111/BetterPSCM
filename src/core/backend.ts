import { log } from '../util/logger';
import type {
	StatusResult, CheckinResult, BranchInfo, ChangesetInfo, ChangesetDiffItem,
	UpdateResult, CodeReviewInfo, ReviewCommentInfo, ReviewerInfo,
	CreateReviewParams, CreateCommentParams, ReviewStatus,
	LabelInfo, CreateLabelParams, FileHistoryEntry, BlameLine,
	MergeReport, MergeResult,
	LockRuleInfo, LockInfo,
} from './types';

/**
 * Contract for all workspace operations.
 * CLI and REST backends implement this interface.
 */
export interface PlasticBackend {
	readonly name: string;

	// ── Workspace status & checkin ───────────────────────────────────

	/** Retrieve pending workspace changes, optionally including private (untracked) files. */
	getStatus(showPrivate: boolean): Promise<StatusResult>;
	/** Return the current branch name, or undefined if it cannot be determined. */
	getCurrentBranch(): Promise<string | undefined>;
	/** Check in the given file paths with a commit comment. */
	checkin(paths: string[], comment: string): Promise<CheckinResult>;
	/** Fetch raw file content for a revision specifier (e.g. "revid:123" or "serverpath:/foo#cs:5"). */
	getFileContent(revSpec: string): Promise<Uint8Array | undefined>;

	// ── Branch operations ────────────────────────────────────────────

	/** List all branches in the repository. */
	listBranches(): Promise<BranchInfo[]>;
	/** Create a new branch from the current head. */
	createBranch(name: string, comment?: string): Promise<BranchInfo>;
	/** Delete a branch by its numeric ID. */
	deleteBranch(branchId: number): Promise<void>;
	/** Switch the workspace to a different branch. */
	switchBranch(branchName: string): Promise<void>;

	// ── Changeset history & workspace update ─────────────────────────

	/** List changesets, optionally filtered by branch and limited in count. */
	listChangesets(branchName?: string, limit?: number): Promise<ChangesetInfo[]>;
	/** Get the list of files changed between a changeset and its parent. */
	getChangesetDiff(changesetId: number, parentId: number): Promise<ChangesetDiffItem[]>;
	/** Update the workspace to the latest server state. */
	updateWorkspace(): Promise<UpdateResult>;

	// ── Code reviews ─────────────────────────────────────────────────

	/** List code reviews with an optional filter. */
	listCodeReviews(filter?: 'all' | 'assignedToMe' | 'createdByMe' | 'pending'): Promise<CodeReviewInfo[]>;
	/** Get a single code review by ID. */
	getCodeReview(id: number): Promise<CodeReviewInfo>;
	/** Create a new code review targeting a branch or changeset. */
	createCodeReview(params: CreateReviewParams): Promise<CodeReviewInfo>;
	/** Delete a code review by ID. */
	deleteCodeReview(id: number): Promise<void>;
	/** Update the overall status of a code review. */
	updateCodeReviewStatus(id: number, status: ReviewStatus): Promise<void>;
	/** Get all comments on a code review. */
	getReviewComments(reviewId: number): Promise<ReviewCommentInfo[]>;
	/** Add a comment to a code review. */
	addReviewComment(params: CreateCommentParams): Promise<ReviewCommentInfo>;
	/** Get the list of reviewers assigned to a code review. */
	getReviewers(reviewId: number): Promise<ReviewerInfo[]>;
	/** Assign reviewers to a code review. */
	addReviewers(reviewId: number, reviewers: string[]): Promise<void>;
	/** Remove a reviewer from a code review. */
	removeReviewer(reviewId: number, reviewer: string): Promise<void>;
	/** Update a specific reviewer's status on a code review. */
	updateReviewerStatus(reviewId: number, reviewer: string, status: ReviewStatus): Promise<void>;

	// ── Review comment resolution ────────────────────────────────────

	/** Resolve revision IDs to their file paths for positioning review comments. */
	resolveRevisionPaths(revisionIds: number[]): Promise<Map<number, string>>;

	// ── Labels ───────────────────────────────────────────────────────

	/** List all labels in the repository. */
	listLabels(): Promise<LabelInfo[]>;
	/** Create a label on a specific changeset. */
	createLabel(params: CreateLabelParams): Promise<LabelInfo>;
	/** Delete a label by ID. */
	deleteLabel(id: number): Promise<void>;

	// ── File history & annotate ──────────────────────────────────────

	/** Get the revision history for a single file. */
	getFileHistory(path: string): Promise<FileHistoryEntry[]>;
	/** Get per-line blame/annotate information for a file. */
	getBlame(path: string): Promise<BlameLine[]>;

	// ── Undo & source control ────────────────────────────────────────

	/** Revert checked-out files to their base revision. */
	undoCheckout(paths: string[]): Promise<string[]>;
	/** Add private (untracked) files to source control so they can be checked in. */
	addToSourceControl(paths: string[]): Promise<string[]>;
	/** Fetch the base (server) revision content of a file for backup purposes. */
	getBaseRevisionContent(path: string): Promise<Buffer | null>;

	// ── Merges ───────────────────────────────────────────────────────

	/** Preview a merge to check for conflicts without executing it. */
	checkMergeAllowed(sourceBranch: string, targetBranch: string): Promise<MergeReport>;
	/** Execute a merge from source to target branch. */
	executeMerge(sourceBranch: string, targetBranch: string, comment?: string): Promise<MergeResult>;

	// ── Locks ────────────────────────────────────────────────────────

	/** List all lock rules in the organization. */
	listLockRules(): Promise<LockRuleInfo[]>;
	/** Create a new lock rule. */
	createLockRule(rule: LockRuleInfo): Promise<LockRuleInfo>;
	/** Delete all lock rules in the organization. */
	deleteLockRules(): Promise<void>;
	/** Delete lock rules scoped to the current repository. */
	deleteLockRulesForRepo(): Promise<void>;
	/** Release or delete locks on specific items. */
	releaseLocks(itemIds: number[], mode: 'Delete' | 'Release'): Promise<void>;
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
