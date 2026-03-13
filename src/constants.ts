export const EXTENSION_ID = 'plasticScm';
export const SCM_PROVIDER_ID = 'plasticScm';
export const SCM_PROVIDER_LABEL = 'Plastic SCM';

export const PLASTIC_URI_SCHEME = 'plastic';

export const RESOURCE_GROUP_STAGED = 'staged';
export const RESOURCE_GROUP_STAGED_LABEL = 'Staged Changes';
export const RESOURCE_GROUP_CHANGES = 'changes';
export const RESOURCE_GROUP_CHANGES_LABEL = 'Changes';

export const COMMANDS = {
	stage: 'plasticScm.stage',
	unstage: 'plasticScm.unstage',
	stageAll: 'plasticScm.stageAll',
	unstageAll: 'plasticScm.unstageAll',
	checkin: 'plasticScm.checkin',
	checkinAll: 'plasticScm.checkinAll',
	refresh: 'plasticScm.refresh',
	openChange: 'plasticScm.openChange',
	openFile: 'plasticScm.openFile',
	revertChange: 'plasticScm.revertChange',
	switchBranch: 'plasticScm.switchBranch',
	createBranch: 'plasticScm.createBranch',
	deleteBranch: 'plasticScm.deleteBranch',
	refreshBranches: 'plasticScm.refreshBranches',
	mergeTo: 'plasticScm.mergeTo',
	createCodeReview: 'plasticScm.createCodeReview',
	openCodeReview: 'plasticScm.openCodeReview',
	createLabel: 'plasticScm.createLabel',
	update: 'plasticScm.update',
	showFileHistory: 'plasticScm.showFileHistory',
	annotateFile: 'plasticScm.annotateFile',
	showHistoryGraph: 'plasticScm.showHistoryGraph',
	login: 'plasticScm.login',
	logout: 'plasticScm.logout',
} as const;

export const SETTINGS = {
	serverUrl: 'plasticScm.serverUrl',
	organizationName: 'plasticScm.organizationName',
	repositoryName: 'plasticScm.repositoryName',
	workspaceGuid: 'plasticScm.workspaceGuid',
	pollInterval: 'plasticScm.pollInterval',
	showPrivateFiles: 'plasticScm.showPrivateFiles',
	mcpEnabled: 'plasticScm.mcp.enabled',
} as const;
