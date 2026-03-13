import * as vscode from 'vscode';
import { COMMANDS } from '../constants';
import { createCodeReview, listBranches, getCurrentBranch } from '../core/workspace';
import { CodeReviewPanel } from '../views/codeReviewPanel';
import { logError } from '../util/logger';
import type { CodeReviewsTreeProvider } from '../views/codeReviewsTreeProvider';

export function registerCodeReviewCommands(
	context: vscode.ExtensionContext,
	treeProvider: CodeReviewsTreeProvider,
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.createCodeReview, async () => {
			try {
				// Pick a branch to review
				const branches = await listBranches();
				const current = await getCurrentBranch();

				const items = branches.map(b => ({
					label: b.name,
					description: b.name === current ? '(current)' : b.owner,
					branchId: b.id,
				}));

				const picked = await vscode.window.showQuickPick(items, {
					placeHolder: 'Select branch to review',
					title: 'Create Code Review',
				});
				if (!picked) return;

				const title = await vscode.window.showInputBox({
					prompt: 'Review title',
					value: `Review: ${picked.label}`,
				});
				if (!title) return;

				await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: 'Creating code review...',
					},
					async () => {
						const review = await createCodeReview({
							title,
							targetType: 'Branch',
							targetId: picked.branchId,
							targetSpec: picked.label,
						});

						vscode.window.showInformationMessage(`Created review #${review.id}: ${review.title}`);
						treeProvider.refresh();
						CodeReviewPanel.open(review.id, context.extensionUri);
					},
				);
			} catch (err) {
				logError('Create code review failed', err);
				vscode.window.showErrorMessage(
					`Failed to create review: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}),

		vscode.commands.registerCommand(COMMANDS.openCodeReview, (reviewId: number) => {
			CodeReviewPanel.open(reviewId, context.extensionUri);
		}),
	);
}
