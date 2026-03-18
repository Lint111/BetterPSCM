import * as vscode from 'vscode';
import {
	SCM_PROVIDER_ID,
	SCM_PROVIDER_LABEL,
	RESOURCE_GROUP_STAGED,
	RESOURCE_GROUP_STAGED_LABEL,
	RESOURCE_GROUP_CHANGES,
	RESOURCE_GROUP_CHANGES_LABEL,
	COMMANDS,
	PLASTIC_URI_SCHEME,
} from '../constants';
import { MementoStagingStore } from './mementoStagingStore';
import { PlasticService } from '../core/service';
import { getBackend } from '../core/backend';
import { PlasticQuickDiffProvider, PlasticContentProvider } from './quickDiffProvider';
import { createResourceState } from './resourceStateFactory';
import { fetchWorkspaceStatus, getCurrentBranch } from '../core/workspace';
import { getWorkspaceGuid } from '../api/client';
import { getConfig } from '../util/config';
import { AdaptivePoller } from '../util/polling';
import { log, logError, getLogger } from '../util/logger';
import { DisposableStore } from '../util/disposable';
import { AuthExpiredError, isPlasticApiError } from '../api/errors';
import type { NormalizedChange } from '../core/types';

/**
 * Main SCM provider for Plastic SCM.
 * Owns the SourceControl instance, resource groups, staging, and polling.
 */
export class PlasticScmProvider implements vscode.Disposable {
	private readonly disposables = new DisposableStore();
	private readonly sourceControl: vscode.SourceControl;
	private readonly stagedGroup: vscode.SourceControlResourceGroup;
	private readonly changesGroup: vscode.SourceControlResourceGroup;
	private readonly stagingStore: MementoStagingStore;
	private readonly service: PlasticService;
	private readonly poller: AdaptivePoller;
	private readonly contentProvider: PlasticContentProvider;
	private readonly quickDiffProvider: PlasticQuickDiffProvider;

	private currentChanges: NormalizedChange[] = [];
	private workspaceRoot: vscode.Uri;
	private errorPromptShown = false;
	private consecutiveErrors = 0;
	private currentBranch: string | undefined;

	private readonly onDidChangeStatusEmitter = new vscode.EventEmitter<void>();
	public readonly onDidChangeStatus = this.onDidChangeStatusEmitter.event;

	private readonly onDidChangeBranchEmitter = new vscode.EventEmitter<string>();
	public readonly onDidChangeBranch = this.onDidChangeBranchEmitter.event;

	constructor(
		workspaceRoot: vscode.Uri,
		memento: vscode.Memento,
	) {
		this.workspaceRoot = workspaceRoot;

		// Create SCM provider
		this.sourceControl = this.disposables.add(
			vscode.scm.createSourceControl(SCM_PROVIDER_ID, SCM_PROVIDER_LABEL, workspaceRoot),
		);
		this.sourceControl.inputBox.placeholder = 'Check-in message';
		this.sourceControl.acceptInputCommand = {
			command: COMMANDS.checkin,
			title: 'Check In Staged',
		};
		this.quickDiffProvider = new PlasticQuickDiffProvider(getWorkspaceGuid());
		this.sourceControl.quickDiffProvider = this.quickDiffProvider;

		// Create resource groups
		this.stagedGroup = this.disposables.add(
			this.sourceControl.createResourceGroup(RESOURCE_GROUP_STAGED, RESOURCE_GROUP_STAGED_LABEL),
		);
		this.changesGroup = this.disposables.add(
			this.sourceControl.createResourceGroup(RESOURCE_GROUP_CHANGES, RESOURCE_GROUP_CHANGES_LABEL),
		);

		// Initialize staging store (replaces StagingManager)
		this.stagingStore = new MementoStagingStore(memento);
		this.disposables.add(
			this.stagingStore.onDidChange(() => this.updateResourceGroups()),
		);
		this.service = new PlasticService(getBackend(), this.stagingStore);

		// Register content provider for plastic: URIs
		this.contentProvider = new PlasticContentProvider();
		this.disposables.add(
			vscode.workspace.registerTextDocumentContentProvider(PLASTIC_URI_SCHEME, this.contentProvider),
		);
		this.disposables.add(this.contentProvider);

		// Setup polling
		const config = getConfig();
		this.poller = this.disposables.add(
			new AdaptivePoller(() => this.pollStatus(), config.pollInterval),
		);

		this.disposables.add(this.onDidChangeStatusEmitter);
		this.disposables.add(this.onDidChangeBranchEmitter);
	}

	/**
	 * Start polling for workspace status.
	 */
	start(): void {
		log('SCM provider started');
		this.poller.start();
		// Do an immediate poll
		this.pollStatus().catch(err => logError('Initial poll failed', err));
	}

	/**
	 * Get the shared PlasticService instance.
	 */
	getService(): PlasticService {
		return this.service;
	}

	/**
	 * Get all current changes (both staged and unstaged).
	 */
	getAllChanges(): NormalizedChange[] {
		return this.currentChanges;
	}

	/**
	 * Get the SourceControl input box value (commit message).
	 */
	getInputBoxValue(): string {
		return this.sourceControl.inputBox.value;
	}

	/**
	 * Clear the input box after a successful checkin.
	 */
	clearInputBox(): void {
		this.sourceControl.inputBox.value = '';
	}

	/**
	 * Get the count of pending changes.
	 */
	getPendingCount(): number {
		return this.currentChanges.length;
	}

	/**
	 * Get the count of staged changes.
	 */
	getStagedCount(): number {
		return this.currentChanges.filter(c => this.stagingStore.has(c.path)).length;
	}

	/**
	 * Get the current branch name (undefined until first successful poll).
	 */
	getCurrentBranchName(): string | undefined {
		return this.currentBranch;
	}

	/**
	 * Force a refresh of workspace status.
	 */
	async refresh(): Promise<void> {
		await this.pollStatus();
	}

	private async pollStatus(): Promise<void> {
		try {
			const config = getConfig();
			const result = await fetchWorkspaceStatus(config.showPrivateFiles);

			// Successful poll — reset error state
			this.consecutiveErrors = 0;
			if (this.errorPromptShown) {
				this.errorPromptShown = false;
				this.sourceControl.inputBox.placeholder = 'Check-in message';
			}

			const oldCount = this.currentChanges.length;
			this.currentChanges = result.changes;

			// Update quick diff provider with latest changes
			this.quickDiffProvider.updateChanges(this.currentChanges, this.workspaceRoot.fsPath);

			// Prune stale staged paths (sync, using already-fetched currentChanges)
			const currentPaths = new Set(this.currentChanges.map(c => c.path));
			const stale = [...this.stagingStore.getAll()].filter(p => !currentPaths.has(p));
			if (stale.length > 0) this.stagingStore.remove(stale);

			// Update resource groups
			this.updateResourceGroups();

			// Notify poller if changes detected
			if (this.currentChanges.length !== oldCount) {
				this.poller.notifyChange();
			}

			this.onDidChangeStatusEmitter.fire();

			// Poll branch
			try {
				const branch = await getCurrentBranch();
				if (branch !== undefined && branch !== this.currentBranch) {
					this.currentBranch = branch;
					this.onDidChangeBranchEmitter.fire(branch);
				}
			} catch (branchErr) {
				logError('Branch poll failed (non-critical)', branchErr);
			}
		} catch (err) {
			this.consecutiveErrors++;
			logError('Status poll failed', err);

			if (this.errorPromptShown) return;
			this.errorPromptShown = true;

			if (err instanceof AuthExpiredError || isPlasticApiError(err) && err.statusCode === 401) {
				this.sourceControl.inputBox.placeholder =
					'Sign in to Plastic SCM to see changes';
				vscode.window.showWarningMessage(
					'Plastic SCM: Authentication required to fetch workspace changes.',
					'Sign In',
				).then(action => {
					if (action === 'Sign In') {
						vscode.commands.executeCommand(COMMANDS.login);
					}
				});
			} else {
				const errMsg = err instanceof Error ? err.message : String(err);
				this.sourceControl.inputBox.placeholder =
					'Unable to connect to Plastic SCM server';
				vscode.window.showErrorMessage(
					`Plastic SCM: Failed to connect — ${errMsg}`,
					'View Output',
				).then(action => {
					if (action === 'View Output') {
						getLogger().show?.();
					}
				});
			}
		}
	}

	private updateResourceGroups(): void {
		const staged: NormalizedChange[] = [];
		const unstaged: NormalizedChange[] = [];
		for (const c of this.currentChanges) {
			if (this.stagingStore.has(c.path)) {
				staged.push(c);
			} else {
				unstaged.push(c);
			}
		}

		this.stagedGroup.resourceStates = staged.map(c =>
			createResourceState(c, this.workspaceRoot),
		);
		this.changesGroup.resourceStates = unstaged.map(c =>
			createResourceState(c, this.workspaceRoot),
		);

		// Update count badge
		this.sourceControl.count = this.currentChanges.length;
	}

	dispose(): void {
		this.disposables.dispose();
	}
}
