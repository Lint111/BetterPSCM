#!/usr/bin/env node
/**
 * Plastic SCM MCP Server — standalone process for AI agent integration.
 *
 * Provides 19 tools, 3 resources, and 2 prompts over stdio transport.
 * Uses the cm CLI backend directly (no vscode dependency).
 *
 * Usage:
 *   node dist/mcp-server.js --workspace /path/to/plastic/workspace
 *
 * Or via VS Code extension when plasticScm.mcp.enabled = true.
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { setCmWorkspaceRoot, detectCm, isCmAvailable, getCmWorkspaceRoot } from '../core/cmCli';
import { CliBackend } from '../core/backendCli';
import { setBackend, getBackend } from '../core/backend';
import type { PlasticBackend } from '../core/backend';
import { createBackup, listBackups, getBackupManifest, restoreBackup } from './backup';
import { PlasticService } from '../core/service';
import { InMemoryStagingStore } from '../core/stagingStore';
import { BULK_OPERATION_THRESHOLD, UNITY_CRITICAL_EXTENSIONS } from '../core/safety';
import { resolveConfig } from '../util/configResolver';
import { initDetectedConfig } from '../util/config';
import { detectWorkspace, detectCachedToken } from '../util/plasticDetector';
import { getClient, setOrgNameHints } from '../api/client';
import { HybridBackend } from '../core/backendHybrid';
import { RestBackend } from '../core/backendRest';
import { buildReviewAudit } from './reviewAudit.js';

// ── Standalone logger (stderr, no vscode) ────────────────────────────

// The cm CLI modules import ../util/logger which depends on vscode.
// We monkey-patch the logger module at the module level so the CLI backend
// works without vscode. This is safe because the MCP server is a separate
// process that never loads the vscode module.

// ── Parse CLI args ───────────────────────────────────────────────────

function parseArgs(): { workspace: string } {
	const args = process.argv.slice(2);
	let workspace = process.cwd();
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--workspace' && args[i + 1]) {
			workspace = args[i + 1];
			i++;
		}
	}
	return { workspace };
}

// ── Server setup ─────────────────────────────────────────────────────

const server = new McpServer({
	name: 'plastic-scm',
	version: '0.1.0',
});

// ── Helper ───────────────────────────────────────────────────────────

function backend(): PlasticBackend {
	return getBackend();
}

const store = new InMemoryStagingStore();
let service: PlasticService;

function getService(): PlasticService {
	if (!service) {
		service = new PlasticService(backend(), store);
	}
	return service;
}

function textResult(text: string) {
	return { content: [{ type: 'text' as const, text }] };
}

function jsonResult(data: unknown) {
	return textResult(JSON.stringify(data, null, 2));
}

function errorResult(msg: string) {
	return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true as const };
}

// ── Audit logging ────────────────────────────────────────────────────
// All destructive operations are logged to stderr for post-mortem analysis.

function audit(tool: string, action: string, details?: Record<string, unknown>) {
	const entry = {
		timestamp: new Date().toISOString(),
		tool,
		action,
		...details,
	};
	process.stderr.write(`[AUDIT] ${JSON.stringify(entry)}\n`);
}

// ── Tools ────────────────────────────────────────────────────────────

// 1. plastic_status — List pending workspace changes
server.registerTool(
	'plastic_status',
	{
		title: 'Workspace Status',
		description: 'List pending changes in the Plastic SCM workspace. Returns file paths, change types, staged status, and flags checkouts with no content modifications as potentially stale.',
		inputSchema: z.object({
			showPrivate: z.boolean().optional().describe('Include unversioned files (default: true)'),
		}),
	},
	async ({ showPrivate }) => {
		try {
			const result = await backend().getStatus(showPrivate ?? true);

			// Detect stale checkouts: files marked as 'checkedOut' often have no real content changes.
			// We flag them so the caller can decide to undo checkout before committing.
			const changes = result.changes.map(c => ({
				path: c.path,
				type: c.changeType,
				staged: getService().isStaged(c.path),
				// 'checkedOut' (CO) means the file was opened for editing but may have no actual modifications.
				// This is distinct from 'changed' (CH) which indicates real content differences.
				possiblyStale: c.changeType === 'checkedOut',
			}));
			return jsonResult({ branch: await backend().getCurrentBranch(), changes });
		} catch (err) {
			return errorResult(err instanceof Error ? err.message : String(err));
		}
	},
);

// 2. plastic_stage — Stage files for checkin
server.registerTool(
	'plastic_stage',
	{
		title: 'Stage Files',
		description: 'Stage one or more files for the next checkin. Supports exact file paths and directory prefixes (e.g. "Assets/Data" stages all pending files under that directory).',
		inputSchema: z.object({
			paths: z.array(z.string()).describe('File paths or directory prefixes to stage. Directory prefixes match all pending files under that path.'),
		}),
	},
	async ({ paths }) => {
		try {
			// Keep directory-prefix resolution in MCP layer (stage handler has this extra UX)
			const status = await backend().getStatus(true);
			const pendingPaths = status.changes.map(c => c.path);
			const resolved: string[] = [];

			for (const p of paths) {
				const normalized = p.replace(/\\/g, '/').replace(/\/$/, '');
				if (pendingPaths.includes(normalized) || pendingPaths.includes(p)) {
					resolved.push(pendingPaths.includes(normalized) ? normalized : p);
					continue;
				}
				const prefix = normalized.endsWith('/') ? normalized : normalized + '/';
				let matchedAny = false;
				for (const pending of pendingPaths) {
					const normalizedPending = pending.replace(/\\/g, '/');
					if (normalizedPending.startsWith(prefix) || normalizedPending.toLowerCase().startsWith(prefix.toLowerCase())) {
						resolved.push(pending);
						matchedAny = true;
					}
				}
				if (!matchedAny) resolved.push(p);
			}

			await getService().stage(resolved, { autoMeta: false });
			return textResult(`Staged ${resolved.length} file(s). Total staged: ${getService().getStagedPaths().length}`);
		} catch (err) {
			return errorResult(err instanceof Error ? err.message : String(err));
		}
	},
);

// 3. plastic_unstage — Unstage files
server.registerTool(
	'plastic_unstage',
	{
		title: 'Unstage Files',
		description: 'Remove files from the staging area.',
		inputSchema: z.object({
			paths: z.array(z.string()).describe('File paths to unstage'),
		}),
	},
	async ({ paths }) => {
		await getService().unstage(paths);
		return textResult(`Unstaged ${paths.length} file(s). Total staged: ${getService().getStagedPaths().length}`);
	},
);

// 4. plastic_checkin — Commit staged files
server.registerTool(
	'plastic_checkin',
	{
		title: 'Check In',
		description: `Check in (commit) staged files with a comment. If no files are staged, checks in all pending changes.

SMART HANDLING:
- auto_add_private=true (default): Automatically runs 'cm add' on any PR (private/untracked) files in the staged set before committing. This eliminates the common friction where new files can't be checked in because they were never added to source control.
- Auto-filters stale CO (checked-out but unchanged) files.
- Use exclude_paths to skip specific files.`,
		inputSchema: z.object({
			comment: z.string().describe('Checkin comment'),
			all: z.boolean().optional().describe('Check in all changes, ignoring staging (default: false)'),
			exclude_paths: z.array(z.string()).optional().describe('File paths to exclude from this checkin'),
			auto_add_private: z.boolean().optional().describe('Automatically add private (PR) files to source control before checking in. Essential for new files. (default: true)'),
		}),
	},
	async ({ comment, all, exclude_paths, auto_add_private }) => {
		try {
			audit('plastic_checkin', 'invoked', { all, excludeCount: exclude_paths?.length ?? 0, auto_add_private });
			const result = await getService().checkin({
				comment,
				all,
				excludePaths: exclude_paths,
				autoAddPrivate: auto_add_private,
			});

			audit('plastic_checkin', 'completed', {
				changesetId: result.changesetId,
				autoAdded: result.autoAdded.length,
				autoExcluded: result.autoExcluded.length,
			});

			const response: Record<string, unknown> = {
				changesetId: result.changesetId,
				branch: result.branchName,
			};
			if (result.autoAdded.length > 0) {
				response.autoAddedToSourceControl = result.autoAdded;
				response.autoAddNote = `${result.autoAdded.length} private file(s) were automatically added to source control before checkin.`;
			}
			if (result.autoExcluded.length > 0) {
				response.autoExcludedStale = result.autoExcluded;
				response.note = `${result.autoExcluded.length} unchanged item(s) were auto-excluded. Use plastic_clean_stale to clear stale checkouts.`;
			}
			return jsonResult(response);
		} catch (err) {
			audit('plastic_checkin', 'error', { error: err instanceof Error ? err.message : String(err) });
			return errorResult(err instanceof Error ? err.message : String(err));
		}
	},
);

// 5. plastic_diff — Show changeset diff
server.registerTool(
	'plastic_diff',
	{
		title: 'Changeset Diff',
		description: 'List files changed in a specific changeset compared to its parent.',
		inputSchema: z.object({
			changesetId: z.number().describe('Changeset ID'),
			parentId: z.number().describe('Parent changeset ID'),
		}),
	},
	async ({ changesetId, parentId }) => {
		try {
			const diff = await backend().getChangesetDiff(changesetId, parentId);
			return jsonResult(diff);
		} catch (err) {
			return errorResult(err instanceof Error ? err.message : String(err));
		}
	},
);

// 6. plastic_file_diff — Get file content at a revision
server.registerTool(
	'plastic_file_diff',
	{
		title: 'File Content at Revision',
		description: 'Retrieve file content at a specific revision for diffing.',
		inputSchema: z.object({
			revSpec: z.string().describe('Revision spec (e.g. "revid:123" or "serverpath:/path#cs:42")'),
		}),
	},
	async ({ revSpec }) => {
		try {
			const content = await backend().getFileContent(revSpec);
			if (!content) return errorResult('File not found at revision');
			return textResult(new TextDecoder().decode(content));
		} catch (err) {
			return errorResult(err instanceof Error ? err.message : String(err));
		}
	},
);

// 7. plastic_branches — List branches
server.registerTool(
	'plastic_branches',
	{
		title: 'List Branches',
		description: 'List all branches in the repository.',
		inputSchema: z.object({}),
	},
	async () => {
		try {
			const branches = await backend().listBranches();
			const current = await backend().getCurrentBranch();
			return jsonResult({ currentBranch: current, branches });
		} catch (err) {
			return errorResult(err instanceof Error ? err.message : String(err));
		}
	},
);

// 8. plastic_create_branch — Create a new branch
server.registerTool(
	'plastic_create_branch',
	{
		title: 'Create Branch',
		description: 'Create a new branch from the current changeset.',
		inputSchema: z.object({
			name: z.string().describe('Branch name'),
			comment: z.string().optional().describe('Branch comment'),
		}),
	},
	async ({ name, comment }) => {
		try {
			const branch = await backend().createBranch(name, comment);
			return jsonResult(branch);
		} catch (err) {
			return errorResult(err instanceof Error ? err.message : String(err));
		}
	},
);

// 9. plastic_switch_branch — Switch to a branch
server.registerTool(
	'plastic_switch_branch',
	{
		title: 'Switch Branch',
		description: 'Switch the workspace to a different branch.',
		inputSchema: z.object({
			branchName: z.string().describe('Full branch name (e.g. /main/feature)'),
		}),
	},
	async ({ branchName }) => {
		try {
			await backend().switchBranch(branchName);
			return textResult(`Switched to branch "${branchName}"`);
		} catch (err) {
			return errorResult(err instanceof Error ? err.message : String(err));
		}
	},
);

// 10. plastic_file_history — Show file revision history
server.registerTool(
	'plastic_file_history',
	{
		title: 'File History',
		description: 'Show the revision history for a specific file.',
		inputSchema: z.object({
			path: z.string().describe('File path'),
		}),
	},
	async ({ path }) => {
		try {
			const history = await backend().getFileHistory(path);
			return jsonResult(history);
		} catch (err) {
			return errorResult(err instanceof Error ? err.message : String(err));
		}
	},
);

// 11. plastic_annotate — Blame/annotate a file
server.registerTool(
	'plastic_annotate',
	{
		title: 'Annotate (Blame)',
		description: 'Show line-by-line blame information for a file.',
		inputSchema: z.object({
			path: z.string().describe('File path'),
		}),
	},
	async ({ path }) => {
		try {
			const blame = await backend().getBlame(path);
			const lines = blame.map(l =>
				`${String(l.lineNumber).padStart(4)} | cs:${String(l.changesetId).padStart(5)} | ${l.author.padEnd(20)} | ${l.content}`,
			);
			return textResult(lines.join('\n'));
		} catch (err) {
			return errorResult(err instanceof Error ? err.message : String(err));
		}
	},
);

// 12. plastic_merge — Merge branches
server.registerTool(
	'plastic_merge',
	{
		title: 'Merge Branches',
		description: 'Merge a source branch into a target branch. Use preview=true to check for conflicts without merging.',
		inputSchema: z.object({
			sourceBranch: z.string().describe('Source branch name'),
			targetBranch: z.string().describe('Target branch name'),
			comment: z.string().optional().describe('Merge comment'),
			preview: z.boolean().optional().describe('Only preview, do not execute (default: false)'),
		}),
	},
	async ({ sourceBranch, targetBranch, comment, preview }) => {
		try {
			if (preview) {
				const report = await backend().checkMergeAllowed(sourceBranch, targetBranch);
				return jsonResult(report);
			}
			const result = await backend().executeMerge(sourceBranch, targetBranch, comment);
			return jsonResult(result);
		} catch (err) {
			return errorResult(err instanceof Error ? err.message : String(err));
		}
	},
);

// 13. plastic_create_review — Create a code review
server.registerTool(
	'plastic_create_review',
	{
		title: 'Create Code Review',
		description: 'Create a code review for a branch, changeset, or label.',
		inputSchema: z.object({
			title: z.string().describe('Review title'),
			targetType: z.enum(['Branch', 'Changeset', 'Label']).describe('What to review'),
			targetId: z.number().describe('ID of the target (branch/changeset/label)'),
			description: z.string().optional(),
			reviewers: z.array(z.string()).optional().describe('Reviewer usernames'),
		}),
	},
	async ({ title, targetType, targetId, description, reviewers }) => {
		try {
			const review = await backend().createCodeReview({
				title, targetType, targetId, description, reviewers,
			});
			return jsonResult(review);
		} catch (err) {
			return errorResult(err instanceof Error ? err.message : String(err));
		}
	},
);

// 14. plastic_list_reviews — List code reviews
server.registerTool(
	'plastic_list_reviews',
	{
		title: 'List Code Reviews',
		description: 'List code reviews with optional filter.',
		inputSchema: z.object({
			filter: z.enum(['all', 'assignedToMe', 'createdByMe', 'pending']).optional()
				.describe('Filter reviews (default: all)'),
		}),
	},
	async ({ filter }) => {
		try {
			const reviews = await backend().listCodeReviews(filter ?? 'all');
			return jsonResult(reviews);
		} catch (err) {
			return errorResult(err instanceof Error ? err.message : String(err));
		}
	},
);

// 15. plastic_get_review_audit — Full review audit with resolved comments
server.registerTool(
	'plastic_get_review_audit',
	{
		title: 'Get Code Review Audit',
		description: `Get a code review's full audit log: review metadata plus all comments with resolved file paths and line numbers, grouped by file.

Provide either reviewId (direct lookup) or branch (finds first review targeting that branch). Requires hybrid backend (auto-detected from Plastic desktop client SSO token).`,
		inputSchema: z.object({
			reviewId: z.number().optional().describe('Review ID for direct lookup'),
			branch: z.string().optional().describe('Branch name — finds the first review targeting this branch'),
		}),
	},
	async ({ reviewId, branch }) => {
		try {
			const result = await buildReviewAudit({ reviewId, branch });
			return jsonResult(result);
		} catch (err) {
			if (err instanceof Error && err.name === 'NotSupportedError') {
				return errorResult('Review comments require REST API. Sign in to the Plastic desktop client so the SSO token can be auto-detected.');
			}
			return errorResult(err instanceof Error ? err.message : String(err));
		}
	},
);

// 16. plastic_add — Add private files to source control
server.registerTool(
	'plastic_add',
	{
		title: 'Add Files to Source Control',
		description: `Add private (untracked) files to Plastic SCM source control. Private files (PR) exist on disk but are not tracked — they CANNOT be checked in until added.

This is the missing step when new files are created: they start as PR, must be added (→ AD), then checked in.

Supports exact file paths and directory prefixes (e.g. "Assets/Scripts/AbilityChain" adds all private files under that directory). Also supports auto_add_meta=true to automatically include companion .meta files.`,
		inputSchema: z.object({
			paths: z.array(z.string()).describe('File paths or directory prefixes to add. Directory prefixes match all private files under that path.'),
			auto_add_meta: z.boolean().optional().describe('Automatically include .meta companion files for any matched file. Essential for Unity projects. (default: true)'),
		}),
	},
	async ({ paths, auto_add_meta }) => {
		try {
			audit('plastic_add', 'invoked', { pathCount: paths.length, auto_add_meta });
			const added = await getService().addToSourceControl(paths, { autoMeta: auto_add_meta !== false });
			if (added.length === 0) {
				return errorResult(
					'No private (PR) files matched the given paths. ' +
					'Files must be PR (untracked) to be added. Use plastic_status to see current file states.',
				);
			}
			audit('plastic_add', 'completed', { addedCount: added.length });
			return jsonResult({
				addedFiles: added.length,
				paths: added,
				message: `Added ${added.length} file(s) to source control. They are now AD (added) and can be checked in.`,
			});
		} catch (err) {
			audit('plastic_add', 'error', { error: err instanceof Error ? err.message : String(err) });
			return errorResult(err instanceof Error ? err.message : String(err));
		}
	},
);

// 17. plastic_undo_checkout — Revert checkouts on specific files
server.registerTool(
	'plastic_undo_checkout',
	{
		title: 'Undo Checkout',
		description: `Revert (undo) the checkout on specific files, restoring them to their last checked-in version.

IMPORTANT — WHAT THIS ACTUALLY DOES:
- On CO (checked-out) files: Reverts to last checked-in version. Local edits are DISCARDED.
- On AD (added) files: DELETES the file from source control AND from disk. This is DESTRUCTIVE — the file will be gone.
- On CH (changed) files: Reverts to last checked-in version. Local edits are DISCARDED.

SAFETY GUARDS:
- NEVER operates on AD (added) or PR (private) files. For AD files, 'undo checkout' means DELETE — use plastic_discard_add instead if you truly want that.
- Blocks bulk operations on more than ${BULK_OPERATION_THRESHOLD} files.
- Reports exactly which files will lose local modifications BEFORE executing.
- All operations are audit-logged.

To simply un-stage files without discarding changes, use plastic_unstage.`,
		inputSchema: z.object({
			paths: z.array(z.string()).describe('File paths to undo checkout on (CO files only)'),
			confirm_bulk: z.boolean().optional().describe(`Required when reverting more than ${BULK_OPERATION_THRESHOLD} files. (default: false)`),
		}),
	},
	async ({ paths, confirm_bulk }) => {
		try {
			audit('plastic_undo_checkout', 'invoked', { pathCount: paths.length, confirm_bulk });

			// Guard 1: Bulk operation threshold
			if (paths.length > BULK_OPERATION_THRESHOLD && !confirm_bulk) {
				audit('plastic_undo_checkout', 'blocked_bulk', { pathCount: paths.length });
				return errorResult(
					`Refusing to undo checkout on ${paths.length} files (threshold: ${BULK_OPERATION_THRESHOLD}). ` +
					`This is a safety guard against accidental mass reverts. ` +
					`Set confirm_bulk=true to proceed.\n\n` +
					`First 10 files:\n` +
					paths.slice(0, 10).map(p => `  - ${p}`).join('\n') +
					(paths.length > 10 ? `\n  ... and ${paths.length - 10} more` : ''),
				);
			}

			// Classify files by change type
			const status = await backend().getStatus(true);
			const changeMap = new Map(status.changes.map(c => [c.path, c.changeType]));

			const safePaths: string[] = [];  // CO, CH — safe to undo (reverts to last version)
			const destructivePaths: string[] = [];  // AD — undo = DELETE from source control
			const privatePaths: string[] = [];  // PR — not tracked, nothing to undo
			const unknownPaths: string[] = [];  // Not in status at all

			for (const p of paths) {
				const changeType = changeMap.get(p) || changeMap.get(p.replace(/\\/g, '/'));
				if (changeType === 'added') {
					destructivePaths.push(p);
				} else if (changeType === 'private') {
					privatePaths.push(p);
				} else if (changeType === 'checkedOut' || changeType === 'changed') {
					safePaths.push(p);
				} else if (!changeType) {
					unknownPaths.push(p);
				} else {
					safePaths.push(p);
				}
			}

			// Hard block on destructive paths — NEVER silently delete AD files
			if (destructivePaths.length > 0) {
				audit('plastic_undo_checkout', 'blocked_destructive', {
					destructiveCount: destructivePaths.length,
					safeCount: safePaths.length,
				});
				const msg = [
					`BLOCKED: ${destructivePaths.length} file(s) are newly-added (AD).`,
					`Undoing checkout on AD files DELETES them from source control AND disk.`,
					`This would permanently destroy these files and break all Unity references.`,
					``,
					`AD files that would be deleted:`,
					...destructivePaths.slice(0, 20).map(p => `  - ${p}`),
					destructivePaths.length > 20 ? `  ... and ${destructivePaths.length - 20} more` : '',
					``,
					`What you probably want instead:`,
					`  - To check in these files: use plastic_add then plastic_checkin`,
					`  - To un-stage without losing changes: use plastic_unstage`,
				];
				if (safePaths.length > 0) {
					msg.push(
						``,
						`${safePaths.length} CO/CH file(s) CAN be safely reverted. Call again with only those paths.`,
					);
				}
				return errorResult(msg.join('\n'));
			}

			// Block private paths — nothing to undo
			if (privatePaths.length > 0 && safePaths.length === 0) {
				return errorResult(
					`All ${privatePaths.length} file(s) are private (PR/untracked). ` +
					`There is nothing to undo — these files were never checked out. ` +
					`Use plastic_add to add them to source control, or plastic_checkin with auto_add_private=true.`,
				);
			}

			// Warn about Unity-critical files being reverted
			const criticalFiles = safePaths.filter(p =>
				UNITY_CRITICAL_EXTENSIONS.some(ext => p.endsWith(ext)),
			);

			// Pre-hook: backup files before destructive operation
			let backupPath: string | undefined;
			if (safePaths.length > 0) {
				try {
					const wsRoot = getCmWorkspaceRoot() || '.';
					const wsName = (await backend().getCurrentBranch()) || 'unknown-workspace';
					backupPath = await createBackup({
						tool: 'undo_checkout',
						workspace: wsName,
						workspaceRoot: wsRoot,
						files: safePaths.map(p => ({
							path: p,
							changeType: changeMap.get(p) || changeMap.get(p.replace(/\\/g, '/')) || 'unknown',
						})),
						getBaseContent: async (filePath) => backend().getBaseRevisionContent(filePath),
						backupBaseDir: process.env.PLASTIC_BACKUP_DIR,
					});
					audit('plastic_undo_checkout', 'backup_created', { backupPath, fileCount: safePaths.length });
				} catch (backupErr) {
					audit('plastic_undo_checkout', 'backup_failed', {
						error: backupErr instanceof Error ? backupErr.message : String(backupErr),
					});
				}
			}

			// Execute
			const reverted = safePaths.length > 0 ? await backend().undoCheckout(safePaths) : [];
			store.remove(reverted);
			audit('plastic_undo_checkout', 'completed', {
				revertedCount: reverted.length,
				criticalCount: criticalFiles.length,
				skippedPrivate: privatePaths.length,
			});

			const result: Record<string, unknown> = {
				revertedFiles: reverted.length,
				paths: reverted,
				message: `Reverted ${reverted.length} file(s) to their last checked-in version. Local modifications have been discarded.`,
			};
			if (criticalFiles.length > 0) {
				result.criticalFilesReverted = criticalFiles;
				result.unityWarning = `${criticalFiles.length} Unity-critical file(s) (.meta/.unity/.prefab/.asset/.asmdef) were reverted. Verify scene/prefab references after reopening Unity.`;
			}
			if (privatePaths.length > 0) {
				result.skippedPrivate = privatePaths;
				result.privateNote = `${privatePaths.length} private file(s) were skipped — nothing to undo on untracked files.`;
			}
			if (unknownPaths.length > 0) {
				result.unknownPaths = unknownPaths;
			}
			if (backupPath) {
				result.backupPath = backupPath;
				result.backupNote = `Working copies backed up to ${backupPath}. Use plastic_restore_backup to recover if needed.`;
			}
			return jsonResult(result);
		} catch (err) {
			audit('plastic_undo_checkout', 'error', { error: err instanceof Error ? err.message : String(err) });
			return errorResult(err instanceof Error ? err.message : String(err));
		}
	},
);

// 18. plastic_clean_stale — Auto-detect and undo stale checkouts
server.registerTool(
	'plastic_clean_stale',
	{
		title: 'Clean Stale Checkouts',
		description: `Automatically detect and undo stale checkouts (CO files with no real changes).

SAFETY:
- Only targets checked-out (CO) files — NEVER touches added (AD), changed (CH), or private (PR) files.
- Defaults to dry_run=true (preview mode). You must explicitly set dry_run=false to execute.
- Blocks bulk reverts of more than ${BULK_OPERATION_THRESHOLD} files unless confirmed.
- All operations are audit-logged.

Run this before checkin to avoid commit failures from unchanged files.`,
		inputSchema: z.object({
			dry_run: z.boolean().optional().describe('Preview stale files without reverting. DEFAULTS TO TRUE (safe). Set to false to actually revert.'),
			confirm_bulk: z.boolean().optional().describe(`Required when reverting more than ${BULK_OPERATION_THRESHOLD} files. (default: false)`),
		}),
	},
	async ({ dry_run, confirm_bulk }) => {
		try {
			// Default to dry_run=true for safety
			const isDryRun = dry_run !== false;

			audit('plastic_clean_stale', 'invoked', { dry_run: isDryRun, confirm_bulk });

			const status = await backend().getStatus(false);
			// SAFETY: Only target CO (checkedOut) files. Never AD, CH, PR, DE, or any other type.
			// Undoing checkout on AD files would remove them from source control entirely.
			const staleFiles = status.changes
				.filter(c => c.changeType === 'checkedOut')
				.map(c => c.path);

			// Also report what we're NOT touching for transparency
			const addedFiles = status.changes.filter(c => c.changeType === 'added').length;
			const changedFiles = status.changes.filter(c => c.changeType === 'changed').length;

			if (staleFiles.length === 0) {
				audit('plastic_clean_stale', 'no_stale_found');
				return textResult(
					`No stale checkouts (CO) detected. ` +
					`Workspace has ${addedFiles} added and ${changedFiles} changed file(s) — these are left untouched.`,
				);
			}

			if (isDryRun) {
				audit('plastic_clean_stale', 'dry_run', { staleCount: staleFiles.length });
				return jsonResult({
					staleFiles,
					count: staleFiles.length,
					skipped: { added: addedFiles, changed: changedFiles },
					message: 'DRY RUN (default) — only CO files listed above would be reverted. Set dry_run=false to execute. AD/CH files are never touched.',
				});
			}

			// Guard: Bulk operation threshold
			if (staleFiles.length > BULK_OPERATION_THRESHOLD && !confirm_bulk) {
				audit('plastic_clean_stale', 'blocked_bulk', { staleCount: staleFiles.length });
				return errorResult(
					`Found ${staleFiles.length} stale checkouts (threshold: ${BULK_OPERATION_THRESHOLD}). ` +
					`Set confirm_bulk=true to proceed with mass revert.\n\n` +
					`First 10 files:\n` +
					staleFiles.slice(0, 10).map(p => `  - ${p}`).join('\n') +
					(staleFiles.length > 10 ? `\n  ... and ${staleFiles.length - 10} more` : ''),
				);
			}

			// Pre-hook: backup files before destructive operation
			let backupPath: string | undefined;
			try {
				const wsRoot = getCmWorkspaceRoot() || '.';
				const wsName = (await backend().getCurrentBranch()) || 'unknown-workspace';
				backupPath = await createBackup({
					tool: 'clean_stale',
					workspace: wsName,
					workspaceRoot: wsRoot,
					files: staleFiles.map(p => ({ path: p, changeType: 'checkedOut' })),
					getBaseContent: async (filePath) => backend().getBaseRevisionContent(filePath),
					backupBaseDir: process.env.PLASTIC_BACKUP_DIR,
				});
				audit('plastic_clean_stale', 'backup_created', { backupPath, fileCount: staleFiles.length });
			} catch (backupErr) {
				audit('plastic_clean_stale', 'backup_failed', {
					error: backupErr instanceof Error ? backupErr.message : String(backupErr),
				});
			}

			const reverted = await backend().undoCheckout(staleFiles);
			store.remove(reverted);

			// Flag any Unity-critical files that were reverted
			const criticalReverted = reverted.filter(p =>
				UNITY_CRITICAL_EXTENSIONS.some(ext => p.endsWith(ext)),
			);

			audit('plastic_clean_stale', 'completed', {
				revertedCount: reverted.length,
				criticalCount: criticalReverted.length,
				addedSkipped: addedFiles,
				changedSkipped: changedFiles,
			});

			const result: Record<string, unknown> = {
				revertedFiles: reverted.length,
				paths: reverted,
				skipped: { added: addedFiles, changed: changedFiles },
				message: `Reverted ${reverted.length} stale checkout(s). ${addedFiles} added and ${changedFiles} changed file(s) left untouched.`,
			};
			if (criticalReverted.length > 0) {
				result.criticalFilesReverted = criticalReverted;
				result.unityWarning = `${criticalReverted.length} Unity-critical file(s) were reverted. Verify references after reopening Unity.`;
			}
			if (backupPath) {
				result.backupPath = backupPath;
				result.backupNote = `Working copies backed up to ${backupPath}. Use plastic_restore_backup to recover if needed.`;
			}
			return jsonResult(result);
		} catch (err) {
			audit('plastic_clean_stale', 'error', { error: err instanceof Error ? err.message : String(err) });
			return errorResult(err instanceof Error ? err.message : String(err));
		}
	},
);

// 19. plastic_restore_backup — List, preview, and restore from automatic backups
server.registerTool(
	'plastic_restore_backup',
	{
		title: 'Restore from Backup',
		description: `List, preview, and restore files from automatic pre-operation backups.

Backups are created automatically before destructive operations (undo_checkout, clean_stale).
Each backup contains:
- files/ — working-copy snapshots (the versions that were about to be lost)
- base/ — checked-in versions (what the file reverted to)
- manifest.json — metadata including file paths, change types, Unity GUIDs

ACTIONS:
- list: Show all backups for this workspace, newest first
- preview: Show the manifest for a specific backup (file list, sizes, GUIDs)
- restore: Copy backed-up working-copy files back to the workspace. Does NOT interact with Plastic SCM — you must then cm add / cm checkin as needed.`,
		inputSchema: z.object({
			action: z.enum(['list', 'preview', 'restore']).describe('Action to perform'),
			backup_id: z.string().optional().describe('Backup ID (directory name like "20260318-143000_undo_checkout"). Required for preview and restore.'),
			paths: z.array(z.string()).optional().describe('Specific file paths to restore. If omitted, all files in the backup are restored. Only used with action=restore.'),
		}),
	},
	async ({ action, backup_id, paths }) => {
		try {
			const wsRoot = getCmWorkspaceRoot() || '.';
			const wsName = (await backend().getCurrentBranch()) || 'unknown-workspace';

			if (action === 'list') {
				const backups = await listBackups(wsName, process.env.PLASTIC_BACKUP_DIR);
				if (backups.length === 0) {
					return textResult('No backups found for this workspace.');
				}
				return jsonResult({
					backups,
					message: `${backups.length} backup(s) found. Use action="preview" with a backup_id to see details.`,
				});
			}

			if (!backup_id) {
				return errorResult('backup_id is required for preview and restore actions.');
			}

			if (action === 'preview') {
				const manifest = await getBackupManifest(wsName, backup_id, process.env.PLASTIC_BACKUP_DIR);
				if (!manifest) {
					return errorResult(`Backup not found: ${backup_id}`);
				}
				return jsonResult({
					...manifest,
					message: `Backup contains ${manifest.totalFiles} file(s), ${manifest.unityCriticalFiles} Unity-critical. Use action="restore" to recover.`,
				});
			}

			if (action === 'restore') {
				audit('plastic_restore_backup', 'restore_invoked', { backup_id, filterPaths: paths?.length ?? 'all' });
				const restored = await restoreBackup(wsName, wsRoot, backup_id, paths, process.env.PLASTIC_BACKUP_DIR);
				audit('plastic_restore_backup', 'restore_completed', { restoredCount: restored.length });
				return jsonResult({
					restoredFiles: restored.length,
					paths: restored,
					message: `Restored ${restored.length} file(s) to workspace. These are now local modifications — use plastic_status to see them, then plastic_checkin to commit.`,
				});
			}

			return errorResult(`Unknown action: ${action}`);
		} catch (err) {
			return errorResult(err instanceof Error ? err.message : String(err));
		}
	},
);

// ── Resources ────────────────────────────────────────────────────────

// plastic://workspace/status — Current workspace status
server.registerResource(
	'workspace-status',
	'plastic://workspace/status',
	{
		title: 'Workspace Status',
		description: 'Current pending changes and branch info',
		mimeType: 'application/json',
	},
	async (uri) => {
		try {
			const status = await backend().getStatus(true);
			const branch = await backend().getCurrentBranch();
			const changes = status.changes.map(c => ({
				path: c.path,
				type: c.changeType,
				staged: getService().isStaged(c.path),
			}));
			return {
				contents: [{
					uri: uri.href,
					text: JSON.stringify({ branch, changes, stagedCount: getService().getStagedPaths().length }, null, 2),
				}],
			};
		} catch {
			return { contents: [{ uri: uri.href, text: '{"error": "Failed to get status"}' }] };
		}
	},
);

// plastic://workspace/branch — Current branch name
server.registerResource(
	'workspace-branch',
	'plastic://workspace/branch',
	{
		title: 'Current Branch',
		description: 'The currently active branch',
		mimeType: 'text/plain',
	},
	async (uri) => {
		try {
			const branch = await backend().getCurrentBranch();
			return { contents: [{ uri: uri.href, text: branch ?? 'unknown' }] };
		} catch {
			return { contents: [{ uri: uri.href, text: 'unknown' }] };
		}
	},
);

// plastic://workspace/staged — Currently staged files
server.registerResource(
	'workspace-staged',
	'plastic://workspace/staged',
	{
		title: 'Staged Files',
		description: 'Files currently staged for checkin',
		mimeType: 'application/json',
	},
	async (uri) => ({
		contents: [{
			uri: uri.href,
			text: JSON.stringify(getService().getStagedPaths(), null, 2),
		}],
	}),
);

// ── Prompts ──────────────────────────────────────────────────────────

// plastic_commit_message — Generate a commit message from staged changes
server.registerPrompt(
	'plastic_commit_message',
	{
		title: 'Generate Commit Message',
		description: 'Generate a commit message based on the current staged changes.',
		argsSchema: {
			style: z.enum(['conventional', 'descriptive', 'brief']).optional()
				.describe('Commit message style (default: conventional)'),
		},
	},
	async ({ style }) => {
		const status = await backend().getStatus(false);
		const staged = status.changes.filter(c => getService().isStaged(c.path));
		const changeList = staged.length > 0
			? staged.map(c => `- ${c.changeType}: ${c.path}`).join('\n')
			: status.changes.map(c => `- ${c.changeType}: ${c.path}`).join('\n');

		const styleGuide = style === 'brief'
			? 'Write a single-line commit message (max 72 chars).'
			: style === 'descriptive'
				? 'Write a descriptive commit message with a subject line and bullet-point body.'
				: 'Write a conventional commit message (feat/fix/refactor/docs/chore prefix) with a subject line.';

		return {
			messages: [{
				role: 'user' as const,
				content: {
					type: 'text' as const,
					text: `${styleGuide}\n\nChanged files:\n${changeList}\n\nGenerate only the commit message, no explanation.`,
				},
			}],
		};
	},
);

// plastic_review_summary — Summarize changes for a code review
server.registerPrompt(
	'plastic_review_summary',
	{
		title: 'Code Review Summary',
		description: 'Generate a summary of changes for a code review.',
		argsSchema: {
			branchName: z.string().describe('Branch to summarize'),
			limit: z.number().optional().describe('Max changesets to include (default: 20)'),
		},
	},
	async ({ branchName, limit }) => {
		const changesets = await backend().listChangesets(branchName, limit ?? 20);
		const summary = changesets.map(c =>
			`cs:${c.id} by ${c.owner} on ${c.date}: ${c.comment ?? '(no comment)'}`,
		).join('\n');

		return {
			messages: [{
				role: 'user' as const,
				content: {
					type: 'text' as const,
					text: `Summarize the following branch changes for a code review. Highlight key modifications, potential risks, and areas that need attention.\n\nBranch: ${branchName}\n\nChangesets:\n${summary}`,
				},
			}],
		};
	},
);

// ── Hybrid backend setup ─────────────────────────────────────────────

/**
 * Attempt to set up hybrid backend by resolving config from .plastic folder
 * and reading cached SSO token. Returns true if REST API is available.
 */
async function trySetupHybridBackend(workspacePath: string): Promise<boolean> {
	const config = resolveConfig(workspacePath);
	if (!config || !config.serverUrl || !config.organizationName) {
		process.stderr.write('No workspace config detected — REST API unavailable\n');
		return false;
	}

	const cachedToken = detectCachedToken();
	if (!cachedToken) {
		process.stderr.write('No cached SSO token — REST API unavailable\n');
		return false;
	}

	// Initialize detection-first config so getConfig() works without vscode
	initDetectedConfig(workspacePath);

	// Set up REST client with SSO token as Bearer auth
	try {
		const client = getClient();
		client.use({
			async onRequest({ request }: { request: Request }) {
				request.headers.set('Authorization', `Bearer ${cachedToken.token}`);
				return request;
			},
		});

		// Set org name hints (numeric server ID is most reliable for API calls)
		const wsInfo = detectWorkspace(workspacePath);
		if (wsInfo) {
			const hints: string[] = [];
			if (wsInfo.cloudServerId) hints.push(wsInfo.cloudServerId);
			if (wsInfo.organizationName) hints.push(wsInfo.organizationName);
			if (hints.length > 0) setOrgNameHints(hints);
		}

		process.stderr.write(`REST API configured: org="${config.organizationName}", repo="${config.repositoryName}", user="${cachedToken.user}"\n`);
	} catch (err) {
		process.stderr.write(`REST client setup failed: ${err}\n`);
		return false;
	}

	setBackend(new HybridBackend(new CliBackend(), new RestBackend()));
	return true;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
	const { workspace } = parseArgs();

	// Initialize cm CLI backend
	setCmWorkspaceRoot(workspace);
	const cmPath = await detectCm();
	if (!cmPath) {
		process.stderr.write('Error: cm CLI not found. Install Plastic SCM client tools.\n');
		process.exit(1);
	}

	const hybridReady = await trySetupHybridBackend(workspace);
	if (!hybridReady) {
		setBackend(new CliBackend());
	}
	process.stderr.write(`Plastic SCM MCP server started (${hybridReady ? 'hybrid' : 'CLI-only'} backend, workspace: ${workspace})\n`);

	// Connect via stdio
	const transport = new StdioServerTransport();
	await server.connect(transport);

	// Graceful shutdown on SIGTERM/SIGINT
	const shutdown = async () => {
		process.stderr.write('MCP server shutting down...\n');
		await server.close();
		process.exit(0);
	};
	process.on('SIGTERM', shutdown);
	process.on('SIGINT', shutdown);
}

main().catch(err => {
	process.stderr.write(`Fatal: ${err}\n`);
	process.exit(1);
});
