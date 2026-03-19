import { getClient, getOrgName, getWorkspaceGuid, getRepoName } from '../api/client';
import { log } from '../util/logger';
import type { PlasticBackend } from './backend';
import type {
	StatusResult, CheckinResult, NormalizedChange, BranchInfo, ChangesetInfo,
	ChangesetDiffItem, UpdateResult, CodeReviewInfo, ReviewCommentInfo,
	ReviewerInfo, CreateReviewParams, CreateCommentParams, ReviewStatus,
	LabelInfo, CreateLabelParams, FileHistoryEntry, BlameLine,
	MergeReport, MergeResult,
	LockRuleInfo, LockInfo,
} from './types';
import type { CheckInRequest } from './types';
import { normalizeChange, NotSupportedError } from './types';

export class RestBackend implements PlasticBackend {
	readonly name = 'REST API';

	async getStatus(showPrivate: boolean): Promise<StatusResult> {
		const client = getClient();
		const orgName = getOrgName();
		const workspaceGuid = getWorkspaceGuid();

		const { data, error } = await client.GET(
			'/api/v1/organizations/{organizationName}/workspaces/{workspaceGuid}/status',
			{ params: { path: { organizationName: orgName, workspaceGuid } } },
		);

		if (error) throw error;

		const rawChanges = data?.changes ?? [];
		let changes = rawChanges
			.map(normalizeChange)
			.filter((c): c is NormalizedChange => c !== undefined);

		if (!showPrivate) {
			changes = changes.filter(c => c.changeType !== 'private');
		}

		return { changes };
	}

	async getCurrentBranch(): Promise<string | undefined> {
		const client = getClient();
		const orgName = getOrgName();
		const workspaceGuid = getWorkspaceGuid();

		const { data, error } = await client.GET(
			'/api/v1/organizations/{organizationName}/workspaces/{workspaceGuid}',
			{ params: { path: { organizationName: orgName, workspaceGuid } } },
		);

		if (error) throw error;

		const conn = (data as any)?.uvcsConnections?.[0];
		if (conn?.target?.type === 'Branch') {
			return conn.target.spec ?? conn.target.repositoryName ?? undefined;
		}
		return conn?.target?.spec ?? undefined;
	}

	async checkin(paths: string[], comment: string): Promise<CheckinResult> {
		const client = getClient();
		const orgName = getOrgName();
		const workspaceGuid = getWorkspaceGuid();

		const body: CheckInRequest = { items: paths, comment, statusIgnoreCase: false };

		const { data, error } = await client.POST(
			'/api/v1/organizations/{organizationName}/workspaces/{workspaceGuid}/checkin',
			{
				params: { path: { organizationName: orgName, workspaceGuid } },
				body: body as any,
			},
		);

		if (error) throw error;

		const result = data as any;
		log(`Checked in ${paths.length} file(s): "${comment}"`);

		return {
			changesetId: result?.changesetId ?? 0,
			branchName: result?.branchName ?? 'unknown',
		};
	}

	/** Maximum file size for REST content fetches (50 MB). */
	private static readonly MAX_FILE_SIZE = 50 * 1024 * 1024;

	async getFileContent(revSpec: string): Promise<Uint8Array | undefined> {
		const client = getClient();
		const orgName = getOrgName();
		const workspaceGuid = getWorkspaceGuid();

		const { data, error } = await client.GET(
			'/api/v1/organizations/{organizationName}/workspaces/{workspaceGuid}/content/{revisionGuid}',
			{
				params: { path: { organizationName: orgName, workspaceGuid, revisionGuid: revSpec } },
				parseAs: 'arrayBuffer',
			},
		);

		if (error) return undefined;
		if (!data) return undefined;

		const buf = data as ArrayBuffer;
		if (buf.byteLength > RestBackend.MAX_FILE_SIZE) {
			log(`File content too large (${(buf.byteLength / 1024 / 1024).toFixed(1)} MB), skipping`);
			return undefined;
		}

		return new Uint8Array(buf);
	}

	async listBranches(): Promise<BranchInfo[]> {
		const client = getClient();
		const orgName = getOrgName();
		const repoName = getRepoName();

		const { data, error } = await client.GET(
			'/api/v1/organizations/{orgName}/repos/{repoName}/branches' as any,
			{ params: { path: { orgName, repoName } } },
		);

		if (error) throw error;

		const branches = (data as any[]) ?? [];
		return branches.map((b: any) => ({
			id: b.id ?? 0,
			name: b.name ?? '',
			owner: b.owner ?? '',
			date: b.date ?? '',
			comment: b.comment ?? undefined,
			isMain: b.isMainBranch ?? false,
			headChangeset: b.headChangeset ?? undefined,
			changesetsCount: b.changesetsCount ?? undefined,
		}));
	}

	async createBranch(name: string, comment?: string): Promise<BranchInfo> {
		const client = getClient();
		const orgName = getOrgName();
		const repoName = getRepoName();

		// Get head changeset from main branch
		const { data: mainData, error: mainError } = await client.GET(
			'/api/v1/organizations/{orgName}/repos/{repoName}/main-branch' as any,
			{ params: { path: { orgName, repoName } } },
		);

		if (mainError) throw mainError;
		const headChangeset = (mainData as any)?.headChangeset ?? 0;

		const { data, error } = await client.POST(
			'/api/v1/organizations/{orgName}/repos/{repoName}/branches' as any,
			{
				params: { path: { orgName, repoName } },
				body: { name, changeset: headChangeset, comment: comment ?? '' } as any,
			},
		);

		if (error) throw error;

		const result = data as any;
		log(`Created branch "${name}"`);

		return {
			id: result?.id ?? 0,
			name: result?.name ?? name,
			owner: result?.owner ?? '',
			date: result?.date ?? '',
			comment: result?.comment ?? undefined,
			isMain: false,
		};
	}

	async deleteBranch(branchId: number): Promise<void> {
		const client = getClient();
		const orgName = getOrgName();
		const repoName = getRepoName();

		const { error } = await client.DELETE(
			'/api/v2/organizations/{orgName}/repositories/{repoName}/branches/{branchId}' as any,
			{ params: { path: { orgName, repoName, branchId } } },
		);

		if (error) throw error;
		log(`Deleted branch ${branchId}`);
	}

	async switchBranch(branchName: string): Promise<void> {
		const client = getClient();
		const orgName = getOrgName();
		const workspaceGuid = getWorkspaceGuid();

		const { error } = await client.POST(
			'/api/v1/organizations/{organizationName}/workspaces/{workspaceGuid}/update',
			{
				params: { path: { organizationName: orgName, workspaceGuid } },
				body: { targetBranch: branchName } as any,
			},
		);

		if (error) throw error;
		log(`Switched to branch "${branchName}"`);
	}

	async listChangesets(branchName?: string, limit?: number): Promise<ChangesetInfo[]> {
		const client = getClient();
		const orgName = getOrgName();
		const repoName = getRepoName();

		const params: any = { path: { orgName, repoName } };
		if (branchName) {
			params.query = { branchName, ...(limit ? { limit } : {}) };
		} else if (limit) {
			params.query = { limit };
		}

		const { data, error } = await client.GET(
			'/api/v1/organizations/{orgName}/repos/{repoName}/changesets' as any,
			{ params },
		);

		if (error) throw error;

		const changesets = (data as any[]) ?? [];
		return changesets.map((c: any) => ({
			id: c.changesetId ?? c.id ?? 0,
			branch: c.branch ?? '',
			owner: c.owner ?? '',
			date: c.date ?? '',
			comment: c.comment ?? undefined,
			parent: c.parentChangesetId ?? 0,
		}));
	}

	async updateWorkspace(): Promise<UpdateResult> {
		const client = getClient();
		const orgName = getOrgName();
		const workspaceGuid = getWorkspaceGuid();

		const { data, error } = await client.POST(
			'/api/v1/organizations/{organizationName}/workspaces/{workspaceGuid}/update',
			{
				params: { path: { organizationName: orgName, workspaceGuid } },
				body: { recursive: true, ignoreCase: false, items: [], fileConflicts: [] } as any,
			},
		);

		if (error) throw error;

		const result = data as any;
		const conflicts = (result?.fileConflicts ?? []).map((c: any) => c.path ?? String(c));

		log(`Workspace updated via REST API`);
		return { updatedFiles: 0, conflicts };
	}

	async getChangesetDiff(changesetId: number, parentId: number): Promise<ChangesetDiffItem[]> {
		const client = getClient();
		const orgName = getOrgName();
		const repoName = getRepoName();

		const { data, error } = await client.GET(
			'/api/v1/organizations/{orgName}/repos/{repoName}/changesets/{changesetId}/diff' as any,
			{ params: { path: { orgName, repoName, changesetId } } },
		);

		if (error) {
			log(`getChangesetDiff failed for cs:${changesetId}: ${error instanceof Error ? error.message : String(error)}`);
			return [];
		}

		const diffs = (data as any[]) ?? [];
		return diffs.map((d: any) => ({
			path: d.path ?? '',
			type: (d.type ?? 'changed').toLowerCase() as 'added' | 'changed' | 'deleted' | 'moved',
		}));
	}

	// ── Phase 4: Code Reviews ──────────────────────────────────────

	async listCodeReviews(filter?: 'all' | 'assignedToMe' | 'createdByMe' | 'pending'): Promise<CodeReviewInfo[]> {
		const client = getClient();
		const orgName = getOrgName();
		const repoName = getRepoName();

		const filterMap: Record<string, string> = {
			all: 'All',
			assignedToMe: 'AssignedToMe',
			createdByMe: 'CreatedByMe',
			pending: 'AllPending',
		};

		const { data, error } = await client.GET(
			'/api/v1/organizations/{orgName}/repos/{repoName}/codereviews' as any,
			{
				params: {
					path: { orgName, repoName },
					query: filter ? { filter: filterMap[filter] ?? 'All' } : undefined,
				},
			},
		);

		if (error) throw error;
		return ((data as any[]) ?? []).map(mapCodeReview);
	}

	async getCodeReview(id: number): Promise<CodeReviewInfo> {
		const client = getClient();
		const orgName = getOrgName();
		const repoName = getRepoName();

		const { data, error } = await client.GET(
			'/api/v1/organizations/{orgName}/repos/{repoName}/codereview/{codeReviewId}' as any,
			{ params: { path: { orgName, repoName, codeReviewId: id } } },
		);

		if (error) throw error;
		return mapCodeReview(data);
	}

	async createCodeReview(params: CreateReviewParams): Promise<CodeReviewInfo> {
		const client = getClient();
		const orgName = getOrgName();
		const repoName = getRepoName();

		const body: any = {
			title: params.title,
			status: 'Under review',
			object: {
				type: params.targetType,
				targetId: params.targetId,
				spec: params.targetSpec,
			},
		};

		const { data, error } = await client.POST(
			'/api/v1/organizations/{orgName}/repos/{repoName}/codereview' as any,
			{
				params: { path: { orgName, repoName } },
				body,
			},
		);

		if (error) throw error;
		const review = mapCodeReview(data);

		// Add reviewers if specified
		if (params.reviewers && params.reviewers.length > 0) {
			await this.addReviewers(review.id, params.reviewers);
		}

		return review;
	}

	async deleteCodeReview(id: number): Promise<void> {
		const client = getClient();
		const orgName = getOrgName();
		const repoName = getRepoName();

		const { error } = await client.DELETE(
			'/api/v1/organizations/{orgName}/repos/{repoName}/codereview/{codeReviewId}' as any,
			{ params: { path: { orgName, repoName, codeReviewId: id } } },
		);

		if (error) throw error;
		log(`Deleted code review ${id}`);
	}

	async updateCodeReviewStatus(id: number, status: ReviewStatus): Promise<void> {
		const client = getClient();
		const orgName = getOrgName();
		const repoName = getRepoName();

		// Status is changed by adding a status-change comment
		const commentTypeMap: Record<string, string> = {
			'Under review': 'StatusUnderReview',
			'Reviewed': 'StatusReviewed',
			'Rework required': 'StatusReworkRequired',
		};

		const { error } = await client.POST(
			'/api/v1/organizations/{orgName}/repos/{repoName}/codereview/{codeReviewId}/comment' as any,
			{
				params: { path: { orgName, repoName, codeReviewId: id } },
				body: {
					revisionId: 0,
					type: commentTypeMap[status] ?? 'StatusUnderReview',
					commentText: '',
				},
			},
		);

		if (error) throw error;
		log(`Updated code review ${id} status to "${status}"`);
	}

	async getReviewComments(reviewId: number): Promise<ReviewCommentInfo[]> {
		const client = getClient();
		const orgName = getOrgName();
		const repoName = getRepoName();

		const { data, error } = await client.GET(
			'/api/v1/organizations/{orgName}/repos/{repoName}/codereview/{codeReviewId}/comment' as any,
			{ params: { path: { orgName, repoName, codeReviewId: reviewId } } },
		);

		if (error) throw error;

		const comments = (data as any)?.comments ?? (data as any[]) ?? [];
		log(`[getReviewComments] review ${reviewId}: ${comments.length} total comments, types: ${comments.map((c: any) => c.type).join(', ')}`);
		const filtered = comments
			.filter((c: any) => !isSystemCommentType(c.type));
		log(`[getReviewComments] after filtering system types: ${filtered.length} comments`);
		return filtered.map(mapComment);
	}

	async addReviewComment(params: CreateCommentParams): Promise<ReviewCommentInfo> {
		const client = getClient();
		const orgName = getOrgName();
		const repoName = getRepoName();

		if (params.parentCommentId) {
			// Reply to existing comment
			const { data, error } = await client.POST(
				'/api/v1/organizations/{orgName}/repos/{repoName}/codereview/{codeReviewId}/comment/{parentCommentId}/reply' as any,
				{
					params: { path: { orgName, repoName, codeReviewId: params.reviewId, parentCommentId: params.parentCommentId } },
					body: { commentText: params.text, type: 'Comment' },
				},
			);
			if (error) throw error;
			return mapComment(data);
		}

		const { data, error } = await client.POST(
			'/api/v1/organizations/{orgName}/repos/{repoName}/codereview/{codeReviewId}/comment' as any,
			{
				params: { path: { orgName, repoName, codeReviewId: params.reviewId } },
				body: { revisionId: 0, commentText: params.text, type: 'Comment' },
			},
		);

		if (error) throw error;
		return mapComment(data);
	}

	async getReviewers(reviewId: number): Promise<ReviewerInfo[]> {
		const client = getClient();
		const orgName = getOrgName();
		const repoName = getRepoName();

		const { data, error } = await client.GET(
			'/api/v1/organizations/{orgName}/repos/{repoName}/codereview/{codeReviewId}/reviewers' as any,
			{ params: { path: { orgName, repoName, codeReviewId: reviewId } } },
		);

		if (error) throw error;
		return ((data as any[]) ?? []).map((r: any) => ({
			name: r.reviewer ?? '',
			status: r.status ?? 'Under review',
			isGroup: r.isGroup ?? false,
		}));
	}

	async addReviewers(reviewId: number, reviewers: string[]): Promise<void> {
		const client = getClient();
		const orgName = getOrgName();
		const repoName = getRepoName();

		const { error } = await client.POST(
			'/api/v1/organizations/{orgName}/repos/{repoName}/codereview/{codeReviewId}/reviewers' as any,
			{
				params: { path: { orgName, repoName, codeReviewId: reviewId } },
				body: { reviewers },
			},
		);

		if (error) throw error;
		log(`Added ${reviewers.length} reviewer(s) to review ${reviewId}`);
	}

	async removeReviewer(reviewId: number, reviewer: string): Promise<void> {
		const client = getClient();
		const orgName = getOrgName();
		const repoName = getRepoName();

		const { error } = await client.DELETE(
			'/api/v1/organizations/{orgName}/repos/{repoName}/codereview/{codeReviewId}/reviewers/{reviewerName}' as any,
			{ params: { path: { orgName, repoName, codeReviewId: reviewId, reviewerName: reviewer } } },
		);

		if (error) throw error;
		log(`Removed reviewer "${reviewer}" from review ${reviewId}`);
	}

	async updateReviewerStatus(reviewId: number, reviewer: string, status: ReviewStatus): Promise<void> {
		const client = getClient();
		const orgName = getOrgName();
		const repoName = getRepoName();

		const { error } = await client.PUT(
			'/api/v1/organizations/{orgName}/repos/{repoName}/codereview/{codeReviewId}/reviewers/{reviewerName}/status' as any,
			{
				params: { path: { orgName, repoName, codeReviewId: reviewId, reviewerName: reviewer } },
				body: { status },
			},
		);

		if (error) throw error;
		log(`Updated reviewer "${reviewer}" status to "${status}" on review ${reviewId}`);
	}

	// Phase 5 — Labels
	async listLabels(): Promise<LabelInfo[]> {
		const client = getClient();
		const orgName = getOrgName();
		const repoName = getRepoName();

		const { data, error } = await client.GET(
			'/api/v1/organizations/{orgName}/repos/{repoName}/labels',
			{ params: { path: { orgName, repoName } } },
		);

		if (error) throw error;
		return ((data as any) ?? []).map(mapLabel);
	}

	async createLabel(params: CreateLabelParams): Promise<LabelInfo> {
		const client = getClient();
		const orgName = getOrgName();
		const repoName = getRepoName();

		const { data, error } = await client.POST(
			'/api/v1/organizations/{orgName}/repos/{repoName}/labels',
			{
				params: { path: { orgName, repoName } },
				body: {
					name: params.name,
					changeset: params.changesetId,
					comment: params.comment,
				} as any,
			},
		);

		if (error) throw error;
		return mapLabel(data ?? { name: params.name, changeset: params.changesetId });
	}

	async deleteLabel(id: number): Promise<void> {
		const client = getClient();
		const orgName = getOrgName();
		const repoName = getRepoName();

		const { error } = await client.DELETE(
			'/api/v2/organizations/{orgName}/repositories/{repoName}/labels/{labelId}',
			{ params: { path: { orgName, repoName, labelId: id } } },
		);

		if (error) throw error;
	}

	// Phase 5 — File history
	async getFileHistory(path: string): Promise<FileHistoryEntry[]> {
		const client = getClient();
		const orgName = getOrgName();
		const repoName = getRepoName();

		const { data, error } = await client.GET(
			'/api/v1/organizations/{orgName}/repos/{repoName}/branch/{branchName}/history/{path}',
			{
				params: {
					path: { orgName, repoName, branchName: 'main', path },
				},
			},
		);

		if (error) throw error;
		return ((data as any) ?? []).map(mapHistoryEntry);
	}

	async getBlame(_path: string): Promise<BlameLine[]> {
		throw new NotSupportedError('getBlame', this.name);
	}

	// Phase 5 — Merges
	async checkMergeAllowed(sourceBranch: string, targetBranch: string): Promise<MergeReport> {
		const client = getClient();
		const orgName = getOrgName();
		const repoName = getRepoName();

		const { data, error } = await client.GET(
			'/api/v1/organizations/{orgName}/repos/{repoName}/mergeto/allowed/{srcBranchName}',
			{
				params: {
					path: { orgName, repoName, srcBranchName: sourceBranch },
					query: { to: targetBranch } as any,
				},
			},
		);

		if (error) throw error;
		const d = data as any;
		return {
			canMerge: d?.isAllowed ?? false,
			conflicts: (d?.conflicts ?? []).map((c: any) => c?.path ?? String(c)),
			changes: d?.changesCount ?? 0,
			message: d?.message ?? undefined,
		};
	}

	async executeMerge(sourceBranch: string, targetBranch: string, comment?: string): Promise<MergeResult> {
		const client = getClient();
		const orgName = getOrgName();
		const repoName = getRepoName();

		const { data, error } = await client.POST(
			'/api/v1/organizations/{orgName}/repos/{repoName}/mergeto',
			{
				params: { path: { orgName, repoName } },
				body: {
					source: sourceBranch,
					destination: targetBranch,
					comment,
				} as any,
			},
		);

		if (error) throw error;
		const d = data as any;
		return {
			changesetId: d?.changesetId ?? 0,
			conflicts: (d?.conflicts ?? []).map((c: any) => c?.path ?? String(c)),
		};
	}
	// Phase 6 — Undo checkout (REST API doesn't support this, delegate to CLI)
	async undoCheckout(_paths: string[]): Promise<string[]> {
		throw new NotSupportedError('undoCheckout', this.name);
	}

	// Phase 7 — Add files (REST API doesn't support this, delegate to CLI)
	async addToSourceControl(_paths: string[]): Promise<string[]> {
		throw new NotSupportedError('addToSourceControl', this.name);
	}

	// Phase 7 — get base revision content for backup
	async getBaseRevisionContent(_path: string): Promise<Buffer | null> {
		throw new NotSupportedError('getBaseRevisionContent', this.name);
	}

	// Phase 5 — Locks
	async listLockRules(): Promise<LockRuleInfo[]> {
		const client = getClient();
		const orgName = getOrgName();

		const { data, error } = await client.GET(
			'/api/v2/organizations/{orgName}/lock-rules',
			{ params: { path: { orgName } } },
		);

		if (error) throw error;
		const d = data as any;
		return (d?.repositoryRules ?? []).map(mapLockRule);
	}

	async createLockRule(rule: LockRuleInfo): Promise<LockRuleInfo> {
		const client = getClient();
		const orgName = getOrgName();

		const { data, error } = await client.POST(
			'/api/v2/organizations/{orgName}/lock-rules',
			{
				params: { path: { orgName } },
				body: {
					name: rule.name,
					rules: rule.rules,
					targetBranch: rule.targetBranch,
					excludedBranches: rule.excludedBranches,
					destinationBranches: rule.destinationBranches,
				},
			},
		);

		if (error) throw error;
		log(`Created lock rule "${rule.name}"`);
		return mapLockRule(data ?? rule);
	}

	async deleteLockRules(): Promise<void> {
		const client = getClient();
		const orgName = getOrgName();

		const { error } = await client.DELETE(
			'/api/v2/organizations/{orgName}/lock-rules',
			{ params: { path: { orgName } } },
		);

		if (error) throw error;
		log('Deleted all lock rules');
	}

	async deleteLockRulesForRepo(): Promise<void> {
		const client = getClient();
		const orgName = getOrgName();
		const repoName = getRepoName();

		const { error } = await client.DELETE(
			'/api/v2/organizations/{orgName}/lock-rules/{repositoryName}' as any,
			{ params: { path: { orgName, repositoryName: repoName } } },
		);

		if (error) throw error;
		log(`Deleted lock rules for repo "${repoName}"`);
	}

	async resolveRevisionPaths(_revisionIds: number[]): Promise<Map<number, string>> {
		return new Map();
	}

	async releaseLocks(itemIds: number[], mode: 'Delete' | 'Release'): Promise<void> {
		const client = getClient();
		const orgName = getOrgName();
		const repoName = getRepoName();

		const { error } = await client.DELETE(
			'/api/v2/organizations/{orgName}/repositories/{repoName}/locks' as any,
			{
				params: {
					path: { orgName, repoName },
					query: { itemIds, editLockType: mode },
				},
			},
		);

		if (error) throw error;
		log(`${mode === 'Release' ? 'Released' : 'Deleted'} ${itemIds.length} lock(s)`);
	}
}

function mapLockRule(data: any): LockRuleInfo {
	return {
		name: data?.name ?? '',
		rules: data?.rules ?? '',
		targetBranch: data?.targetBranch ?? '',
		excludedBranches: data?.excludedBranches ?? [],
		destinationBranches: data?.destinationBranches ?? [],
	};
}

function mapCodeReview(data: any): CodeReviewInfo {
	return {
		id: data?.id ?? 0,
		title: data?.title ?? '',
		description: data?.description ?? undefined,
		status: data?.status ?? 'Under review',
		owner: data?.owner ?? '',
		assignee: data?.assignee ?? undefined,
		created: data?.timestamp ?? '',
		modified: data?.modifiedTimestamp ?? '',
		targetType: data?.object?.type ?? 'Branch',
		targetSpec: data?.object?.spec ?? undefined,
		targetId: data?.object?.targetId ?? 0,
		commentsCount: data?.commentsCount ?? 0,
		repositoryName: data?.repositoryName ?? undefined,
		reviewers: (data?.reviewers ?? []).map((r: any) => ({
			name: r.reviewer ?? '',
			status: r.status ?? 'Under review',
			isGroup: r.isGroup ?? false,
		})),
	};
}

function mapComment(data: any): ReviewCommentInfo {
	// REST API stores revisionId and locationSpec (line number) as separate fields.
	// The resolver expects "revisionId#lineNumber" format, so combine them.
	const revisionId = data?.revisionId as number | undefined;
	const rawLoc = data?.locationSpec as string | number | undefined | null;
	let locationSpec: string | undefined;
	if (revisionId && revisionId > 0 && rawLoc !== undefined && rawLoc !== null) {
		const lineNum = typeof rawLoc === 'number' ? rawLoc : parseInt(String(rawLoc), 10);
		if (!isNaN(lineNum) && lineNum >= 0) {
			locationSpec = `${revisionId}#${lineNum}`;
		}
	}

	return {
		id: data?.id ?? 0,
		owner: data?.owner ?? '',
		text: data?.commentText ?? '',
		type: normalizeCommentType(data?.type),
		timestamp: data?.timestamp ?? '',
		parentCommentId: data?.parentCommentId || undefined,
		itemName: data?.itemName ?? undefined,
		locationSpec,
	};
}

function normalizeCommentType(type: string | undefined): ReviewCommentInfo['type'] {
	const valid = ['Comment', 'Change', 'Question', 'Conversation',
		'StatusUnderReview', 'StatusReworkRequired', 'StatusReviewed'];
	return valid.includes(type ?? '') ? type as ReviewCommentInfo['type'] : 'Comment';
}

function isSystemCommentType(type: string | undefined): boolean {
	const system = ['Timeline', 'Script', 'Discarded', 'Description',
		'RequestedReviewer', 'ReRequestedReviewer'];
	return system.includes(type ?? '');
}

function mapLabel(data: any): LabelInfo {
	return {
		id: data?.id ?? 0,
		name: data?.name ?? '',
		comment: data?.comment ?? undefined,
		owner: data?.owner ?? '',
		date: data?.timestamp ?? data?.date ?? '',
		changesetId: data?.changeset ?? data?.changesetId ?? 0,
		branch: data?.branch ?? undefined,
	};
}

function mapHistoryEntry(data: any): FileHistoryEntry {
	return {
		revisionId: data?.revisionId ?? 0,
		changesetId: data?.changesetId ?? data?.changeset ?? 0,
		branch: data?.branch ?? '',
		owner: data?.owner ?? '',
		date: data?.timestamp ?? data?.date ?? '',
		comment: data?.comment ?? undefined,
		type: (data?.type ?? 'changed').toLowerCase().includes('add') ? 'added'
			: (data?.type ?? '').toLowerCase().includes('del') ? 'deleted'
			: (data?.type ?? '').toLowerCase().includes('mov') ? 'moved'
			: 'changed',
	};
}
