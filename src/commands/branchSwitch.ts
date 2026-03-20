import * as vscode from 'vscode';
import { switchBranch, fetchWorkspaceStatus, checkinFiles, undoCheckout } from '../core/workspace';
import { execCm, killActiveChildren } from '../core/cmCli';
import { log, logError } from '../util/logger';

export type SwitchResult = 'switched' | 'cancelled' | 'failed';

export interface PollingController {
	pausePolling(): void;
	resumePolling(): void;
}

/**
 * Change types that represent real pending work the user should be warned about.
 * Broader than COMMITTABLE_CHANGE_TYPES — includes checkedOut and private.
 */
const PENDING_CHANGE_TYPES = new Set([
	'added', 'changed', 'deleted', 'moved', 'replaced', 'copied',
	'locallyDeleted', 'checkedOut', 'private',
]);

let _switchInProgress = false;

/** Whether a branch switch is currently in progress. */
export function isSwitchInProgress(): boolean {
	return _switchInProgress;
}

async function classifyChanges(): Promise<{ realChangePaths: string[]; stalePaths: string[] }> {
	const realChangePaths: string[] = [];
	const stalePaths: string[] = [];
	try {
		const status = await fetchWorkspaceStatus(false);
		for (const c of status.changes) {
			if (PENDING_CHANGE_TYPES.has(c.changeType)) {
				realChangePaths.push(c.path);
			} else {
				stalePaths.push(c.path);
			}
		}
	} catch (err) {
		logError('[classifyChanges] failed to fetch workspace status', err);
	}
	return { realChangePaths, stalePaths };
}

async function cleanupStaleCheckouts(stalePaths: string[]): Promise<void> {
	if (stalePaths.length === 0) return;
	log(`[safeSwitchBranch] auto-undoing ${stalePaths.length} stale checkout(s)`);
	try {
		await undoCheckout(stalePaths);
	} catch (err) {
		log(`[safeSwitchBranch] auto-undo stale checkouts failed (non-critical): ${err instanceof Error ? err.message : String(err)}`);
	}
}

export async function safeSwitchBranch(targetBranch: string, poller?: PollingController): Promise<SwitchResult> {
	const { realChangePaths, stalePaths } = await classifyChanges();
	await cleanupStaleCheckouts(stalePaths);

	if (realChangePaths.length > 0) {
		log(`[safeSwitchBranch] ${realChangePaths.length} real change(s) detected before switching to "${targetBranch}"`);

		const picks = [
			{ label: '$(check) Check In & Switch', id: 'Check In & Switch', description: 'Commit pending changes to current branch, then switch' },
			{ label: '$(archive) Shelve & Switch', id: 'Shelve & Switch', description: 'Shelve changes (recoverable), then switch cleanly' },
			{ label: '$(arrow-swap) Switch with Changes', id: 'Switch with Changes', description: 'Carry pending changes to the target branch' },
			{ label: '$(trash) Discard & Switch', id: 'Discard & Switch', description: 'Permanently discard all changes, then switch' },
		];
		const picked = await vscode.window.showQuickPick(picks, {
			placeHolder: `You have ${realChangePaths.length} pending change(s). How do you want to handle them before switching to "${targetBranch}"?`,
			ignoreFocusOut: true,
		});
		const choice = picked?.id;

		if (choice === 'Check In & Switch') {
			const comment = await vscode.window.showInputBox({
				prompt: 'Check-in comment',
				value: `WIP: save changes before switching to ${targetBranch}`,
			});
			if (!comment) return 'cancelled';

			try {
				await vscode.window.withProgress(
					{ location: vscode.ProgressLocation.Notification, title: 'Checking in pending changes...' },
					async () => { await checkinFiles(realChangePaths, comment); },
				);
				log(`[safeSwitchBranch] checked in ${realChangePaths.length} changes`);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				vscode.window.showErrorMessage(`Check-in failed: ${msg}`);
				return 'failed';
			}
		} else if (choice === 'Shelve & Switch') {
			try {
				await vscode.window.withProgress(
					{ location: vscode.ProgressLocation.Notification, title: 'Shelving pending changes...' },
					async () => {
						const shelveResult = await execCm(['shelveset', 'save', '-c', `Auto-shelve before switching to ${targetBranch}`]);
						if (shelveResult.exitCode !== 0) {
							throw new Error(`cm shelveset save failed (exit ${shelveResult.exitCode}): ${shelveResult.stderr || shelveResult.stdout}`);
						}
						log(`[safeSwitchBranch] shelved ${realChangePaths.length} changes`);
						await undoCheckout(realChangePaths);
					},
				);
				vscode.window.showInformationMessage(`Shelved ${realChangePaths.length} change(s). Use "cm shelveset apply" to restore them later.`);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				vscode.window.showErrorMessage(`Shelve failed: ${msg}`);
				return 'failed';
			}
		} else if (choice === 'Switch with Changes') {
			log(`[safeSwitchBranch] carrying ${realChangePaths.length} pending change(s) to "${targetBranch}"`);
		} else if (choice === 'Discard & Switch') {
			const confirm = await vscode.window.showWarningMessage(
				`This will DISCARD all ${realChangePaths.length} pending change(s). This cannot be undone.`,
				{ modal: true },
				'Discard Changes',
			);
			if (confirm !== 'Discard Changes') return 'cancelled';

			try {
				await vscode.window.withProgress(
					{ location: vscode.ProgressLocation.Notification, title: 'Undoing pending changes...' },
					async () => { await undoCheckout(realChangePaths); },
				);
				log(`[safeSwitchBranch] discarded ${realChangePaths.length} changes`);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				vscode.window.showErrorMessage(`Undo failed: ${msg}`);
				return 'failed';
			}
		} else {
			return 'cancelled';
		}
	}

	_switchInProgress = true;
	poller?.pausePolling();
	try {
		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: `Switching to ${targetBranch}...`, cancellable: true },
			async (_progress, token) => {
				const switchPromise = switchBranch(targetBranch);
				const cancelPromise = new Promise<never>((_, reject) => {
					token.onCancellationRequested(() => {
						log('[safeSwitchBranch] cancelling — killing active cm processes');
						killActiveChildren();
						reject(new Error('Branch switch cancelled'));
					});
				});
				await Promise.race([switchPromise, cancelPromise]);
			},
		);
		log(`[safeSwitchBranch] switched to "${targetBranch}"`);
		return 'switched';
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		vscode.window.showErrorMessage(`Failed to switch branch: ${msg}`);
		return 'failed';
	} finally {
		_switchInProgress = false;
		poller?.resumePolling();
	}
}
