import * as vscode from 'vscode';
import { COMMANDS } from '../constants';
import { BULK_OPERATION_THRESHOLD } from '../core/safety';
import { detectStaleChanges } from '../core/staleDetection';
import {
	classifyDestructiveFiles,
	executeDestructiveRevert,
	AuditLogger,
} from '../core/destructiveOps';
import { getBackend } from '../core/backend';
import { getCurrentBranch } from '../core/workspace';
import { log, logError } from '../util/logger';
import type { PlasticScmProvider } from '../scm/plasticScmProvider';

/** Maximum number of file paths shown inline in the confirmation dialog. */
const PREVIEW_LIMIT = 10;

/** Maximum number of Unity-critical paths shown inline in the critical warning
 *  section of the confirmation dialog. Smaller than the stale-files preview
 *  because critical files are a subset and the warning is a sidebar note. */
const CRITICAL_PREVIEW_LIMIT = 5;

/** Number of paths shown inline in log lines (for grep-ability in the output channel). */
const LOG_SAMPLE_SIZE = 5;

/** Label of the destructive confirmation button. Kept as a const so the
 *  button label and the `answer === …` check cannot drift out of sync. */
const REVERT_ACTION_LABEL = 'Revert Stale';

/**
 * Adapter that routes destructive-op audit entries to the extension's
 * standard Plastic SCM output channel. Mirrors the MCP server's stderr JSON
 * audit sink — same event names, different transport.
 */
const extensionAuditLogger: AuditLogger = {
	log(action, details): void {
		if (details && Object.keys(details).length > 0) {
			log(`[audit] ${action} ${JSON.stringify(details)}`);
		} else {
			log(`[audit] ${action}`);
		}
	},
};

/**
 * Register the "Clean Stale Changes" command.
 *
 * Scans the current change list for files whose working copy is byte-identical
 * to the base revision (stale checkouts that cm still reports as "changed" or
 * "checkedOut") and reverts them via the shared destructive-ops layer, which
 * provides backup, audit logging, and Unity-critical file warnings.
 *
 * This is the UI counterpart to the `bpscm_clean_stale` MCP tool; both go
 * through `executeDestructiveRevert` so their safety posture stays in sync.
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

				// Phase 1: scan the change list for stale files via SHA-256 comparison.
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

				// Phase 2: classify via the shared destructive-ops layer, then build
				// the confirmation dialog. The classification is pure — no I/O —
				// so computing it twice (once here for the dialog, once inside
				// executeDestructiveRevert) is negligible.
				const classification = classifyDestructiveFiles(result.stalePaths);

				const preview = result.stalePaths.slice(0, PREVIEW_LIMIT).map(p => `  • ${p}`).join('\n');
				const more = staleCount > PREVIEW_LIMIT ? `\n  … and ${staleCount - PREVIEW_LIMIT} more` : '';
				const bulkWarning = classification.requiresBulkConfirmation
					? `\n\n⚠ Bulk operation (> ${BULK_OPERATION_THRESHOLD} files).`
					: '';
				const criticalWarning = classification.criticalFiles.length > 0
					? `\n\n⚠ ${classification.criticalFiles.length} Unity-critical file(s) will be reverted: ` +
					  classification.criticalFiles.slice(0, CRITICAL_PREVIEW_LIMIT).join(', ') +
					  (classification.criticalFiles.length > CRITICAL_PREVIEW_LIMIT ? `, …` : '')
					: '';

				const answer = await vscode.window.showWarningMessage(
					`Revert ${staleCount} stale file(s)? Their working copy is byte-identical to the base revision.${bulkWarning}${criticalWarning}\n\n${preview}${more}`,
					{ modal: true },
					REVERT_ACTION_LABEL,
				);

				if (answer !== REVERT_ACTION_LABEL) {
					log('cleanStale: user cancelled');
					return;
				}

				log(
					`cleanStale: reverting ${staleCount} path(s). First few: ` +
					result.stalePaths.slice(0, LOG_SAMPLE_SIZE).join(', '),
				);

				// Phase 3: execute via shared destructive-ops layer. The bulk guard
				// is NOT enforced here because the user has already confirmed via
				// the modal dialog above. Backup runs automatically.
				const workspaceName = (await getCurrentBranch().catch(() => undefined)) || 'unknown-workspace';
				// O(n+m) change-type lookup: precompute the stale set once instead
				// of calling Array.includes() inside the loop.
				const stalePathSet = new Set(result.stalePaths);
				const changeTypeByPath = new Map<string, string>();
				for (const change of changes) {
					if (stalePathSet.has(change.path)) {
						changeTypeByPath.set(change.path, change.changeType);
					}
				}

				const revertResult = await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.SourceControl,
						title: `Reverting ${staleCount} stale file(s)...`,
						cancellable: false,
					},
					async () => executeDestructiveRevert({
						tool: 'clean_stale',
						files: result.stalePaths,
						backend: getBackend(),
						workspaceRoot: wsFolder.uri.fsPath,
						workspaceName,
						changeTypeByPath,
						audit: extensionAuditLogger,
					}),
				);

				await provider.refresh();

				// Verify the revert actually cleared the CH markers. Plastic can exit 0
				// while leaving files in the change list if they are locked, if Unity
				// re-checked them out during the refresh, or if the workspace metadata
				// has not been re-evaluated yet.
				const stillPresent = new Set(provider.getAllChanges().map(c => c.path));
				const survivors = revertResult.reverted.filter(p => stillPresent.has(p));

				const backupNote = revertResult.backupPath
					? `\n\nBackup: ${revertResult.backupPath}`
					: '';
				const reimportNote = revertResult.unityReimportWarning
					? `\n\n${revertResult.unityReimportWarning}`
					: '';

				if (survivors.length === 0) {
					vscode.window.showInformationMessage(
						`BetterPSCM: Reverted ${revertResult.reverted.length} stale file(s).${backupNote}${reimportNote}`,
					);
					return;
				}

				log(
					`cleanStale: ${survivors.length} of ${revertResult.reverted.length} file(s) still appear in the change list after revert. ` +
					`First few: ${survivors.slice(0, LOG_SAMPLE_SIZE).join(', ')}`,
				);
				const survivorPreview = survivors.slice(0, PREVIEW_LIMIT).map(p => `  • ${p}`).join('\n');
				const survivorMore = survivors.length > PREVIEW_LIMIT
					? `\n  … and ${survivors.length - PREVIEW_LIMIT} more`
					: '';
				vscode.window.showWarningMessage(
					`BetterPSCM: Reverted ${revertResult.reverted.length} file(s), but ${survivors.length} still appear as changed. ` +
					`This usually means Unity re-checked them out, or the files are locked in another workspace. ` +
					`Check the Plastic SCM output channel for cm diagnostic output.${backupNote}\n\n${survivorPreview}${survivorMore}`,
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
