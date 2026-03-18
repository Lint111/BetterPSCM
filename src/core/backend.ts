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

	// Phase 3b — changeset history + workspace update
	listChangesets(branchName?: string, limit?: number): Promise<ChangesetInfo[]>;
	getChangesetDiff(changesetId: number, parentId: number): Promise<ChangesetDiffItem[]>;
	updateWorkspace(): Promise<UpdateResult>;

	// Phase 4 — code reviews
	listCodeReviews(filter?: 'all' | 'assignedToMe' | 'createdByMe' | 'pending'): Promise<CodeReviewInfo[]>;
	getCodeReview(id: number): Promise<CodeReviewInfo>;
	createCodeReview(params: CreateReviewParams): Promise<CodeReviewInfo>;
	deleteCodeReview(id: number): Promise<void>;
	updateCodeReviewStatus(id: number, status: ReviewStatus): Promise<void>;
	getReviewComments(reviewId: number): Promise<ReviewCommentInfo[]>;
	addReviewComment(params: CreateCommentParams): Promise<ReviewCommentInfo>;
	getReviewers(reviewId: number): Promise<ReviewerInfo[]>;
	addReviewers(reviewId: number, reviewers: string[]): Promise<void>;
	removeReviewer(reviewId: number, reviewer: string): Promise<void>;
	updateReviewerStatus(reviewId: number, reviewer: string, status: ReviewStatus): Promise<void>;

	// Phase 5 — labels
	listLabels(): Promise<LabelInfo[]>;
	createLabel(params: CreateLabelParams): Promise<LabelInfo>;
	deleteLabel(id: number): Promise<void>;

	// Phase 5 — file history + annotate
	getFileHistory(path: string): Promise<FileHistoryEntry[]>;
	getBlame(path: string): Promise<BlameLine[]>;

	// Phase 6 — undo checkout
	undoCheckout(paths: string[]): Promise<string[]>;

	// Phase 7 — add private files to source control
	addToSourceControl(paths: string[]): Promise<string[]>;

	// Phase 7 — get base revision content for backup
	getBaseRevisionContent(path: string): Promise<Buffer | null>;

	// Phase 5 — merges
	checkMergeAllowed(sourceBranch: string, targetBranch: string): Promise<MergeReport>;
	executeMerge(sourceBranch: string, targetBranch: string, comment?: string): Promise<MergeResult>;

	// Phase 5 — locks
	listLockRules(): Promise<LockRuleInfo[]>;
	createLockRule(rule: LockRuleInfo): Promise<LockRuleInfo>;
	deleteLockRules(): Promise<void>;
	deleteLockRulesForRepo(): Promise<void>;
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
