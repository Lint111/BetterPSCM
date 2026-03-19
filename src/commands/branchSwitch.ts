import * as vscode from 'vscode';
import { switchBranch, fetchWorkspaceStatus, checkinFiles, undoCheckout } from '../core/workspace';
import { isCommittableChange } from '../core/safety';
import { log } from '../util/logger';

/**
 * Result of a safe branch switch attempt.
 */
export type SwitchResult = 'switched' | 'cancelled' | 'failed';

/** Interface for pausing/resuming the status poller during switch. */
export interface PollingController {
	pausePolling(): void;
	resumePolling(): void;
}

/**
 * Safely switch to a target branch, handling pending changes first.
 *
 * - Stale checkouts (checked out but not modified) are auto-undone silently.
 * - Real changes prompt the user to check in or discard before switching.
 * - Status polling is paused during the switch to avoid showing intermediate states.
 *
 * Shared by all branch-switching flows (branch command, code review, etc.)
 */
export async function safeSwitchBranch(targetBranch: string, poller?: PollingController): Promise<SwitchResult> {
	// Check for pending changes
	let realChangePaths: string[] = [];
	let stalePaths: string[] = [];
	try {
		const status = await fetchWorkspaceStatus(false);
		for (const c of status.changes) {
			if (isCommittableChange(c.changeType)) {
				realChangePaths.push(c.path);
			} else {
				stalePaths.push(c.path);
			}
		}
	} catch {
		// Non-critical — proceed with switch attempt
	}

	// Auto-undo stale checkouts (no real modifications, safe to undo)
	if (stalePaths.length > 0) {
		log(`[safeSwitchBranch] auto-undoing ${stalePaths.length} stale checkout(s)`);
		try {
			await undoCheckout(stalePaths);
		} catch (err) {
			log(`[safeSwitchBranch] auto-undo stale checkouts failed (non-critical): ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// Handle real changes
	if (realChangePaths.length > 0) {
		log(`[safeSwitchBranch] ${realChangePaths.length} real change(s) detected before switching to "${targetBranch}"`);

		const choice = await vscode.window.showWarningMessage(
			`You have ${realChangePaths.length} pending change(s). How do you want to handle them before switching to "${targetBranch}"?`,
			{ modal: true },
			'Check In & Switch',
			'Discard & Switch',
		);

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

	// Pause polling during switch to avoid showing intermediate file states
	poller?.pausePolling();
	try {
		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: `Switching to ${targetBranch}...`, cancellable: true },
			async (_progress, token) => {
				const switchPromise = switchBranch(targetBranch);
				const cancelPromise = new Promise<never>((_, reject) => {
					token.onCancellationRequested(() => reject(new Error('Branch switch cancelled')));
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
		poller?.resumePolling();
	}
}
