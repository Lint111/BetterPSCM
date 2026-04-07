import * as vscode from 'vscode';
import { initAuth, hasStoredCredentials, createAuthMiddleware, loginWithToken, loginWithPAT, logout } from './api/auth';
import { getClient, getOrgName, getOrgNameVariants, setResolvedOrgName, setOrgNameHints, getWorkspaceGuid, resetClient } from './api/client';
import { isConfigured, getConfig, initDetectedConfig } from './util/config';
import { log, logError } from './util/logger';
import { DisposableStore } from './util/disposable';
import { AUTO_LOGIN_TIMEOUT_MS } from './constants';
import { PlasticScmProvider } from './scm/plasticScmProvider';
import { PlasticStatusBar } from './statusBar/plasticStatusBar';
import { registerStagingCommands } from './commands/staging';
import { registerCheckinCommands } from './commands/checkin';
import { registerCleanStaleCommand } from './commands/cleanStale';
import { registerGeneralCommands } from './commands/general';
import { registerBranchCommands } from './commands/branch';
import { registerUpdateCommands } from './commands/update';
import { registerCodeReviewCommands } from './commands/codeReview';
import { registerHistoryCommands } from './commands/history';
import { registerMergeCommands } from './commands/merge';
import { registerLabelCommands } from './commands/label';
import { registerAuthCommands } from './commands/auth';
import { registerLockCommands } from './commands/lock';
import { McpServerManager } from './mcp/manager';
import { registerMcpServerDefinition } from './mcp/definitionProvider';
import { CodeReviewsTreeProvider } from './views/codeReviewsTreeProvider';
import { ReviewCommentsTreeProvider } from './views/reviewCommentsTreeProvider';
import { ReviewNavigationController } from './providers/reviewNavigationController';
import { ReviewDecorationProvider } from './providers/reviewDecorationProvider';
import { HistoryGraphViewProvider } from './views/historyGraphPanel';
import { COMMANDS, SETTINGS } from './constants';
import { detectWorkspace, detectClientConfig, detectCachedToken, hasPlasticWorkspace } from './util/plasticDetector';
import { detectCm, isCmAvailable } from './core/cmCli';
import { setBackend } from './core/backend';
import { CliBackend } from './core/backendCli';
import { RestBackend } from './core/backendRest';
import { createHybridBackend } from './core/backendHybrid';
import { createPlasticContext, PlasticContext } from './core/context';

const disposables = new DisposableStore();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	log('BetterPSCM extension activating...');

	// Initialize auth with secret storage
	initAuth(context.secrets);

	// Register auth commands (always available, even before config)
	registerAuthCommands(context);

	// Initialize detection-first config from .plastic folder
	const wsFolder = vscode.workspace.workspaceFolders?.[0];
	if (wsFolder) {
		initDetectedConfig(wsFolder.uri.fsPath);
	}

	// Auto-detect workspace from .plastic folder if not yet configured
	await autoDetectAndConfigure();

	// Detect cm CLI early so isConfigured() can account for it. The probe
	// runs `cm version` which doesn't need a workspace root, so we don't
	// pre-set one here — the per-workspace PlasticContext built later in
	// setupProvider() carries the root for actual cm operations.
	if (wsFolder) {
		await detectCm();
	}

	if (!isConfigured()) {
		log('Extension not configured. Waiting for settings.');
		const welcomeProvider = disposables.add(
			vscode.scm.createSourceControl('bpscm', 'BetterPSCM'),
		);
		welcomeProvider.inputBox.placeholder = 'Configure Plastic SCM settings to get started';
		context.subscriptions.push(disposables);

		// Watch for config changes
		context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('bpscm')) {
					if (isConfigured()) {
						log('Configuration detected, reactivating...');
						disposables.dispose();
						setupProvider(context);
					}
				}
			}),
		);
		return;
	}

	await setupProvider(context);
	context.subscriptions.push(disposables);

	log('BetterPSCM extension activated');
}

/**
 * Auto-detect Plastic SCM workspace info from the .plastic folder
 * and populate settings if they are empty.
 */
async function autoDetectAndConfigure(): Promise<void> {
	const wsFolder = vscode.workspace.workspaceFolders?.[0];
	if (!wsFolder) return;

	const wsRoot = wsFolder.uri.fsPath;
	if (!hasPlasticWorkspace(wsRoot)) {
		log('No .plastic workspace detected in opened folder');
		return;
	}

	const info = detectWorkspace(wsRoot);
	if (!info) return;

	log(`Auto-detected Plastic workspace: ${info.workspaceName} (${info.workspaceGuid})`);
	log(`  Org: ${info.organizationName}, Repo: ${info.repositoryName}`);
	log(`  Branch: ${info.currentBranch}, Cloud: ${info.isCloud}`);

	// Provide org name hints for REST API login fallback
	if (info.isCloud) {
		const hints: string[] = [];
		if (info.cloudServerId) hints.push(info.cloudServerId);
		if (info.displayOrgName && info.displayOrgName !== info.organizationName) {
			hints.push(info.displayOrgName);
			// Also try lowercase-hyphenated version of display name
			const hyphenated = info.displayOrgName.toLowerCase().replace(/\s+/g, '-');
			if (hyphenated !== info.organizationName) hints.push(hyphenated);
		}
		if (hints.length > 0) {
			setOrgNameHints(hints);
			log(`  Org name hints for REST API: ${hints.join(', ')}`);
		}
	}

	const config = vscode.workspace.getConfiguration();

	// Build list of settings that need to be populated
	const desired: Array<[string, string]> = [
		[SETTINGS.serverUrl, info.serverUrl],
		[SETTINGS.organizationName, info.organizationName],
		[SETTINGS.repositoryName, info.repositoryName],
		[SETTINGS.workspaceGuid, info.workspaceGuid],
	];

	const updates = desired.filter(([key, value]) => {
		const current = config.get<string>(key);
		if (!current) return true;
		// Re-write serverUrl if invalid or changed (e.g., wrong cloud region)
		if (key === SETTINGS.serverUrl && current !== value) {
			log(`  Updating ${key}: "${current}" → "${value}"`);
			return true;
		}
		// Re-write organizationName or repositoryName if changed
		if ((key === SETTINGS.organizationName || key === SETTINGS.repositoryName) && current !== value) {
			log(`  Updating ${key}: "${current}" → "${value}"`);
			return true;
		}
		return false;
	});

	if (updates.length > 0) {
		// Write all settings concurrently to avoid partial writes
		await Promise.all(
			updates.map(async ([key, value]) => {
				await config.update(key, value, vscode.ConfigurationTarget.Workspace);
				log(`  Auto-configured ${key} = ${value}`);
			}),
		);

		const clientInfo = detectClientConfig();
		if (clientInfo) {
			log(`  Client mode: ${clientInfo.workingMode}, user: ${clientInfo.userEmail}`);
		}

		vscode.window.showInformationMessage(
			`BetterPSCM: Auto-detected workspace "${info.workspaceName}" on branch ${info.currentBranch}`,
		);
	}
}

async function setupProvider(context: vscode.ExtensionContext): Promise<void> {
	const wsFolder = vscode.workspace.workspaceFolders?.[0];
	if (!wsFolder) {
		log('No workspace folder open');
		return;
	}

	// cm CLI was already detected in activate(), just check availability
	const cmAvailable = isCmAvailable();

	// Setup auth: try stored credentials first, validate them, then fall back to cached SSO
	let hasCreds = await hasStoredCredentials();

	if (hasCreds) {
		try {
			const client = getClient();
			client.use(createAuthMiddleware());
			log('Auth middleware attached with stored credentials');

			// Validate stored credentials with a lightweight API call
			const valid = await validateCredentials();
			if (!valid) {
				log('Stored credentials are invalid, clearing and retrying with SSO...');
				await logout();
				hasCreds = await tryAutoLoginFromDesktopClient();
			}
		} catch (err) {
			logError('Failed to setup auth', err);
			await logout();
			hasCreds = await tryAutoLoginFromDesktopClient();
		}
	} else {
		// Try to pick up cached SSO token from Plastic desktop client
		hasCreds = await tryAutoLoginFromDesktopClient();
	}

	// Build a PlasticContext from the detected cm binary + workspace root.
	// The context is what the new ctx-aware backends and helpers consume — it's
	// the replacement for the module-level cmPath / workspaceRoot globals.
	// detectCm() ran earlier in activate() and cached the binary path; calling
	// it here returns the cached value via cmCli's early-return fast path
	// (no second probe).
	let plasticCtx: PlasticContext | undefined;
	if (cmAvailable) {
		const cmPath = await detectCm();
		if (cmPath) {
			plasticCtx = createPlasticContext({
				workspaceRoot: wsFolder.uri.fsPath,
				cmPath,
			});
		}
	}

	// Set the active backend:
	// - Hybrid (CLI + REST) when both are available — CLI for workspace ops, REST for repo ops
	// - REST-only if no CLI (unlikely but possible)
	// - CLI-only if no REST auth
	// CliBackend instances receive the context so their internal cm calls
	// route through the ctx-aware exec helpers instead of module globals.
	if (hasCreds && cmAvailable) {
		setBackend(createHybridBackend(new CliBackend(plasticCtx), new RestBackend()));
	} else if (hasCreds) {
		setBackend(new RestBackend());
	} else if (cmAvailable) {
		log('REST API auth failed — using cm CLI backend');
		setBackend(new CliBackend(plasticCtx));
	} else {
		log('No backend available — neither REST API nor cm CLI');
	}

	// Create the SCM provider — receives the context so command handlers can
	// pass it down into context-aware helpers like detectStaleChanges().
	const provider = disposables.add(
		new PlasticScmProvider(wsFolder.uri, context.workspaceState, plasticCtx),
	);

	// Register all commands
	registerStagingCommands(context, provider);
	registerCheckinCommands(context, provider);
	registerCleanStaleCommand(context, provider);
	registerGeneralCommands(context, provider);
	registerBranchCommands(context, provider);
	registerUpdateCommands(context, provider);
	registerHistoryCommands(context);
	registerMergeCommands(context, provider);
	registerLabelCommands(context);
	registerLockCommands(context);

	// Register code reviews tree view
	const codeReviewsTree = new CodeReviewsTreeProvider();
	disposables.add(codeReviewsTree);
	context.subscriptions.push(
		vscode.window.createTreeView('bpscm.codeReviewsView', {
			treeDataProvider: codeReviewsTree,
		}),
	);

	// Register review comments tree view
	const reviewCommentsTree = new ReviewCommentsTreeProvider();
	disposables.add(reviewCommentsTree);
	context.subscriptions.push(
		vscode.window.createTreeView('bpscm.reviewCommentsView', {
			treeDataProvider: reviewCommentsTree,
		}),
	);

	// Navigation controller for next/back traversal
	const navController = new ReviewNavigationController();
	disposables.add(navController);

	// Inline decorations for review comments
	const decorationProvider = new ReviewDecorationProvider();
	disposables.add(decorationProvider);

	registerCodeReviewCommands(context, codeReviewsTree, reviewCommentsTree, navController, decorationProvider, provider);

	// Register history graph in the Source Control sidebar
	const historyGraphProvider = new HistoryGraphViewProvider(context.extensionUri);
	disposables.add(historyGraphProvider);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			HistoryGraphViewProvider.viewId,
			historyGraphProvider,
		),
	);
	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.showHistoryGraph, () => {
			vscode.commands.executeCommand('bpscm.historyGraphView.focus');
		}),
	);

	// Create status bar
	const statusBar = disposables.add(new PlasticStatusBar(provider));

	// Set context key for when-clause visibility
	vscode.commands.executeCommand('setContext', 'bpscm.isActive', true);

	// Always start polling — pollStatus handles auth errors gracefully
	provider.start();

	if (!hasCreds) {
		log('No stored credentials. Polling will attempt unauthenticated requests.');
	}

	// Register MCP server definition so VS Code agents can discover it automatically
	registerMcpServerDefinition(context, wsFolder.uri.fsPath);

	// Start MCP server if enabled (for standalone stdio consumers)
	const mcpManager = disposables.add(new McpServerManager(context.extensionUri, wsFolder.uri.fsPath));
	// Refresh extension state when MCP server performs mutations (checkin, stage, undo, etc.)
	mcpManager.onStateChanged(() => provider.refresh());
	if (getConfig().mcpEnabled) {
		mcpManager.start();
	}

	// Watch for config changes
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('bpscm')) {
				log('Configuration changed, consider restarting the extension');
				if (e.affectsConfiguration('bpscm.mcp.enabled')) {
					if (getConfig().mcpEnabled) {
						mcpManager.start();
					} else {
						mcpManager.stop();
					}
				}
			}
		}),
	);
}

/**
 * Validate stored credentials by making a lightweight API call.
 * Returns true if credentials are valid.
 */
async function validateCredentials(): Promise<boolean> {
	const client = getClient();
	const repoName = getConfig().repositoryName;
	const variants = getOrgNameVariants();

	log(`Validating credentials with ${variants.length} org variants: ${variants.join(', ')}`);

	for (const orgName of variants) {
		try {
			log(`  Trying org "${orgName}"...`);
			// Use code reviews endpoint as lightweight validation (workspace endpoints
			// return 404 for locally-created workspaces that aren't cloud-registered)
			const apiCall = client.GET(
				'/api/v1/organizations/{orgName}/repos/{repoName}/codereviews' as any,
				{ params: { path: { orgName, repoName }, query: { filter: 'All' } } },
			);
			// Race against a timeout — we just need to know if creds work
			const timeout = new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error(`Validation timed out (${AUTO_LOGIN_TIMEOUT_MS / 1000}s)`)), AUTO_LOGIN_TIMEOUT_MS),
			);
			await Promise.race([apiCall, timeout]);
			setResolvedOrgName(orgName);
			log(`  Validated credentials with org "${orgName}"`);
			return true;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log(`  Org "${orgName}" failed: ${msg}`);
		}
	}
	log('All org variants failed credential validation');
	return false;
}

/**
 * Try to automatically sign in using the Unity SSO token cached by the Plastic desktop client.
 * Returns true if auto-login succeeded.
 */
/** Exported for testing — not part of public API. */
export async function tryAutoLoginFromDesktopClient(): Promise<boolean> {
	const cachedToken = detectCachedToken();
	if (!cachedToken) {
		log('No cached Unity SSO token found from desktop client');
		return false;
	}

	log(`Found cached Unity SSO token for ${cachedToken.user} (server: ${cachedToken.server})`);

	try {
		// Use the Unity SSO JWT directly as Bearer token
		await loginWithPAT(cachedToken.token);

		// Validate it actually works against the API
		const valid = await validateCredentials();
		if (valid) {
			log('Auto-login with Unity SSO token succeeded (direct Bearer)');
			vscode.window.showInformationMessage(
				`BetterPSCM: Signed in as ${cachedToken.user} (via Unity SSO)`,
			);
			return true;
		}

		// Direct Bearer didn't work, try exchanging via /login/verify
		log('Direct Bearer failed, attempting token exchange via /login/verify...');
		await logout();
		const success = await loginWithToken(cachedToken.user, cachedToken.token);
		if (success) {
			log('Auto-login via /login/verify succeeded');
			vscode.window.showInformationMessage(
				`BetterPSCM: Signed in as ${cachedToken.user} (via Unity SSO)`,
			);
		}
		return success;
	} catch (err) {
		logError('Auto-login with cached token failed', err);
		return false;
	}
}

export function deactivate(): void {
	disposables.dispose();
	resetClient();
	log('BetterPSCM extension deactivated');
}
