import type { components } from '../api/generated/schema';

// Re-export schema types with shorter names for convenience
export type StatusResponse = components['schemas']['StatusResponse'];
export type StatusChange = components['schemas']['StatusResponse.Change'];
export type StatusChangeType = components['schemas']['StatusChangeType'];
export type WorkspaceResponse = components['schemas']['WorkspaceResponse'];
export type WorkspacesResponse = components['schemas']['WorkspacesResponse'];
export type WorkspaceVersionResponse = components['schemas']['WorkspaceVersionResponse'];
export type BranchModel = components['schemas']['BranchModel'];
export type ChangesetModel = components['schemas']['ChangesetModel'];
export type CheckInRequest = components['schemas']['CheckInRequest'];
export type CheckinResponseModel = components['schemas']['CheckinResponseModel'];
export type LoginRequest = components['schemas']['LoginRequest'];
export type LoginResponse = components['schemas']['LoginResponse'];
export type TreeResponse = components['schemas']['TreeResponse'];
export type TreeEntry = components['schemas']['TreeResponse.TreeEntry'];
export type LabelModel = components['schemas']['LabelModel'];
export type DiffModel = components['schemas']['DiffModel'];
export type CodeReviewModel = components['schemas']['CodeReviewModel'];
export type HistoryModel = components['schemas']['HistoryModel'];
export type DataType = components['schemas']['DataType'];

/**
 * Normalized workspace change with guaranteed non-null fields.
 */
export interface NormalizedChange {
	path: string;
	changeType: StatusChangeType;
	dataType: 'Directory' | 'File';
	sourcePath?: string;
	revisionGuid?: string;
	oldRevisionId?: number;
}

/**
 * Normalize a raw StatusResponse.Change into a NormalizedChange.
 */
export function normalizeChange(change: StatusChange): NormalizedChange | undefined {
	if (!change.path || !change.changeType) return undefined;
	return {
		path: change.path,
		changeType: change.changeType,
		dataType: change.dataType === 'Dir' ? 'Directory' : 'File',
		sourcePath: change.sourcePath ?? undefined,
		revisionGuid: change.oldContentOnUVCS
			? undefined // UVCS doesn't provide revision GUID directly
			: change.newContentOnCloudWorkspace?.revisionGuid,
		oldRevisionId: change.oldContentOnUVCS?.revisionId ?? undefined,
	};
}

/**
 * Backend-neutral result types. Decoupled from REST API schema and cm CLI output.
 */

/** Workspace status containing all pending changes. */
export interface StatusResult {
	changes: NormalizedChange[];
}

/** Result of a successful checkin operation. */
export interface CheckinResult {
	changesetId: number;
	branchName: string;
}

/** Branch metadata from the repository. */
export interface BranchInfo {
	id: number;
	name: string;
	owner: string;
	date: string;
	comment?: string;
	isMain: boolean;
	headChangeset?: number;
	changesetsCount?: number;
}

/** A single changeset (commit) in the repository history. */
export interface ChangesetInfo {
	id: number;
	branch: string;
	owner: string;
	date: string;
	comment?: string;
	parent: number;
	guid?: string;
}

/** A file affected by a changeset diff. */
export interface ChangesetDiffItem {
	path: string;
	type: 'added' | 'changed' | 'deleted' | 'moved';
	/** True if the entry is a directory — UI should skip diff click and show folder icon. */
	isDirectory?: boolean;
}

/** Result of a workspace update operation. */
export interface UpdateResult {
	updatedFiles: number;
	conflicts: string[];
}

// ── Phase 4: Code Reviews ──────────────────────────────────────────

export type ReviewStatus = 'Under review' | 'Reviewed' | 'Rework required';

/** Full metadata for a code review. */
export interface CodeReviewInfo {
	id: number;
	title: string;
	description?: string;
	status: ReviewStatus;
	owner: string;
	assignee?: string;
	created: string;
	modified: string;
	targetType: 'Branch' | 'Changeset' | 'Label';
	targetSpec?: string;
	targetId: number;
	commentsCount: number;
	repositoryName?: string;
	reviewers: ReviewerInfo[];
}

/** A reviewer assigned to a code review. */
export interface ReviewerInfo {
	name: string;
	status: ReviewStatus;
	isGroup: boolean;
}

export type ReviewCommentType =
	| 'Comment' | 'Change' | 'Question' | 'Conversation'
	| 'StatusUnderReview' | 'StatusReworkRequired' | 'StatusReviewed';

/** A comment on a code review, optionally anchored to a file and line. */
export interface ReviewCommentInfo {
	id: number;
	owner: string;
	text: string;
	type: ReviewCommentType;
	timestamp: string;
	parentCommentId?: number;
	itemName?: string;
	locationSpec?: string;
}

/** A review comment resolved to a concrete file path and line number. */
export interface ResolvedComment {
	id: number;
	owner: string;
	text: string;
	type: ReviewCommentType;
	timestamp: string;
	filePath: string;
	lineNumber: number;
	/** Revision ID for fetching content when file doesn't exist locally */
	revisionId?: number;
}

/** Parameters for creating a new code review. */
export interface CreateReviewParams {
	title: string;
	targetType: 'Branch' | 'Changeset' | 'Label';
	targetId: number;
	targetSpec?: string;
	description?: string;
	reviewers?: string[];
}

/** Parameters for adding a comment to a code review. */
export interface CreateCommentParams {
	reviewId: number;
	text: string;
	parentCommentId?: number;
}

// ── Phase 5: Labels, Merges, History, Locks ─────────────────────────

/** A label (tag) attached to a changeset. */
export interface LabelInfo {
	id: number;
	name: string;
	comment?: string;
	owner: string;
	date: string;
	changesetId: number;
	branch?: string;
}

/** Parameters for creating a new label. */
export interface CreateLabelParams {
	name: string;
	changesetId: number;
	comment?: string;
}

/** A single entry in a file's revision history. */
export interface FileHistoryEntry {
	revisionId: number;
	changesetId: number;
	branch: string;
	owner: string;
	date: string;
	comment?: string;
	type: 'added' | 'changed' | 'deleted' | 'moved';
}

/** Per-line blame/annotate information linking a line to its last-modifying changeset. */
export interface BlameLine {
	lineNumber: number;
	content: string;
	revisionId: number;
	changesetId: number;
	author: string;
	date: string;
	comment?: string;
}

/** Result of a merge preview (dry-run) check. */
export interface MergeReport {
	canMerge: boolean;
	conflicts: string[];
	changes: number;
	message?: string;
}

/** Result of an executed merge operation. */
export interface MergeResult {
	changesetId: number;
	conflicts: string[];
}

/**
 * A single merge link between two changesets, as reported by `cm find merge`.
 * `src` is the tip changeset that was merged in; `dst` is the changeset
 * created on the destination branch as a result of the merge.
 */
export interface MergeLink {
	src: number;
	dst: number;
}

// ── Phase 5: Locks ──────────────────────────────────────────────────

export type LockStatus = 'Retained' | 'Locked';

export interface LockRuleInfo {
	name: string;
	/** Glob pattern for files to lock (e.g. "*.psd", "Assets/Art/**") */
	rules: string;
	/** Branch where locks apply */
	targetBranch: string;
	/** Branches excluded from locking */
	excludedBranches: string[];
	/** Branches that receive exclusive locks */
	destinationBranches: string[];
}

/** An active lock on a specific item in the repository. */
export interface LockInfo {
	id: string;
	name: string;
	status: LockStatus;
	holderBranchName: string;
	holderBranchId: number;
	destinationBranchName: string;
	destinationBranchId: number;
	owner: string;
	date: string;
	itemId: number;
}

/** Thrown when a backend does not support a particular operation. */
export class NotSupportedError extends Error {
	constructor(operation: string, backend: string) {
		super(`"${operation}" is not supported by the ${backend} backend`);
		this.name = 'NotSupportedError';
	}
}
