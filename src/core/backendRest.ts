import { getClient, getOrgName, getWorkspaceGuid, getRepoName } from '../api/client';
import { log } from '../util/logger';
import type { PlasticBackend } from './backend';
import type { StatusResult, CheckinResult, NormalizedChange, BranchInfo } from './types';
import type { CheckInRequest } from './types';
import { normalizeChange } from './types';

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

		return data ? new Uint8Array(data as ArrayBuffer) : undefined;
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
}
