import * as vscode from 'vscode';
import { listBranches, getCurrentBranch, checkMergeAllowed, executeMerge } from '../core/workspace';
import { COMMANDS } from '../constants';
import { logError } from '../util/logger';
import type { PlasticScmProvider } from '../scm/plasticScmProvider';

export function registerMergeCommands(
	context: vscode.ExtensionContext,
	provider: PlasticScmProvider,
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.mergeTo, async () => {
			try {
				const [branches, current] = await Promise.all([
					listBranches(),
					getCurrentBranch(),
				]);

				if (!current) {
					vscode.window.showWarningMessage('Cannot determine current branch');
					return;
				}

				// Pick source branch (default: current)
				const sourceItems = branches.map(b => ({
					label: b.name,
					description: b.name === current ? '(current)' : b.owner,
				}));

				const sourcePick = await vscode.window.showQuickPick(sourceItems, {
					placeHolder: 'Source branch to merge FROM',
				});
				if (!sourcePick) return;

				// Pick target branch (exclude source)
				const targetItems = branches
					.filter(b => b.name !== sourcePick.label)
					.map(b => ({
						label: b.name,
						description: b.name === current ? '(current)' : b.owner,
					}));

				const targetPick = await vscode.window.showQuickPick(targetItems, {
					placeHolder: 'Target branch to merge INTO',
				});
				if (!targetPick) return;

				// Check merge feasibility
				const report = await vscode.window.withProgress({
					location: vscode.ProgressLocation.Notification,
					title: 'Checking merge...',
					cancellable: false,
				}, () => checkMergeAllowed(sourcePick.label, targetPick.label));

				if (!report.canMerge) {
					const msg = report.conflicts.length > 0
						? `Merge has ${report.conflicts.length} conflict(s):\n${report.conflicts.slice(0, 5).join('\n')}`
						: report.message ?? 'Merge is not allowed';
					const proceed = await vscode.window.showWarningMessage(
						msg,
						{ modal: true },
						'Merge Anyway',
					);
					if (proceed !== 'Merge Anyway') return;
				}

				// Optional merge comment
				const comment = await vscode.window.showInputBox({
					prompt: 'Merge comment (optional)',
					placeHolder: `Merge ${sourcePick.label} → ${targetPick.label}`,
				});

				// Execute merge
				const result = await vscode.window.withProgress({
					location: vscode.ProgressLocation.Notification,
					title: `Merging ${sourcePick.label} → ${targetPick.label}...`,
					cancellable: false,
				}, () => executeMerge(
					sourcePick.label,
					targetPick.label,
					comment || `Merge ${sourcePick.label} → ${targetPick.label}`,
				));

				if (result.conflicts.length > 0) {
					vscode.window.showWarningMessage(
						`Merge completed with ${result.conflicts.length} conflict(s). Resolve them manually.`,
					);
				} else {
					vscode.window.showInformationMessage(
						`Merged ${sourcePick.label} → ${targetPick.label}` +
						(result.changesetId ? ` (cs:${result.changesetId})` : ''),
					);
				}

				await provider.refresh();
			} catch (err) {
				logError('Merge failed', err);
				vscode.window.showErrorMessage(
					`Merge failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}),
	);
}
