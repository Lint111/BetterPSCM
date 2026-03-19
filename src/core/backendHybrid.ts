import { log } from '../util/logger';
import type { PlasticBackend } from './backend';
import type {
	StatusResult, CheckinResult, BranchInfo, ChangesetInfo,
	ChangesetDiffItem, UpdateResult, CodeReviewInfo, ReviewCommentInfo,
	ReviewerInfo, CreateReviewParams, CreateCommentParams, ReviewStatus,
	LabelInfo, CreateLabelParams, FileHistoryEntry, BlameLine,
	MergeReport, MergeResult,
	LockRuleInfo,
} from './types';
import { NotSupportedError } from './types';

/**
 * Hybrid backend that delegates workspace-level operations to the CLI backend
 * and repo-level operations to the REST backend.
 *
 * This is needed because locally-created Plastic SCM workspaces are NOT registered
 * in the cloud API — workspace GUID-based REST endpoints return 404, while
 * repo-level REST endpoints (branches, changesets, code reviews, labels, locks) work fine.
 *
 * The CLI handles workspace operations (status, branch, checkin, file content, update)
 * perfectly via the local cm executable.
 */
export class HybridBackend implements PlasticBackend {
	readonly name = 'Hybrid (CLI + REST)';

	constructor(
		private readonly cli: PlasticBackend,
		private readonly rest: PlasticBackend,
	) {
		log('Hybrid backend: CLI for workspace ops, REST for repo ops');
	}

	// ── Workspace-level ops → CLI ──────────────────────────────────

	getStatus(showPrivate: boolean): Promise<StatusResult> {
		return this.cli.getStatus(showPrivate);
	}

	getCurrentBranch(): Promise<string | undefined> {
		return this.cli.getCurrentBranch();
	}

	checkin(paths: string[], comment: string): Promise<CheckinResult> {
		return this.cli.checkin(paths, comment);
	}

	getFileContent(revSpec: string): Promise<Uint8Array | undefined> {
		return this.cli.getFileContent(revSpec);
	}

	switchBranch(branchName: string): Promise<void> {
		return this.cli.switchBranch(branchName);
	}

	updateWorkspace(): Promise<UpdateResult> {
		return this.cli.updateWorkspace();
	}

	undoCheckout(paths: string[]): Promise<string[]> {
		return this.cli.undoCheckout(paths);
	}

	addToSourceControl(paths: string[]): Promise<string[]> {
		return this.cli.addToSourceControl(paths);
	}

	getBaseRevisionContent(path: string): Promise<Buffer | null> {
		return this.cli.getBaseRevisionContent(path);
	}

	getBlame(path: string): Promise<BlameLine[]> {
		return this.cli.getBlame(path);
	}

	getFileHistory(path: string): Promise<FileHistoryEntry[]> {
		return this.cli.getFileHistory(path);
	}

	resolveRevisionPaths(revisionIds: number[]): Promise<Map<number, string>> {
		return this.cli.resolveRevisionPaths(revisionIds);
	}

	// Merges go through CLI (workspace-level operation)
	checkMergeAllowed(sourceBranch: string, targetBranch: string): Promise<MergeReport> {
		return this.cli.checkMergeAllowed(sourceBranch, targetBranch);
	}

	executeMerge(sourceBranch: string, targetBranch: string, comment?: string): Promise<MergeResult> {
		return this.cli.executeMerge(sourceBranch, targetBranch, comment);
	}

	// ── Repo-level ops → REST ──────────────────────────────────────

	listBranches(): Promise<BranchInfo[]> {
		return this.rest.listBranches();
	}

	createBranch(name: string, comment?: string): Promise<BranchInfo> {
		return this.rest.createBranch(name, comment);
	}

	deleteBranch(branchId: number): Promise<void> {
		return this.rest.deleteBranch(branchId);
	}

	listChangesets(branchName?: string, limit?: number): Promise<ChangesetInfo[]> {
		return this.rest.listChangesets(branchName, limit);
	}

	getChangesetDiff(changesetId: number, parentId: number): Promise<ChangesetDiffItem[]> {
		return this.rest.getChangesetDiff(changesetId, parentId);
	}

	// ── Code reviews → REST ────────────────────────────────────────

	listCodeReviews(filter?: 'all' | 'assignedToMe' | 'createdByMe' | 'pending'): Promise<CodeReviewInfo[]> {
		return this.rest.listCodeReviews(filter);
	}

	getCodeReview(id: number): Promise<CodeReviewInfo> {
		return this.rest.getCodeReview(id);
	}

	createCodeReview(params: CreateReviewParams): Promise<CodeReviewInfo> {
		return this.rest.createCodeReview(params);
	}

	deleteCodeReview(id: number): Promise<void> {
		return this.rest.deleteCodeReview(id);
	}

	updateCodeReviewStatus(id: number, status: ReviewStatus): Promise<void> {
		return this.rest.updateCodeReviewStatus(id, status);
	}

	getReviewComments(reviewId: number): Promise<ReviewCommentInfo[]> {
		return this.rest.getReviewComments(reviewId);
	}

	addReviewComment(params: CreateCommentParams): Promise<ReviewCommentInfo> {
		return this.rest.addReviewComment(params);
	}

	getReviewers(reviewId: number): Promise<ReviewerInfo[]> {
		return this.rest.getReviewers(reviewId);
	}

	addReviewers(reviewId: number, reviewers: string[]): Promise<void> {
		return this.rest.addReviewers(reviewId, reviewers);
	}

	removeReviewer(reviewId: number, reviewer: string): Promise<void> {
		return this.rest.removeReviewer(reviewId, reviewer);
	}

	updateReviewerStatus(reviewId: number, reviewer: string, status: ReviewStatus): Promise<void> {
		return this.rest.updateReviewerStatus(reviewId, reviewer, status);
	}

	// ── Labels → REST ──────────────────────────────────────────────

	listLabels(): Promise<LabelInfo[]> {
		return this.rest.listLabels();
	}

	createLabel(params: CreateLabelParams): Promise<LabelInfo> {
		return this.rest.createLabel(params);
	}

	deleteLabel(id: number): Promise<void> {
		return this.rest.deleteLabel(id);
	}

	// ── Locks → REST ───────────────────────────────────────────────

	listLockRules(): Promise<LockRuleInfo[]> {
		return this.rest.listLockRules();
	}

	createLockRule(rule: LockRuleInfo): Promise<LockRuleInfo> {
		return this.rest.createLockRule(rule);
	}

	deleteLockRules(): Promise<void> {
		return this.rest.deleteLockRules();
	}

	deleteLockRulesForRepo(): Promise<void> {
		return this.rest.deleteLockRulesForRepo();
	}

	releaseLocks(itemIds: number[], mode: 'Delete' | 'Release'): Promise<void> {
		return this.rest.releaseLocks(itemIds, mode);
	}
}
