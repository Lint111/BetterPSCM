import { execCm, execCmToFile, getCmWorkspaceRoot } from './cmCli';
import { readFile, unlink } from 'fs/promises';
import { log } from '../util/logger';
import { normalizePath } from '../util/path';
import { detectWorkspace, hasPlasticWorkspace } from '../util/plasticDetector';
import type { PlasticBackend } from './backend';
import type {
	StatusResult,
	CheckinResult,
	NormalizedChange,
	StatusChangeType,
	BranchInfo,
	ChangesetInfo,
	ChangesetDiffItem,
	UpdateResult,
	CodeReviewInfo,
	ReviewCommentInfo,
	ReviewCommentType,
	ReviewerInfo,
	CreateReviewParams,
	CreateCommentParams,
	ReviewStatus,
	LabelInfo,
	CreateLabelParams,
	FileHistoryEntry,
	BlameLine,
	MergeReport,
	MergeResult,
	LockRuleInfo,
	LockInfo,
} from './types';
import { NotSupportedError } from './types';

const CM_CHANGE_TYPE_MAP: Record<string, StatusChangeType> = {
	PR: 'private',
	AD: 'added',
	CO: 'checkedOut',
	CH: 'changed',
	DE: 'deleted',
	LD: 'locallyDeleted',
	MV: 'moved',
	RP: 'replaced',
	CP: 'copied',
	IG: 'ignored',
	HD: 'changed',
};

/**
 * PlasticBackend implementation using the local `cm` CLI executable.
 * Handles all workspace-level operations by shelling out to the cm command.
 */
export class CliBackend implements PlasticBackend {
	readonly name = 'cm CLI';

	async getStatus(showPrivate: boolean): Promise<StatusResult> {
		const result = await execCm(['status', '--machinereadable', '--all']);
		if (result.exitCode !== 0) {
			throw new Error(`cm status failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
		}

		const lines = result.stdout.split(/\r?\n/).filter(l => l.length > 0);
		const changes: NormalizedChange[] = [];

		// Summary-only logging to avoid flooding output on large changesets
		log(`[cm status] ${lines.length} raw lines`);

		for (const line of lines) {
			if (line.startsWith('STATUS ')) continue;
			const parsed = parseStatusLine(line);
			if (!parsed) {
				log(`[cm status] UNPARSED: "${line}"`);
				continue;
			}
			if (!showPrivate && parsed.changeType === 'private') continue;
			changes.push(parsed);
		}

		return { changes };
	}

	async getCurrentBranch(): Promise<string | undefined> {
		// Primary: read from .plastic/plastic.selector (always up to date)
		const wsRoot = getCmWorkspaceRoot();
		if (wsRoot && hasPlasticWorkspace(wsRoot)) {
			const info = detectWorkspace(wsRoot);
			if (info?.currentBranch) {
				return info.currentBranch;
			}
		}

		// Fallback: cm find changeset with the current changeset id
		try {
			const wiResult = await execCm(['wi', '--machinereadable']);
			if (wiResult.exitCode === 0) {
				// Output: "CS <id> ..." — extract changeset id and query its branch
				const csMatch = wiResult.stdout.match(/^CS\s+(\d+)/);
				if (csMatch) {
					const csId = csMatch[1];
					const brResult = await execCm([
						'find', 'changeset',
						`where changesetid=${csId}`,
						'--format={branch}',
						'--nototal',
					]);
					if (brResult.exitCode === 0) {
						const branch = brResult.stdout.trim().split(/\r?\n/)[0]?.trim();
						if (branch) {
							log(`[getCurrentBranch] resolved from cs ${csId}: ${branch}`);
							return branch;
						}
					}
				}
			}
		} catch {
			// Non-critical
		}

		log('[getCurrentBranch] Could not determine current branch');
		return undefined;
	}

	async checkin(paths: string[], comment: string): Promise<CheckinResult> {
		const args = ['checkin', `-c=${comment}`, '--machinereadable', ...paths];
		const result = await execCm(args);

		if (result.exitCode !== 0) {
			throw new Error(`cm checkin failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
		}

		const csMatch = result.stdout.match(/cs:(\d+)/);
		const branchMatch = result.stdout.match(/(?:^|\s)br:([^\s]+)/m)
			|| result.stdout.match(/branch\s+"?([^"\n]+)/);

		if (!csMatch) {
			throw new Error(`cm checkin succeeded but could not parse changeset ID from: ${result.stdout}`);
		}

		log(`Checked in ${paths.length} file(s): "${comment}"`);

		return {
			changesetId: parseInt(csMatch[1], 10),
			branchName: branchMatch?.[1] ?? 'unknown',
		};
	}

	/** Extensions that are streamed to temp files instead of buffered in memory */
	private static readonly LARGE_FILE_EXTS = new Set([
		'.unity', '.prefab', '.asset', '.scene', '.lighting',
		'.terrainlayer', '.shadergraph', '.shadersubgraph',
		'.fbx', '.obj', '.png', '.jpg', '.tga', '.exr', '.psd',
	]);

	async getFileContent(revSpec: string): Promise<Uint8Array | undefined> {
		log(`[getFileContent] revSpec=${revSpec}`);

		// Check if this is a serverpath#cs:N format (from history graph diff)
		const csMatch = revSpec.match(/^serverpath:(.+)#cs:(\d+)$/);
		if (csMatch) {
			const serverPath = csMatch[1];
			const csId = csMatch[2];

			// Resolve revision ID via cm find revision, then cm cat revid:N
			const revId = await this.resolveRevisionId(serverPath, csId);
			if (revId) {
				return this.catRevision(`revid:${revId}`, serverPath);
			}

			// Fallback: try cm cat with raw revspec
			return this.catRevision(revSpec, serverPath);
		}

		// Bare serverpath: without revision qualifier (from quick diff fallback).
		// Convert to workspace-relative path so cm cat resolves the loaded base revision.
		const bareServerPath = revSpec.match(/^serverpath:\/(.+)$/);
		if (bareServerPath) {
			const relativePath = bareServerPath[1];
			log(`[getFileContent] bare serverpath → using workspace-relative path: ${relativePath}`);
			return this.catRevision(relativePath, relativePath);
		}

		// Direct revspec (e.g. revid:N from quick diff)
		return this.catRevision(revSpec, revSpec);
	}

	/**
	 * Fetch revision content via cm cat.
	 * Uses streaming to a temp file for known-large file types,
	 * buffered exec for everything else.
	 */
	private async catRevision(catArg: string, pathHint: string): Promise<Uint8Array | undefined> {
		const ext = pathHint.substring(pathHint.lastIndexOf('.')).toLowerCase();
		const useStreaming = CliBackend.LARGE_FILE_EXTS.has(ext);

		if (useStreaming) {
			log(`[catRevision] streaming ${catArg} (${ext})`);
			const tempPath = await execCmToFile(['cat', catArg, '--raw']);
			if (tempPath) {
				try {
					const data = await readFile(tempPath);
					return data;
				} finally {
					unlink(tempPath).catch(() => {});
				}
			}
			log(`[catRevision] streaming failed for ${catArg}`);
			return undefined;
		}

		// Standard buffered path (10MB is enough for code/text files)
		const result = await execCm(['cat', catArg, '--raw'], 10 * 1024 * 1024);
		if (result.exitCode === 0) {
			return Buffer.from(result.stdout, 'binary');
		}
		log(`[catRevision] cm cat failed (exit ${result.exitCode}): ${result.stderr}`);
		return undefined;
	}

	/**
	 * Resolve a file path + changeset ID to a concrete revision ID.
	 * First tries exact match (file modified in this changeset), then
	 * falls back to finding the latest revision at or before this changeset.
	 */
	private async resolveRevisionId(serverPath: string, csId: string): Promise<string | undefined> {
		const escapedPath = serverPath.replace(/'/g, "''");
		// Normalise: strip leading slash for item queries (known working combo)
		const itemPath = escapedPath.startsWith('/') ? escapedPath.substring(1) : escapedPath;

		// 1. Exact match: file was modified in this changeset
		const exact = await this.queryRevisionId(
			`where changeset=${csId} and item='${itemPath}'`,
		);
		if (exact) {
			log(`[resolveRevisionId] exact match cs=${csId} → revid:${exact}`);
			return exact;
		}

		// 2. Latest revision of this file at or before this changeset
		const latest = await this.queryRevisionId(
			`where changeset<=${csId} and item='${itemPath}' order by changeset desc limit 1`,
		);
		if (latest) {
			log(`[resolveRevisionId] latest<=cs:${csId} → revid:${latest}`);
			return latest;
		}

		log(`[resolveRevisionId] all attempts failed for cs=${csId} path=${serverPath}`);
		return undefined;
	}

	/**
	 * Run cm find revision with the given where clause, trying multiple format fields.
	 */
	private async queryRevisionId(whereClause: string): Promise<string | undefined> {
		for (const fmt of ['{id}', '{revisionid}', '{revid}']) {
			const result = await execCm([
				'find', 'revision', whereClause, `--format=${fmt}`, '--nototal',
			]);
			if (result.exitCode === 0) {
				const revId = result.stdout.trim().split(/\r?\n/)[0]?.trim();
				if (revId && /^\d+$/.test(revId)) return revId;
			}
			const errMsg = (result.stderr || result.stdout).trim();
			// If format field is not valid, try next; if query field is not valid, abort
			if (errMsg.includes('not valid for the specified object type')) continue;
			if (errMsg.includes('not valid on performed query')) break;
		}
		return undefined;
	}

	async listBranches(): Promise<BranchInfo[]> {
		const result = await execCm([
			'find', 'branch',
			'--format={name}#{id}#{owner}#{date}#{comment}',
			'--nototal',
		]);
		if (result.exitCode !== 0) {
			throw new Error(`cm find branch failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
		}

		const lines = result.stdout.split(/\r?\n/).filter(l => l.length > 0);
		return lines.map(parseBranchLine).filter((b): b is BranchInfo => b !== undefined);
	}

	async createBranch(name: string, comment?: string): Promise<BranchInfo> {
		const args = ['branch', 'create', name];
		if (comment) {
			args.push(`-c=${comment}`);
		}
		const result = await execCm(args);
		if (result.exitCode !== 0) {
			throw new Error(`cm branch create failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
		}

		log(`Created branch "${name}"`);
		return {
			id: 0,
			name,
			owner: '',
			date: '',
			comment: comment ?? undefined,
			isMain: false,
		};
	}

	async deleteBranch(branchId: number): Promise<void> {
		const result = await execCm(['branch', 'delete', String(branchId)]);
		if (result.exitCode !== 0) {
			throw new Error(`cm branch delete failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
		}
		log(`Deleted branch ${branchId}`);
	}

	async switchBranch(branchName: string): Promise<void> {
		const result = await execCm(['switch', `br:${branchName}`]);
		if (result.exitCode !== 0) {
			throw new Error(`cm switch failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
		}
		log(`Switched to branch "${branchName}"`);
	}

	async listChangesets(branchName?: string, limit?: number): Promise<ChangesetInfo[]> {
		const query = buildChangesetQuery(branchName, limit);
		const args = [
			'find', 'changeset',
			query,
			'--format={changesetid}#{branch}#{owner}#{date}#{comment}#{parent}',
			'--nototal',
		];
		const result = await execCm(args);
		if (result.exitCode !== 0) {
			// If {parent} field is unsupported, fall back without it
			if (result.stderr?.includes('parent') || result.stdout?.includes('parent')) {
				return this.listChangesetsWithoutParent(branchName, limit);
			}
			throw new Error(`cm find changeset failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
		}

		const lines = result.stdout.split(/\r?\n/).filter(l => l.length > 0);
		return lines.map(parseChangesetLine).filter((c): c is ChangesetInfo => c !== undefined);
	}

	private async listChangesetsWithoutParent(branchName?: string, limit?: number): Promise<ChangesetInfo[]> {
		const query = buildChangesetQuery(branchName, limit);
		const args = [
			'find', 'changeset',
			query,
			'--format={changesetid}#{branch}#{owner}#{date}#{comment}',
			'--nototal',
		];
		const result = await execCm(args);
		if (result.exitCode !== 0) {
			throw new Error(`cm find changeset failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
		}

		const lines = result.stdout.split(/\r?\n/).filter(l => l.length > 0);
		return lines.map(parseChangesetLineNoParent).filter((c): c is ChangesetInfo => c !== undefined);
	}

	async updateWorkspace(): Promise<UpdateResult> {
		const result = await execCm(['update', '--machinereadable']);
		if (result.exitCode !== 0) {
			const output = result.stderr || result.stdout;
			// Check for conflicts
			if (output.includes('conflict') || output.includes('CONFLICT')) {
				const conflicts = output.split(/\r?\n/)
					.filter(l => l.toLowerCase().includes('conflict'))
					.map(l => l.trim());
				return { updatedFiles: 0, conflicts };
			}
			throw new Error(`cm update failed (exit ${result.exitCode}): ${output}`);
		}

		// Count updated files from output
		const lines = result.stdout.split(/\r?\n/).filter(l => l.trim().length > 0);
		const conflicts: string[] = [];
		let updatedFiles = 0;
		for (const line of lines) {
			if (line.toLowerCase().includes('conflict')) {
				conflicts.push(line.trim());
			} else if (!line.startsWith('STATUS ') && !line.startsWith('Total ')) {
				updatedFiles++;
			}
		}

		log(`Workspace updated: ${updatedFiles} files, ${conflicts.length} conflicts`);
		return { updatedFiles, conflicts };
	}

	async getChangesetDiff(changesetId: number, parentId: number): Promise<ChangesetDiffItem[]> {
		log(`[getChangesetDiff] cs=${changesetId}, parent=${parentId}`);

		// Try cm diff cs:<parent> cs:<changeset> --machinereadable
		const result = await execCm([
			'diff', `cs:${parentId}`, `cs:${changesetId}`, '--machinereadable',
		]);

		if (result.exitCode === 0 && result.stdout.trim().length > 0) {
			log(`[getChangesetDiff] cm diff succeeded, raw output (first 500): ${result.stdout.substring(0, 500)}`);
			const items = parseDiffOutput(result.stdout);
			if (items.length > 0) {
				log(`[getChangesetDiff] parsed ${items.length} items from cm diff`);
				return items;
			}
			log(`[getChangesetDiff] cm diff output parsed to 0 items, trying fallbacks`);
		} else {
			log(`[getChangesetDiff] cm diff failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
		}

		// Fallback 1: try cm diff with alternative format flags
		// NOTE: always use --machinereadable to prevent GUI diff viewer launch
		const result2 = await execCm(['diff', `cs:${parentId}`, `cs:${changesetId}`, '--machinereadable', '--repositorypaths']);
		if (result2.exitCode === 0 && result2.stdout.trim().length > 0) {
			log(`[getChangesetDiff] cm diff (alt flags) raw output (first 500): ${result2.stdout.substring(0, 500)}`);
			const items = parseDiffOutput(result2.stdout);
			if (items.length > 0) {
				log(`[getChangesetDiff] parsed ${items.length} items from cm diff (alt flags)`);
				return items;
			}
		}

		// Fallback 2: try cm find revision for the changeset
		log(`[getChangesetDiff] trying cm find revision fallback`);
		return this.getChangesetRevisions(changesetId);
	}

	private async getChangesetRevisions(changesetId: number): Promise<ChangesetDiffItem[]> {
		const result = await execCm([
			'find', 'revision',
			`where changeset=${changesetId}`,
			'--format={path}#{type}',
			'--nototal',
		]);
		if (result.exitCode !== 0) {
			log(`[getChangesetRevisions] cm find revision failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
			return [];
		}
		log(`[getChangesetRevisions] raw output (first 500): ${result.stdout.substring(0, 500)}`);
		const lines = result.stdout.split(/\r?\n/).filter(l => l.length > 0);
		const items = lines.map(parseRevisionLine).filter((r): r is ChangesetDiffItem => r !== undefined);
		log(`[getChangesetRevisions] parsed ${items.length} items`);
		return items;
	}

	// Phase 4 — Code reviews
	async listCodeReviews(filter?: 'all' | 'assignedToMe' | 'createdByMe' | 'pending'): Promise<CodeReviewInfo[]> {
		const whereClause = filter === 'assignedToMe' ? "where assignee = 'me'"
			: filter === 'createdByMe' ? "where owner = 'me'"
			: filter === 'pending' ? "where status = 'Under review'"
			: undefined;
		const args = [
			'find', 'review',
			...(whereClause ? [whereClause] : []),
			'--format={id}#{title}#{status}#{owner}#{date}#{targettype}#{target}#{assignee}',
			'--nototal',
		];
		const result = await execCm(args);
		if (result.exitCode !== 0) {
			throw new Error(`cm find review failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
		}
		const lines = result.stdout.split(/\r?\n/).filter(l => l.length > 0);
		return lines.map(parseReviewLine).filter((r): r is CodeReviewInfo => r !== undefined);
	}
	async getCodeReview(id: number): Promise<CodeReviewInfo> {
		const result = await execCm([
			'find', 'review',
			`where id=${id}`,
			'--format={id}#{title}#{status}#{owner}#{date}#{targettype}#{target}#{assignee}',
			'--nototal',
		]);
		if (result.exitCode !== 0) {
			throw new Error(`cm find review failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
		}
		const lines = result.stdout.split(/\r?\n/).filter(l => l.length > 0);
		const reviews = lines.map(parseReviewLine).filter((r): r is CodeReviewInfo => r !== undefined);
		if (reviews.length === 0) {
			throw new Error(`Code review ${id} not found`);
		}
		return reviews[0];
	}
	async createCodeReview(params: CreateReviewParams): Promise<CodeReviewInfo> {
		let spec: string;
		if (params.targetSpec) {
			spec = params.targetType === 'Branch'
				? `br:${params.targetSpec}`
				: `cs:${params.targetSpec}`;
		} else {
			spec = params.targetType === 'Branch'
				? `br:id:${params.targetId}`
				: `cs:${params.targetId}`;
		}

		const args = ['codereview', spec, params.title, '--format={id}'];
		if (params.reviewers && params.reviewers.length > 0) {
			args.push(`--assignee=${params.reviewers[0]}`);
		}

		const result = await execCm(args);
		if (result.exitCode !== 0) {
			throw new Error(`cm codereview create failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
		}

		const newId = parseInt(result.stdout.trim(), 10);
		if (isNaN(newId)) {
			throw new Error(`cm codereview returned unexpected output: ${result.stdout}`);
		}

		return this.getCodeReview(newId);
	}
	async deleteCodeReview(id: number): Promise<void> {
		const result = await execCm(['codereview', '-d', String(id)]);
		if (result.exitCode !== 0) {
			throw new Error(`cm codereview delete failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
		}
	}

	async updateCodeReviewStatus(id: number, status: ReviewStatus): Promise<void> {
		const result = await execCm(['codereview', '-e', String(id), `--status=${status}`]);
		if (result.exitCode !== 0) {
			throw new Error(`cm codereview edit failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
		}
	}
	async getReviewComments(): Promise<ReviewCommentInfo[]> { throw new NotSupportedError('getReviewComments', 'cm CLI'); }
	async addReviewComment(): Promise<ReviewCommentInfo> { throw new NotSupportedError('addReviewComment', 'cm CLI'); }
	async getReviewers(): Promise<ReviewerInfo[]> { throw new NotSupportedError('getReviewers', 'cm CLI'); }
	async addReviewers(): Promise<void> { throw new NotSupportedError('addReviewers', 'cm CLI (requires REST API backend for managing reviewers)'); }
	async removeReviewer(): Promise<void> { throw new NotSupportedError('removeReviewer', 'cm CLI (requires REST API backend for managing reviewers)'); }
	async updateReviewerStatus(): Promise<void> { throw new NotSupportedError('updateReviewerStatus', 'cm CLI (requires REST API backend for managing reviewers)'); }

	// Phase 4b — review comment resolution
	async resolveRevisionPaths(revisionIds: number[]): Promise<Map<number, string>> {
		if (revisionIds.length === 0) return new Map();

		const CHUNK_SIZE = 50;
		const pathMap = new Map<number, string>();

		for (let i = 0; i < revisionIds.length; i += CHUNK_SIZE) {
			const chunk = revisionIds.slice(i, i + CHUNK_SIZE);
			const whereClause = chunk.map(id => `id=${id}`).join(' or ');
			const result = await execCm([
				'find', 'revision',
				`where ${whereClause}`,
				'--format={item}#{id}',
				'--nototal',
			]);
			if (result.exitCode !== 0) {
				throw new Error(`cm find revision failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
			}
			for (const line of result.stdout.split(/\r?\n/).filter(l => l.length > 0)) {
				const sepIdx = line.lastIndexOf('#');
				if (sepIdx < 0) continue;
				const filePath = line.substring(0, sepIdx);
				const id = parseInt(line.substring(sepIdx + 1), 10);
				if (!isNaN(id)) pathMap.set(id, filePath);
			}
		}

		return pathMap;
	}

	// Phase 5 — Labels
	async listLabels(): Promise<LabelInfo[]> {
		const result = await execCm([
			'find', 'label',
			'--format={name}#{id}#{owner}#{date}#{changeset}#{comment}',
			'--nototal',
		]);
		if (result.exitCode !== 0) {
			throw new Error(`cm find label failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
		}
		const lines = result.stdout.split(/\r?\n/).filter(l => l.length > 0);
		return lines.map(parseLabelLine).filter((l): l is LabelInfo => l !== undefined);
	}

	async createLabel(params: CreateLabelParams): Promise<LabelInfo> {
		const args = ['label', params.name, `cs:${params.changesetId}`];
		if (params.comment) args.push(`-c=${params.comment}`);
		const result = await execCm(args);
		if (result.exitCode !== 0) {
			throw new Error(`cm label failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
		}
		return {
			id: 0, // cm doesn't return label ID
			name: params.name,
			owner: '',
			date: new Date().toISOString(),
			changesetId: params.changesetId,
			comment: params.comment,
		};
	}

	async deleteLabel(id: number): Promise<void> {
		// cm doesn't delete by ID, need to find name first
		const result = await execCm([
			'find', 'label', `where id=${id}`, '--format={name}', '--nototal',
		]);
		if (result.exitCode !== 0 || !result.stdout.trim()) {
			throw new Error(`Label with ID ${id} not found`);
		}
		const name = result.stdout.trim().split(/\r?\n/)[0].trim();
		const delResult = await execCm(['label', 'delete', name]);
		if (delResult.exitCode !== 0) {
			throw new Error(`cm label delete failed (exit ${delResult.exitCode}): ${delResult.stderr || delResult.stdout}`);
		}
	}

	// Phase 5 — File history + annotate
	async getFileHistory(path: string): Promise<FileHistoryEntry[]> {
		const result = await execCm([
			'history', path, '--format={changeset}#{branch}#{owner}#{date}#{comment}#{type}',
		]);
		if (result.exitCode !== 0) {
			throw new Error(`cm history failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
		}
		const lines = result.stdout.split(/\r?\n/).filter(l => l.length > 0);
		return lines.map(parseHistoryLine).filter((h): h is FileHistoryEntry => h !== undefined);
	}

	async getBlame(path: string): Promise<BlameLine[]> {
		const result = await execCm(['annotate', path]);
		if (result.exitCode !== 0) {
			throw new Error(`cm annotate failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
		}
		return parseAnnotateOutput(result.stdout);
	}

	// Phase 6 — Undo checkout
	async undoCheckout(paths: string[]): Promise<string[]> {
		// --silent suppresses any GUI confirmation dialogs
		const args = ['undocheckout', '--silent', ...paths];
		const result = await execCm(args);
		if (result.exitCode !== 0) {
			throw new Error(`cm undocheckout failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
		}
		log(`Undo checkout: ${paths.length} file(s)`);
		return paths;
	}

	// Phase 7 — Add private files to source control
	async addToSourceControl(paths: string[]): Promise<string[]> {
		if (paths.length === 0) return [];
		// cm add adds private (untracked) files to source control, making them AD (added).
		// This is required before they can be checked in.
		const args = ['add', ...paths];
		const result = await execCm(args);
		if (result.exitCode !== 0) {
			throw new Error(`cm add failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
		}
		log(`Added to source control: ${paths.length} file(s)`);
		return paths;
	}

	// Phase 7 — get base revision content for backup
	async getBaseRevisionContent(path: string): Promise<Buffer | null> {
		const result = await execCm(['cat', path, '--raw'], 10 * 1024 * 1024);
		if (result.exitCode === 0) {
			return Buffer.from(result.stdout, 'binary');
		}
		return null;
	}

	// Phase 5 — Merges
	async checkMergeAllowed(sourceBranch: string, targetBranch: string): Promise<MergeReport> {
		const result = await execCm([
			'merge', sourceBranch, '--to=' + targetBranch, '--preview',
		]);
		const output = result.stdout + '\n' + result.stderr;
		const conflicts = output.split(/\r?\n/)
			.filter(l => l.toLowerCase().includes('conflict'))
			.map(l => l.trim());
		return {
			canMerge: result.exitCode === 0 && conflicts.length === 0,
			conflicts,
			changes: output.split(/\r?\n/).filter(l => l.trim().length > 0).length,
			message: result.exitCode !== 0 ? output.trim() : undefined,
		};
	}

	// Phase 5 — Locks (lock rules require REST API)
	async listLockRules(): Promise<LockRuleInfo[]> { throw new NotSupportedError('listLockRules', this.name); }
	async createLockRule(): Promise<LockRuleInfo> { throw new NotSupportedError('createLockRule', this.name); }
	async deleteLockRules(): Promise<void> { throw new NotSupportedError('deleteLockRules', this.name); }
	async deleteLockRulesForRepo(): Promise<void> { throw new NotSupportedError('deleteLockRulesForRepo', this.name); }
	async releaseLocks(): Promise<void> { throw new NotSupportedError('releaseLocks', this.name); }

	async executeMerge(sourceBranch: string, targetBranch: string, comment?: string): Promise<MergeResult> {
		const args = ['merge', sourceBranch, '--to=' + targetBranch];
		if (comment) args.push(`-c=${comment}`);
		const result = await execCm(args);
		if (result.exitCode !== 0) {
			const output = result.stderr || result.stdout;
			const conflicts = output.split(/\r?\n/)
				.filter(l => l.toLowerCase().includes('conflict'))
				.map(l => l.trim());
			if (conflicts.length > 0) {
				return { changesetId: 0, conflicts };
			}
			throw new Error(`cm merge failed (exit ${result.exitCode}): ${output}`);
		}
		// Try to parse the new changeset ID from output
		const csMatch = result.stdout.match(/changeset\s+(\d+)/i);
		return {
			changesetId: csMatch ? parseInt(csMatch[1], 10) : 0,
			conflicts: [],
		};
	}
}

/**
 * Parses the stdout of `cm diff` into structured diff items.
 *
 * The `cm` CLI produces different output formats depending on the flags used,
 * the Plastic SCM version, and the platform (Windows vs Unix path separators).
 * This function handles 6 known formats, tried in priority order so that more
 * specific patterns match before more general ones.
 *
 * Formats handled (in match order):
 *  1. Machine-readable full-word status: `Added /path/to/file`
 *  2. Tab-separated status+path (either column order): `A\t/path` or `/path\tA`
 *  3a. Single-char move with two quoted paths: `M "old" "new"`
 *  3b. Single-char status with a quoted path: `C "path"`
 *  3c. Single-char status with an unquoted path: `A path`
 *  4. Bare absolute path (no status prefix, defaults to "changed")
 */
function parseDiffOutput(stdout: string): ChangesetDiffItem[] {
	const lines = stdout.split(/\r?\n/).filter(l => l.length > 0);
	const items: ChangesetDiffItem[] = [];
	for (const line of lines) {
		// Format 1 — Machine-readable full-word prefix.
		// Produced by `cm diff --machinereadable` on modern Plastic SCM versions.
		// Matches lines like: "Added /src/foo.ts", "Deleted /old/bar.cs"
		const match1 = line.match(/^(Added|Changed|Deleted|Moved)\s+(.+)$/i);
		if (match1) {
			items.push({ path: match1[2].trim(), type: classifyDiffType(match1[1]) });
			continue;
		}

		// Format 2 — Tab-separated columns.
		// Some cm versions or custom format strings produce "status\tpath" or "path\tstatus".
		// We detect which column holds the status by checking if it matches a known type token
		// (A/C/D/M or the full word). If neither column is a recognizable status, we fall
		// through and treat the first column as the path with a default type of "changed".
		if (line.includes('\t')) {
			const parts = line.split('\t');
			if (parts.length >= 2) {
				const type1 = classifyDiffType(parts[0]);
				const type2 = classifyDiffType(parts[1]);
				if (type1 !== 'changed' || parts[0].match(/^(A|C|D|M|Added|Changed|Deleted|Moved)$/i)) {
					items.push({ path: parts.slice(1).join('\t').trim(), type: type1 });
				} else if (type2 !== 'changed' || parts[1].match(/^(A|C|D|M|Added|Changed|Deleted|Moved)$/i)) {
					items.push({ path: parts[0].trim(), type: type2 });
				} else {
					// Both look like paths, treat first as path
					items.push({ path: parts[0].trim(), type: 'changed' });
				}
				continue;
			}
		}

		// Format 3a — Move operation with two quoted paths.
		// Produced when `cm diff` reports a file rename/move on Windows.
		// Example: M "src\old\file.cs" "src\new\file.cs"
		// We extract the destination (second) path and normalize backslashes.
		const matchMove = line.match(/^([M])\s+"([^"]+)"\s+"([^"]+)"\s*$/);
		if (matchMove) {
			const newPath = normalizePath(matchMove[3].trim());
			items.push({ path: newPath, type: 'moved' });
			continue;
		}

		// Format 3b — Single-char status prefix with a quoted path.
		// Common on Windows where paths containing spaces are quoted.
		// Example: C "src\some path\file.cs"
		const match3 = line.match(/^([ACDM])\s+"([^"]+)"\s*$/);
		if (match3) {
			const path = normalizePath(match3[2].trim());
			items.push({ path, type: classifyDiffType(match3[1]) });
			continue;
		}

		// Format 3c — Single-char status prefix with an unquoted path.
		// Typical compact format on Unix or Windows paths without spaces.
		// Example: A src/newFile.ts
		const match3c = line.match(/^([ACDM])\s+(.+?)\s*$/);
		if (match3c) {
			const path = normalizePath(match3c[2].trim());
			items.push({ path, type: classifyDiffType(match3c[1]) });
			continue;
		}

		// Format 4 — Bare absolute path with no status indicator.
		// Fallback for output that only lists affected paths (Unix absolute or Windows drive letter).
		// Defaults to "changed" since no status information is available.
		if (line.startsWith('/') || line.match(/^[a-zA-Z]:\\/)) {
			items.push({ path: line.trim(), type: 'changed' });
		}
	}
	return items;
}

function classifyDiffType(s: string): 'added' | 'changed' | 'deleted' | 'moved' {
	const lower = s.trim().toLowerCase();
	if (lower === 'a' || lower === 'added' || lower.startsWith('add')) return 'added';
	if (lower === 'd' || lower === 'deleted' || lower.startsWith('del')) return 'deleted';
	if (lower === 'm' || lower === 'moved' || lower.startsWith('mov')) return 'moved';
	return 'changed';
}

function parseRevisionLine(line: string): ChangesetDiffItem | undefined {
	const parts = line.split('#');
	if (parts.length < 1 || !parts[0].trim()) return undefined;
	const path = parts[0].trim();
	// Skip repository root entries
	if (path === '/' || path === '\\') return undefined;
	const typeStr = (parts[1] || '').toLowerCase();
	const type = typeStr.includes('add') ? 'added'
		: typeStr.includes('del') ? 'deleted'
		: typeStr.includes('mov') ? 'moved'
		: 'changed';
	return { path, type };
}

function buildChangesetQuery(branchName?: string, limit?: number): string {
	const parts: string[] = [];
	if (branchName) {
		parts.push(`where branch='${branchName}'`);
	}
	parts.push('order by changesetid desc');
	if (limit) {
		parts.push(`limit ${limit}`);
	}
	return parts.join(' ');
}

function parseChangesetLine(line: string): ChangesetInfo | undefined {
	const parts = line.split('#');
	if (parts.length < 6) return undefined;

	const id = parseInt(parts[0], 10);
	if (isNaN(id)) return undefined;

	return {
		id,
		branch: parts[1],
		owner: parts[2],
		date: parts[3],
		comment: parts[4] || undefined,
		parent: parseInt(parts[5], 10) || 0,
	};
}

function parseChangesetLineNoParent(line: string): ChangesetInfo | undefined {
	const parts = line.split('#');
	if (parts.length < 5) return undefined;

	const id = parseInt(parts[0], 10);
	if (isNaN(id)) return undefined;

	return {
		id,
		branch: parts[1],
		owner: parts[2],
		date: parts[3],
		comment: parts[4] || undefined,
		parent: id > 0 ? id - 1 : 0, // best-guess sequential parent
	};
}

function parseBranchLine(line: string): BranchInfo | undefined {
	const parts = line.split('#');
	if (parts.length < 5) return undefined;

	const name = parts[0];
	return {
		name,
		id: parseInt(parts[1], 10) || 0,
		owner: parts[2],
		date: parts[3],
		comment: parts[4] || undefined,
		isMain: name === '/main' || name.endsWith('/main'),
	};
}

function parseStatusLine(line: string): NormalizedChange | undefined {
	const typeCode = line.substring(0, 2).trim();
	const changeType = CM_CHANGE_TYPE_MAP[typeCode];
	if (!changeType) return undefined;

	let rest = line.substring(3);

	// cm status can emit compound type codes (e.g. "AD LD <path>").
	// If the remainder starts with another known type code, consume it
	// and use the later (more specific) type as the effective change type.
	let effectiveType = changeType;
	const secondCode = rest.substring(0, 2).trim();
	if (secondCode.length === 2 && CM_CHANGE_TYPE_MAP[secondCode] && rest.charAt(2) === ' ') {
		effectiveType = CM_CHANGE_TYPE_MAP[secondCode];
		rest = rest.substring(3);
	}
	const lastSpace = rest.lastIndexOf(' ');
	if (lastSpace < 0) return undefined;

	const beforeMerge = rest.substring(0, lastSpace);
	const secondLastSpace = beforeMerge.lastIndexOf(' ');
	if (secondLastSpace < 0) return undefined;

	const isDirStr = beforeMerge.substring(secondLastSpace + 1);
	let filePath = beforeMerge.substring(0, secondLastSpace);
	if (!filePath) return undefined;

	// For moved files, filePath contains both old and new absolute paths joined by a space.
	// Split them using the workspace root as anchor (both paths start with it).
	let sourcePath: string | undefined;
	if (effectiveType === 'moved') {
		const root = getCmWorkspaceRoot();
		if (root) {
			const normalizedRoot = normalizePath(root).toLowerCase();
			const normalizedFilePath = normalizePath(filePath).toLowerCase();
			// Find the second occurrence of the workspace root in the path string
			const firstIdx = normalizedFilePath.indexOf(normalizedRoot);
			if (firstIdx >= 0) {
				const searchFrom = firstIdx + normalizedRoot.length;
				const secondIdx = normalizedFilePath.indexOf(normalizedRoot, searchFrom);
				if (secondIdx > 0) {
					const oldRaw = filePath.substring(firstIdx, secondIdx).trim();
					const newRaw = filePath.substring(secondIdx).trim();
					sourcePath = stripWorkspaceRoot(oldRaw);
					filePath = newRaw;
				}
			}
		}
	}

	// cm status returns absolute paths — strip the workspace root to get relative paths
	filePath = stripWorkspaceRoot(filePath);

	// Only log compound type codes and unparseable edge cases — skip routine lines
	if (effectiveType !== changeType) {
		log(`[parseStatusLine] compound code="${typeCode}+${secondCode}" path="${filePath}"`);
	}
	if (sourcePath) {
		log(`[parseStatusLine] moved: "${sourcePath}" → "${filePath}"`);
	}

	return {
		path: filePath,
		changeType: effectiveType,
		dataType: isDirStr === 'True' ? 'Directory' : 'File',
		sourcePath,
	};
}

/**
 * Strip the workspace root prefix from an absolute path to produce a relative path.
 * Handles both forward and back slashes, case-insensitive on Windows.
 * Rejects paths that escape the workspace root (e.g., via ".." traversal).
 */
function stripWorkspaceRoot(filePath: string): string {
	const root = getCmWorkspaceRoot();
	if (!root) return filePath;

	// Normalize separators for comparison
	const normalizedPath = normalizePath(filePath);
	const normalizedRoot = normalizePath(root).replace(/\/$/, '');

	// Case-insensitive comparison (Windows paths)
	if (normalizedPath.toLowerCase().startsWith(normalizedRoot.toLowerCase())) {
		let relative = normalizedPath.substring(normalizedRoot.length);
		if (relative.startsWith('/')) {
			relative = relative.substring(1);
		}

		// Reject paths that escape the workspace via ".." traversal
		if (relative.includes('..')) {
			log(`[stripWorkspaceRoot] rejected path with "..": "${filePath}"`);
			return filePath;
		}

		return relative;
	}

	return filePath;
}

function parseLabelLine(line: string): LabelInfo | undefined {
	const parts = line.split('#');
	if (parts.length < 5) return undefined;
	return {
		name: parts[0],
		id: parseInt(parts[1], 10) || 0,
		owner: parts[2],
		date: parts[3],
		changesetId: parseInt(parts[4], 10) || 0,
		comment: parts[5] || undefined,
	};
}

function parseHistoryLine(line: string): FileHistoryEntry | undefined {
	const parts = line.split('#');
	if (parts.length < 5) return undefined;
	const csId = parseInt(parts[0], 10);
	if (isNaN(csId)) return undefined;
	const typeStr = (parts[5] || '').toLowerCase();
	return {
		revisionId: 0,
		changesetId: csId,
		branch: parts[1],
		owner: parts[2],
		date: parts[3],
		comment: parts[4] || undefined,
		type: typeStr.includes('add') ? 'added'
			: typeStr.includes('del') ? 'deleted'
			: typeStr.includes('mov') ? 'moved'
			: 'changed',
	};
}

function parseReviewLine(line: string): CodeReviewInfo | undefined {
	const parts = line.split('#');
	if (parts.length < 7) return undefined;

	const id = parseInt(parts[0], 10);
	if (isNaN(id)) return undefined;

	// Status comes prefixed with "Status " — strip it
	const rawStatus = parts[2];
	const status = rawStatus.startsWith('Status ')
		? rawStatus.substring(7) as ReviewStatus
		: rawStatus as ReviewStatus;

	const target = parts[6];
	const targetId = /^\d+$/.test(target) ? parseInt(target, 10) : 0;
	const assignee = parts[7]?.trim() || undefined;

	return {
		id,
		title: parts[1],
		status,
		owner: parts[3],
		created: parts[4],
		modified: parts[4],
		targetType: parts[5] as 'Branch' | 'Changeset',
		targetSpec: target,
		targetId,
		assignee,
		commentsCount: 0,
		reviewers: [],
	};
}

export function classifyComment(raw: string): { type: ReviewCommentType; text: string } {
	if (raw.startsWith('[status-reviewed]')) {
		return { type: 'StatusReviewed', text: raw.substring('[status-reviewed]'.length) };
	}
	if (raw.startsWith('[status-rework-required]')) {
		return { type: 'StatusReworkRequired', text: raw.substring('[status-rework-required]'.length) };
	}
	if (raw.startsWith('[status-under-review]')) {
		return { type: 'StatusUnderReview', text: raw.substring('[status-under-review]'.length) };
	}
	if (raw.startsWith('[description]')) {
		return { type: 'Comment', text: raw.substring('[description]'.length) };
	}
	return { type: 'Comment', text: raw };
}

export function parseReviewCommentXml(xml: string): ReviewCommentInfo[] {
	const comments: ReviewCommentInfo[] = [];
	const blockRegex = /<REVIEWCOMMENT>([\s\S]*?)<\/REVIEWCOMMENT>/g;
	let blockMatch: RegExpExecArray | null;

	while ((blockMatch = blockRegex.exec(xml)) !== null) {
		const block = blockMatch[1];

		const extractField = (tag: string): string => {
			const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
			return m ? m[1] : '';
		};

		const rawComment = extractField('COMMENT');

		// Filter out reviewer-request events
		if (rawComment.startsWith('[requested-review-from-')) {
			continue;
		}

		const id = parseInt(extractField('ID'), 10);
		const owner = extractField('OWNER');
		const date = extractField('DATE');
		const revisionId = parseInt(extractField('REVISIONID'), 10);
		const reviewId = parseInt(extractField('REVIEWID'), 10);
		const location = parseInt(extractField('LOCATION'), 10);

		const { type, text } = classifyComment(rawComment);

		const locationSpec = revisionId > 0 && location >= 0
			? `${revisionId}#${location}`
			: undefined;

		const itemName = revisionId > 0
			? `revid:${revisionId}`
			: undefined;

		comments.push({
			id,
			owner,
			text,
			type,
			timestamp: date,
			locationSpec,
			itemName,
		});
	}

	return comments;
}

export function extractReviewersFromComments(xml: string): ReviewerInfo[] {
	const reviewers = new Map<string, ReviewStatus>();
	const blockRegex = /<REVIEWCOMMENT>([\s\S]*?)<\/REVIEWCOMMENT>/g;
	let blockMatch: RegExpExecArray | null;

	while ((blockMatch = blockRegex.exec(xml)) !== null) {
		const block = blockMatch[1];

		const extractField = (tag: string): string => {
			const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
			return m ? m[1] : '';
		};

		const rawComment = extractField('COMMENT');
		const owner = extractField('OWNER');

		// Track reviewer additions
		const requestMatch = rawComment.match(/^\[requested-review-from-(.+)\]$/);
		if (requestMatch) {
			const user = requestMatch[1];
			if (!reviewers.has(user)) {
				reviewers.set(user, 'Under review');
			}
			continue;
		}

		// Track status changes by the comment owner
		if (rawComment.startsWith('[status-reviewed]')) {
			reviewers.set(owner, 'Reviewed');
		} else if (rawComment.startsWith('[status-rework-required]')) {
			reviewers.set(owner, 'Rework required');
		}
	}

	return Array.from(reviewers.entries()).map(([name, status]) => ({
		name,
		status,
		isGroup: false,
	}));
}

function parseAnnotateOutput(stdout: string): BlameLine[] {
	const lines = stdout.split(/\r?\n/);
	const result: BlameLine[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line) continue;
		// cm annotate format: "cs:N owner date | content"
		const match = line.match(/^cs:(\d+)\s+(\S+)\s+(\S+)\s+\|\s?(.*)$/);
		if (match) {
			result.push({
				lineNumber: i + 1,
				changesetId: parseInt(match[1], 10),
				author: match[2],
				date: match[3],
				content: match[4],
				revisionId: 0,
			});
		} else {
			// Fallback: just store the line content
			result.push({
				lineNumber: i + 1,
				changesetId: 0,
				author: '',
				date: '',
				content: line,
				revisionId: 0,
			});
		}
	}
	return result;
}
