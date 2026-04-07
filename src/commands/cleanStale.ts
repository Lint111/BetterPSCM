import * as vscode from 'vscode';
import { COMMANDS } from '../constants';
import { BULK_OPERATION_THRESHOLD } from '../core/safety';
import { detectStaleChanges } from '../core/staleDetection';
import { undoCheckout } from '../core/workspace';
import { log, logError } from '../util/logger';
import type { PlasticScmProvider } from '../scm/plasticScmProvider';

/** Maximum number of file paths shown inline in the confirmation dialog. */
const PREVIEW_LIMIT = 10;

/**
 * Register the "Clean Stale Changes" command.
 *
 * Scans the current change list for files whose working copy is byte-identical
 * to the base revision (stale checkouts that cm still reports as "changed" or
 * "checkedOut") and reverts them via `cm undocheckout`.
 *
 * This is the UI counterpart to the `bpscm_clean_stale` MCP tool.
 */
export function registerCleanStaleCommand(
	context: vscode.ExtensionContext,
	provider: PlasticScmProvider,
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.cleanStale, async () => {
			const wsFolder = vscode.workspace.workspaceFolders?.[0];
			if (!wsFolder) {
				vscode.window.showWarningMessage('BetterPSCM: No workspace folder open.');
				return;
			}

			try {
				const changes = provider.getAllChanges();
				if (changes.length === 0) {
					vscode.window.showInformationMessage('BetterPSCM: No pending changes to scan.');
					return;
				}

				const result = await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.SourceControl,
						title: 'Scanning for stale changes...',
						cancellable: false,
					},
					async () => detectStaleChanges(changes, wsFolder.uri.fsPath),
				);

				const staleCount = result.stalePaths.length;
				log(
					`cleanStale: scanned ${changes.length} change(s) — ` +
					`${staleCount} stale, ${result.trulyChangedPaths.length} truly changed, ` +
					`${result.skippedPaths.length} skipped`,
				);

				if (staleCount === 0) {
					vscode.window.showInformationMessage(
						`BetterPSCM: No stale changes found. ` +
						`${result.trulyChangedPaths.length} file(s) have real changes.`,
					);
					return;
				}

				const preview = result.stalePaths.slice(0, PREVIEW_LIMIT).map(p => `  • ${p}`).join('\n');
				const more = staleCount > PREVIEW_LIMIT ? `\n  … and ${staleCount - PREVIEW_LIMIT} more` : '';
				const bulkWarning = staleCount > BULK_OPERATION_THRESHOLD
					? `\n\n⚠ Bulk operation (> ${BULK_OPERATION_THRESHOLD} files).`
					: '';

				const answer = await vscode.window.showWarningMessage(
					`Revert ${staleCount} stale file(s)? Their working copy is byte-identical to the base revision.${bulkWarning}\n\n${preview}${more}`,
					{ modal: true },
					'Revert Stale',
				);

				if (answer !== 'Revert Stale') {
					log('cleanStale: user cancelled');
					return;
				}

				log(
					`cleanStale: reverting ${staleCount} path(s). First few: ` +
					result.stalePaths.slice(0, 5).join(', '),
				);

				const reverted = await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.SourceControl,
						title: `Reverting ${staleCount} stale file(s)...`,
						cancellable: false,
					},
					async () => undoCheckout(result.stalePaths),
				);

				await provider.refresh();

				// Verify the revert actually cleared the CH markers. Plastic can exit 0
				// while leaving files in the change list if they are locked, if Unity
				// re-checked them out during the refresh, or if the workspace metadata
				// has not been re-evaluated yet.
				const stillPresent = new Set(provider.getAllChanges().map(c => c.path));
				const survivors = reverted.filter(p => stillPresent.has(p));

				if (survivors.length === 0) {
					vscode.window.showInformationMessage(
						`BetterPSCM: Reverted ${reverted.length} stale file(s).`,
					);
					return;
				}

				log(
					`cleanStale: ${survivors.length} of ${reverted.length} file(s) still appear in the change list after revert. ` +
					`First few: ${survivors.slice(0, 5).join(', ')}`,
				);
				const survivorPreview = survivors.slice(0, PREVIEW_LIMIT).map(p => `  • ${p}`).join('\n');
				const survivorMore = survivors.length > PREVIEW_LIMIT
					? `\n  … and ${survivors.length - PREVIEW_LIMIT} more`
					: '';
				vscode.window.showWarningMessage(
					`BetterPSCM: Reverted ${reverted.length} file(s), but ${survivors.length} still appear as changed. ` +
					`This usually means Unity re-checked them out, or the files are locked in another workspace. ` +
					`Check the Plastic SCM output channel for cm diagnostic output.\n\n${survivorPreview}${survivorMore}`,
					{ modal: false },
				);
			} catch (err) {
				logError('cleanStale failed', err);
				vscode.window.showErrorMessage(
					`BetterPSCM: Failed to clean stale changes — ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}),
	);
}
