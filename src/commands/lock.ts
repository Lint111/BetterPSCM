import * as vscode from 'vscode';
import { listLockRules, createLockRule, deleteLockRules, releaseLocks } from '../core/workspace';
import { COMMANDS } from '../constants';
import { logError } from '../util/logger';
import type { LockRuleInfo } from '../core/types';

export function registerLockCommands(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.listLockRules, async () => {
			try {
				const rules = await listLockRules();
				if (rules.length === 0) {
					vscode.window.showInformationMessage('No lock rules configured.');
					return;
				}

				const items = rules.map(r => ({
					label: r.name || r.rules,
					description: `Pattern: ${r.rules}`,
					detail: `Branch: ${r.targetBranch || 'all'}${r.excludedBranches.length ? ` (excludes: ${r.excludedBranches.join(', ')})` : ''}`,
				}));

				await vscode.window.showQuickPick(items, {
					title: 'Lock Rules',
					placeHolder: 'Current lock rules',
				});
			} catch (err) {
				logError('List lock rules failed', err);
				vscode.window.showErrorMessage(
					`Failed to list lock rules: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}),

		vscode.commands.registerCommand(COMMANDS.createLockRule, async () => {
			try {
				const name = await vscode.window.showInputBox({
					prompt: 'Lock rule name',
					placeHolder: 'Binary Assets Lock',
				});
				if (!name) return;

				const rules = await vscode.window.showInputBox({
					prompt: 'File pattern to lock (glob)',
					placeHolder: '*.psd, *.fbx, Assets/Art/**',
				});
				if (!rules) return;

				const targetBranch = await vscode.window.showInputBox({
					prompt: 'Target branch (leave empty for all branches)',
					placeHolder: '/main',
				});

				const rule: LockRuleInfo = {
					name,
					rules,
					targetBranch: targetBranch || '',
					excludedBranches: [],
					destinationBranches: [],
				};

				const created = await createLockRule(rule);
				vscode.window.showInformationMessage(`Lock rule "${created.name}" created for pattern "${created.rules}"`);
			} catch (err) {
				logError('Create lock rule failed', err);
				vscode.window.showErrorMessage(
					`Failed to create lock rule: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}),

		vscode.commands.registerCommand(COMMANDS.deleteLockRules, async () => {
			try {
				const confirm = await vscode.window.showWarningMessage(
					'Delete all lock rules for this organization?',
					{ modal: true },
					'Delete',
				);
				if (confirm !== 'Delete') return;

				await deleteLockRules();
				vscode.window.showInformationMessage('All lock rules deleted.');
			} catch (err) {
				logError('Delete lock rules failed', err);
				vscode.window.showErrorMessage(
					`Failed to delete lock rules: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}),

		vscode.commands.registerCommand(COMMANDS.releaseLocks, async () => {
			try {
				const input = await vscode.window.showInputBox({
					prompt: 'Item IDs to unlock (comma-separated)',
					placeHolder: '123, 456',
				});
				if (!input) return;

				const itemIds = input.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
				if (itemIds.length === 0) {
					vscode.window.showWarningMessage('No valid item IDs provided.');
					return;
				}

				const mode = await vscode.window.showQuickPick(
					[
						{ label: 'Release', description: 'Release locks (items remain in workspace)' },
						{ label: 'Delete', description: 'Delete locks completely' },
					],
					{ placeHolder: 'How to handle the locks?' },
				);
				if (!mode) return;

				await releaseLocks(itemIds, mode.label as 'Delete' | 'Release');
				vscode.window.showInformationMessage(`${mode.label === 'Release' ? 'Released' : 'Deleted'} ${itemIds.length} lock(s).`);
			} catch (err) {
				logError('Release locks failed', err);
				vscode.window.showErrorMessage(
					`Failed to release locks: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}),
	);
}
