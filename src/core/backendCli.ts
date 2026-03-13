import { execCm, execCmToFile, getCmWorkspaceRoot } from './cmCli';
import { readFile, unlink } from 'fs/promises';
import { log } from '../util/logger';
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
} from './types';

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

export class CliBackend implements PlasticBackend {
	readonly name = 'cm CLI';

	async getStatus(showPrivate: boolean): Promise<StatusResult> {
		const result = await execCm(['status', '--machinereadable', '--all']);
		if (result.exitCode !== 0) {
			throw new Error(`cm status failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
		}

		const lines = result.stdout.split(/\r?\n/).filter(l => l.length > 0);
		const changes: NormalizedChange[] = [];

		// Log first 10 raw lines for debugging
		for (let i = 0; i < Math.min(lines.length, 10); i++) {
			log(`[cm status raw] line[${i}]: "${lines[i]}"`);
		}
		if (lines.length > 10) {
			log(`[cm status raw] ... and ${lines.length - 10} more lines`);
		}

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

		// Fallback 1: try cm diff without --machinereadable
		const result2 = await execCm(['diff', `cs:${parentId}`, `cs:${changesetId}`]);
		if (result2.exitCode === 0 && result2.stdout.trim().length > 0) {
			log(`[getChangesetDiff] cm diff (no flag) raw output (first 500): ${result2.stdout.substring(0, 500)}`);
			const items = parseDiffOutput(result2.stdout);
			if (items.length > 0) {
				log(`[getChangesetDiff] parsed ${items.length} items from cm diff (no flag)`);
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
}

function parseDiffOutput(stdout: string): ChangesetDiffItem[] {
	const lines = stdout.split(/\r?\n/).filter(l => l.length > 0);
	const items: ChangesetDiffItem[] = [];
	for (const line of lines) {
		// Format 1: cm diff --machinereadable: "<type> <path>"
		// Types: Added, Changed, Deleted, Moved
		const match1 = line.match(/^(Added|Changed|Deleted|Moved)\s+(.+)$/i);
		if (match1) {
			items.push({ path: match1[2].trim(), type: classifyDiffType(match1[1]) });
			continue;
		}

		// Format 2: tab-separated "path\tstatus" or "status\tpath"
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

		// Format 3a: Move with two quoted paths: M "old\path" "new\path"
		const matchMove = line.match(/^([M])\s+"([^"]+)"\s+"([^"]+)"\s*$/);
		if (matchMove) {
			// Use the destination (new) path for display
			const newPath = matchMove[3].trim().replace(/\\/g, '/');
			items.push({ path: newPath, type: 'moved' });
			continue;
		}

		// Format 3b: single-character prefix with optional quotes: C "path" or A path
		const match3 = line.match(/^([ACDM])\s+"([^"]+)"\s*$/);
		if (match3) {
			const path = match3[2].trim().replace(/\\/g, '/');
			items.push({ path, type: classifyDiffType(match3[1]) });
			continue;
		}

		// Format 3c: single-character prefix without quotes
		const match3c = line.match(/^([ACDM])\s+(.+?)\s*$/);
		if (match3c) {
			const path = match3c[2].trim().replace(/\\/g, '/');
			items.push({ path, type: classifyDiffType(match3c[1]) });
			continue;
		}

		// Format 4: just a path (assume changed)
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

	// cm status returns absolute paths — strip the workspace root to get relative paths
	filePath = stripWorkspaceRoot(filePath);

	log(`[parseStatusLine] code="${typeCode}${effectiveType !== changeType ? '+' + secondCode : ''}" isDirStr="${isDirStr}" path="${filePath}"`);

	return {
		path: filePath,
		changeType: effectiveType,
		dataType: isDirStr === 'True' ? 'Directory' : 'File',
	};
}

/**
 * Strip the workspace root prefix from an absolute path to produce a relative path.
 * Handles both forward and back slashes, case-insensitive on Windows.
 */
function stripWorkspaceRoot(filePath: string): string {
	const root = getCmWorkspaceRoot();
	if (!root) return filePath;

	// Normalize separators for comparison
	const normalizedPath = filePath.replace(/\\/g, '/');
	const normalizedRoot = root.replace(/\\/g, '/').replace(/\/$/, '');

	// Case-insensitive comparison (Windows paths)
	if (normalizedPath.toLowerCase().startsWith(normalizedRoot.toLowerCase())) {
		let relative = normalizedPath.substring(normalizedRoot.length);
		if (relative.startsWith('/')) {
			relative = relative.substring(1);
		}
		return relative;
	}

	return filePath;
}
