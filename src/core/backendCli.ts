import { execCm, getCmWorkspaceRoot } from './cmCli';
import { log } from '../util/logger';
import type { PlasticBackend } from './backend';
import type {
	StatusResult,
	CheckinResult,
	NormalizedChange,
	StatusChangeType,
	BranchInfo,
	ChangesetInfo,
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
		const result = await execCm(['wi', '--machinereadable']);
		if (result.exitCode !== 0) {
			throw new Error(`cm wi failed (exit ${result.exitCode}): ${result.stderr}`);
		}

		const line = result.stdout.trim();
		const match = line.match(/^BR\s+(\S+)/);
		return match?.[1] ?? undefined;
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

	async getFileContent(revSpec: string): Promise<Uint8Array | undefined> {
		const result = await execCm(['cat', revSpec, '--raw']);
		if (result.exitCode !== 0) {
			// Exit code != 0 for "file not found at revision" is legitimate absence
			return undefined;
		}
		return Buffer.from(result.stdout, 'binary');
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
