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

export interface StatusResult {
	changes: NormalizedChange[];
}

export interface CheckinResult {
	changesetId: number;
	branchName: string;
}

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

export interface ChangesetInfo {
	id: number;
	branch: string;
	owner: string;
	date: string;
	comment?: string;
	parent: number;
	guid?: string;
}

export interface ChangesetDiffItem {
	path: string;
	type: 'added' | 'changed' | 'deleted' | 'moved';
}

export interface UpdateResult {
	updatedFiles: number;
	conflicts: string[];
}

// ── Phase 4: Code Reviews ──────────────────────────────────────────

export type ReviewStatus = 'Under review' | 'Reviewed' | 'Rework required';

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

export interface ReviewerInfo {
	name: string;
	status: ReviewStatus;
	isGroup: boolean;
}

export type ReviewCommentType =
	| 'Comment' | 'Change' | 'Question' | 'Conversation'
	| 'StatusUnderReview' | 'StatusReworkRequired' | 'StatusReviewed';

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

export interface CreateReviewParams {
	title: string;
	targetType: 'Branch' | 'Changeset' | 'Label';
	targetId: number;
	targetSpec?: string;
	description?: string;
	reviewers?: string[];
}

export interface CreateCommentParams {
	reviewId: number;
	text: string;
	parentCommentId?: number;
}

// ── Phase 5: Labels, Merges, History, Locks ─────────────────────────

export interface LabelInfo {
	id: number;
	name: string;
	comment?: string;
	owner: string;
	date: string;
	changesetId: number;
	branch?: string;
}

export interface CreateLabelParams {
	name: string;
	changesetId: number;
	comment?: string;
}

export interface FileHistoryEntry {
	revisionId: number;
	changesetId: number;
	branch: string;
	owner: string;
	date: string;
	comment?: string;
	type: 'added' | 'changed' | 'deleted' | 'moved';
}

export interface BlameLine {
	lineNumber: number;
	content: string;
	revisionId: number;
	changesetId: number;
	author: string;
	date: string;
	comment?: string;
}

export interface MergeReport {
	canMerge: boolean;
	conflicts: string[];
	changes: number;
	message?: string;
}

export interface MergeResult {
	changesetId: number;
	conflicts: string[];
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

export class NotSupportedError extends Error {
	constructor(operation: string, backend: string) {
		super(`"${operation}" is not supported by the ${backend} backend`);
		this.name = 'NotSupportedError';
	}
}
