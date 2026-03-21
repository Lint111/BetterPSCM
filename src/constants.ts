export const EXTENSION_ID = 'bpscm';
export const SCM_PROVIDER_ID = 'bpscm';
export const SCM_PROVIDER_LABEL = 'BetterPSCM';

export const PLASTIC_URI_SCHEME = 'bpscm';

export const RESOURCE_GROUP_STAGED = 'staged';
export const RESOURCE_GROUP_STAGED_LABEL = 'Staged Changes';
export const RESOURCE_GROUP_CHANGES = 'changes';
export const RESOURCE_GROUP_CHANGES_LABEL = 'Changes';

export const COMMANDS = {
	stage: 'bpscm.stage',
	unstage: 'bpscm.unstage',
	stageAll: 'bpscm.stageAll',
	unstageAll: 'bpscm.unstageAll',
	checkin: 'bpscm.checkin',
	checkinAll: 'bpscm.checkinAll',
	refresh: 'bpscm.refresh',
	openChange: 'bpscm.openChange',
	openFile: 'bpscm.openFile',
	revertChange: 'bpscm.revertChange',
	switchBranch: 'bpscm.switchBranch',
	createBranch: 'bpscm.createBranch',
	deleteBranch: 'bpscm.deleteBranch',
	mergeTo: 'bpscm.mergeTo',
	createCodeReview: 'bpscm.createCodeReview',
	openCodeReview: 'bpscm.openCodeReview',
	inspectReviewComments: 'bpscm.inspectReviewComments',
	nextReviewComment: 'bpscm.nextReviewComment',
	prevReviewComment: 'bpscm.prevReviewComment',
	exportReviewAudit: 'bpscm.exportReviewAudit',
	createLabel: 'bpscm.createLabel',
	update: 'bpscm.update',
	showFileHistory: 'bpscm.showFileHistory',
	annotateFile: 'bpscm.annotateFile',
	showHistoryGraph: 'bpscm.showHistoryGraph',
	login: 'bpscm.login',
	logout: 'bpscm.logout',
	listLockRules: 'bpscm.listLockRules',
	createLockRule: 'bpscm.createLockRule',
	deleteLockRules: 'bpscm.deleteLockRules',
	releaseLocks: 'bpscm.releaseLocks',
} as const;

// ── Timeout and cache constants ─────────────────────────────────────

/** TTL for cached branch data (20 seconds). */
export const BRANCH_CACHE_TTL_MS = 20_000;

/** TTL for history graph caches (30 seconds). */
export const GRAPH_CACHE_TTL_MS = 30_000;

/** Timeout for auto-login attempt (10 seconds). */
export const AUTO_LOGIN_TIMEOUT_MS = 10_000;

/** Milliseconds in one day. */
export const MS_PER_DAY = 86_400_000;

export const SETTINGS = {
	serverUrl: 'bpscm.serverUrl',
	organizationName: 'bpscm.organizationName',
	repositoryName: 'bpscm.repositoryName',
	workspaceGuid: 'bpscm.workspaceGuid',
	pollInterval: 'bpscm.pollInterval',
	showPrivateFiles: 'bpscm.showPrivateFiles',
	mcpEnabled: 'bpscm.mcp.enabled',
} as const;
