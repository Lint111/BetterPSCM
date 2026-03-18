import * as vscode from 'vscode';
import { COMMANDS } from '../constants';
import { createCodeReview, listBranches, getCurrentBranch, getReviewComments, resolveRevisionPaths, getCodeReview } from '../core/workspace';
import { resolveComments } from '../core/reviewResolver';
import { CodeReviewPanel } from '../views/codeReviewPanel';
import { ReviewSnippetPanel } from '../views/reviewSnippetPanel';
import { logError } from '../util/logger';
import type { CodeReviewsTreeProvider } from '../views/codeReviewsTreeProvider';
import type { ReviewCommentsTreeProvider } from '../views/reviewCommentsTreeProvider';
import type { ReviewNavigationController } from '../providers/reviewNavigationController';
import type { ReviewDecorationProvider } from '../providers/reviewDecorationProvider';
import type { ResolvedComment } from '../core/types';

export function registerCodeReviewCommands(
	context: vscode.ExtensionContext,
	treeProvider: CodeReviewsTreeProvider,
	commentsTree: ReviewCommentsTreeProvider,
	navController: ReviewNavigationController,
	decorationProvider: ReviewDecorationProvider,
): void {
	async function navigateToComment(comment: ResolvedComment | undefined): Promise<void> {
		if (!comment) return;
		await ReviewSnippetPanel.show(comment, context.extensionUri);
	}

	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.createCodeReview, async () => {
			try {
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

		vscode.commands.registerCommand(COMMANDS.inspectReviewComments, async (commentOrReviewId: ResolvedComment | number) => {
			if (typeof commentOrReviewId === 'object' && 'filePath' in commentOrReviewId) {
				navController.goTo(commentOrReviewId);
				await navigateToComment(commentOrReviewId);
				return;
			}

			const reviewId = commentOrReviewId as number;
			try {
				await vscode.window.withProgress(
					{ location: vscode.ProgressLocation.Notification, title: 'Loading review comments...' },
					async () => {
						const comments = await getReviewComments(reviewId);
						const resolved = await resolveComments(comments, resolveRevisionPaths);
						commentsTree.setComments(resolved, `Review #${reviewId}`, reviewId);
						navController.setComments(resolved);
						decorationProvider.setComments(resolved);
						vscode.commands.executeCommand('setContext', 'plasticScm.reviewActive', true);

						if (resolved.length > 0) {
							await navigateToComment(resolved[0]);
						} else {
							vscode.window.showInformationMessage('This review has no inline comments.');
						}
					},
				);
			} catch (err) {
				logError('Failed to inspect review comments', err);
				vscode.window.showErrorMessage(`Failed to load comments: ${err instanceof Error ? err.message : String(err)}`);
			}
		}),

		vscode.commands.registerCommand(COMMANDS.nextReviewComment, async () => {
			await navigateToComment(navController.next());
		}),

		vscode.commands.registerCommand(COMMANDS.prevReviewComment, async () => {
			await navigateToComment(navController.prev());
		}),

		vscode.commands.registerCommand(COMMANDS.exportReviewAudit, async () => {
			const resolved = commentsTree.comments;
			const reviewId = commentsTree.reviewId;
			if (resolved.length === 0 || !reviewId) {
				vscode.window.showInformationMessage('No review comments to export. Inspect a review first.');
				return;
			}
			try {
				// Dynamic import — module created in Task 7 (reviewAuditExport)
				// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
				const { exportReviewAudit } = await (import('./reviewAuditExport.js' as string) as Promise<any>);
				const review = await getCodeReview(reviewId);
				await exportReviewAudit(review, [...resolved]);
			} catch (err) {
				logError('Audit export failed', err);
				vscode.window.showErrorMessage(`Audit export failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}),
	);
}
