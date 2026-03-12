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

export class NotSupportedError extends Error {
	constructor(operation: string, backend: string) {
		super(`"${operation}" is not supported by the ${backend} backend`);
		this.name = 'NotSupportedError';
	}
}
