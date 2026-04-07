/**
 * Shared destructive-operation safety layer.
 *
 * Both the UI (`cleanStale`, `branchSwitch` Discard) and the MCP server
 * (`bpscm_clean_stale`, `bpscm_undo_checkout`) need to:
 *   - Detect Unity-critical files about to be reverted so the operator can
 *     be warned before the operation runs
 *   - Create a backup of the working-copy + base content under a known
 *     directory so accidental reverts are recoverable
 *   - Enforce a bulk-operation threshold (default: BULK_OPERATION_THRESHOLD)
 *     above which the caller must explicitly confirm
 *   - Emit structured audit log entries for post-mortem analysis
 *   - Flag files whose revert will trigger Unity reimport (Unity re-checkout
 *     cycle)
 *
 * Prior to this module the MCP side had all of the above bolted into
 * `bpscm_clean_stale` inline, and the UI side had none of it. This file is
 * the single source of truth; both entry points now call the same helpers.
 */

import { extname } from 'path';
import type { PlasticBackend } from './backend';
import { BULK_OPERATION_THRESHOLD, UNITY_CRITICAL_EXTENSIONS } from './safety';
import { createBackup } from './backup';

/** File extensions that trigger a Unity asset reimport when reverted. */
const UNITY_REIMPORT_EXTENSIONS = new Set<string>([
	'.cs', '.shader', '.compute', '.mat', '.asset',
	...UNITY_CRITICAL_EXTENSIONS,
]);

const UNITY_CRITICAL_SET = new Set<string>(UNITY_CRITICAL_EXTENSIONS);

/**
 * Minimal structured logger that both the extension (`util/logger.ts`) and the
 * MCP server (stderr JSON) can implement.
 */
export interface AuditLogger {
	log(action: string, details?: Record<string, unknown>): void;
}

/** No-op audit logger used when the caller doesn't need audit output. */
export const noopAuditLogger: AuditLogger = {
	log(): void { /* no-op */ },
};

/**
 * Result of classifying a file set against the destructive-op safety rules.
 * Consumers use this to build confirmation prompts and decide whether to
 * proceed with the operation.
 */
export interface DestructiveClassification {
	/** Total number of files in the request. */
	totalFiles: number;
	/** Files whose extension is in UNITY_CRITICAL_EXTENSIONS (.meta, .unity, .prefab, .asset, .asmdef, .asmref). */
	criticalFiles: string[];
	/** Files whose revert will cause a Unity asset reimport (.cs, .shader, .compute, .mat, .asset, + critical). */
	reimportFiles: string[];
	/** True when totalFiles exceeds the bulk threshold and requires explicit confirmation. */
	requiresBulkConfirmation: boolean;
	/** The threshold used for the classification (for display / error messages). */
	bulkThreshold: number;
}

/**
 * Classify a set of files against the destructive-op safety rules.
 * Pure function — no I/O, no side effects. Used by both the UI confirmation
 * dialog and the MCP bulk-threshold guard.
 */
export function classifyDestructiveFiles(
	files: string[],
	bulkThreshold: number = BULK_OPERATION_THRESHOLD,
): DestructiveClassification {
	const criticalFiles: string[] = [];
	const reimportFiles: string[] = [];

	for (const file of files) {
		const ext = extname(file).toLowerCase();
		if (UNITY_CRITICAL_SET.has(ext)) {
			criticalFiles.push(file);
		}
		if (UNITY_REIMPORT_EXTENSIONS.has(ext)) {
			reimportFiles.push(file);
		}
	}

	return {
		totalFiles: files.length,
		criticalFiles,
		reimportFiles,
		requiresBulkConfirmation: files.length > bulkThreshold,
		bulkThreshold,
	};
}

/**
 * Request to execute a destructive revert (`cm undocheckout -a`) with full
 * safety infrastructure: backup, audit logging, Unity-critical flagging.
 */
export interface DestructiveRevertRequest {
	/** Short tool name for audit / backup directory naming ('clean_stale', 'discard', 'undo_checkout'). */
	tool: string;
	/** Workspace-relative paths to revert. Empty array is a no-op. */
	files: string[];
	/** Backend that owns `undoCheckout` and `getBaseRevisionContent`. */
	backend: PlasticBackend;
	/** Absolute path to the workspace root (used when copying working-copy bytes to the backup). */
	workspaceRoot: string;
	/** Human-readable workspace identifier for backup directory naming (typically branch name). */
	workspaceName: string;
	/**
	 * Optional map from path to the original change type (for audit / backup
	 * manifest metadata). When omitted, 'unknown' is recorded.
	 */
	changeTypeByPath?: Map<string, string>;
	/**
	 * When true and the file count exceeds the bulk threshold, the operation
	 * is blocked and `status: 'blocked_bulk'` is returned. Default: false.
	 * Callers that have already collected user confirmation (e.g., a VS Code
	 * modal dialog) should leave this false; the MCP `confirm_bulk` parameter
	 * maps onto NOT passing this flag.
	 */
	enforceBulkGuard?: boolean;
	/** Custom bulk threshold. Default: BULK_OPERATION_THRESHOLD. */
	bulkThreshold?: number;
	/** Skip the backup step. Useful for tests that don't care about backups. Default: false. */
	skipBackup?: boolean;
	/** Override the backup base directory. Defaults to PLASTIC_BACKUP_DIR env var or ~/.plastic-scm-backups. */
	backupBaseDir?: string;
	/** Audit logger. Defaults to noop. */
	audit?: AuditLogger;
}

/** Result of executing a destructive revert. */
export interface DestructiveRevertResult {
	/** 'completed' on success, 'blocked_bulk' if the bulk guard prevented execution, 'empty' if files was empty. */
	status: 'completed' | 'blocked_bulk' | 'empty';
	/** Files actually reverted (return value from `backend.undoCheckout`). */
	reverted: string[];
	/** Classification of the requested file set. */
	classification: DestructiveClassification;
	/** Path to the backup directory, or undefined if backup was skipped or failed. */
	backupPath?: string;
	/** Human-readable notice when the Unity re-checkout loop is likely (non-empty reimport files). */
	unityReimportWarning?: string;
}

/**
 * Execute a destructive revert with full safety infrastructure.
 *
 * Responsibilities (in order):
 *   1. Classify the file set (critical files, bulk threshold check)
 *   2. If `enforceBulkGuard` and the set is over threshold, block and audit
 *   3. Create a backup via `createBackup()` (best-effort — a backup failure
 *      does NOT abort the revert, but IS audit-logged)
 *   4. Invoke `backend.undoCheckout(files)` — the actual destructive step
 *   5. Audit the outcome with reverted count, critical count, backup path
 *   6. Build and return `DestructiveRevertResult`
 *
 * Errors from `undoCheckout` propagate to the caller. Audit log entries are
 * emitted for invoked/backup_created/backup_failed/completed/blocked_bulk/error.
 */
export async function executeDestructiveRevert(
	request: DestructiveRevertRequest,
): Promise<DestructiveRevertResult> {
	const audit = request.audit ?? noopAuditLogger;
	const classification = classifyDestructiveFiles(request.files, request.bulkThreshold);

	audit.log(`${request.tool}:invoked`, {
		fileCount: classification.totalFiles,
		criticalCount: classification.criticalFiles.length,
		reimportCount: classification.reimportFiles.length,
	});

	if (classification.totalFiles === 0) {
		return { status: 'empty', reverted: [], classification };
	}

	if (request.enforceBulkGuard && classification.requiresBulkConfirmation) {
		audit.log(`${request.tool}:blocked_bulk`, {
			fileCount: classification.totalFiles,
			threshold: classification.bulkThreshold,
		});
		return { status: 'blocked_bulk', reverted: [], classification };
	}

	// Pre-op backup. Failure is logged but does not abort the operation —
	// consistent with the original MCP behavior where backup was best-effort.
	let backupPath: string | undefined;
	if (!request.skipBackup) {
		try {
			backupPath = await createBackup({
				tool: request.tool,
				workspace: request.workspaceName,
				workspaceRoot: request.workspaceRoot,
				files: request.files.map(p => ({
					path: p,
					changeType: request.changeTypeByPath?.get(p) ?? 'unknown',
				})),
				getBaseContent: (filePath) => request.backend.getBaseRevisionContent(filePath),
				backupBaseDir: request.backupBaseDir,
			});
			audit.log(`${request.tool}:backup_created`, { backupPath, fileCount: request.files.length });
		} catch (err) {
			audit.log(`${request.tool}:backup_failed`, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	// Destructive step. Errors propagate.
	const reverted = await request.backend.undoCheckout(request.files);

	audit.log(`${request.tool}:completed`, {
		revertedCount: reverted.length,
		criticalCount: classification.criticalFiles.length,
		backupPath,
	});

	let unityReimportWarning: string | undefined;
	if (classification.reimportFiles.length > 0) {
		unityReimportWarning =
			`${classification.reimportFiles.length} reverted file(s) will trigger Unity reimport/recompilation. ` +
			`If Unity is running, it may re-checkout these files (creating new stale CH records). ` +
			`Close Unity before running clean_stale to prevent the cycle, or run bpscm_checkin which ` +
			`auto-excludes stale files via retry.`;
	}

	return {
		status: 'completed',
		reverted,
		classification,
		backupPath,
		unityReimportWarning,
	};
}
