import { describe, it, expect, vi, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Mock cmCli — detectStaleChanges / isFileStale call execCmToFile to fetch base revision.
vi.mock('../../../src/core/cmCli', () => ({
	execCmToFile: vi.fn(),
}));

import { execCmToFile } from '../../../src/core/cmCli';
import {
	hashFile,
	isFileStale,
	detectStaleChanges,
	STALE_CANDIDATE_CHANGE_TYPES,
	STALE_DETECTION_BATCH_SIZE,
} from '../../../src/core/staleDetection';
import type { NormalizedChange } from '../../../src/core/types';

// ── Test fixture helpers ─────────────────────────────────────────────

/** Write a file with given content and return the absolute path. */
function writeTempFile(name: string, content: string | Buffer): string {
	const path = join(tmpdir(), `bpscm-stale-test-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
	writeFileSync(path, content);
	return path;
}

const tempFiles: string[] = [];

function tempFile(name: string, content: string | Buffer): string {
	const p = writeTempFile(name, content);
	tempFiles.push(p);
	return p;
}

afterEach(() => {
	for (const f of tempFiles) {
		if (existsSync(f)) {
			try { unlinkSync(f); } catch { /* ignore */ }
		}
	}
	tempFiles.length = 0;
	vi.mocked(execCmToFile).mockReset();
});

// ── hashFile ────────────────────────────────────────────────────────

describe('hashFile', () => {
	it('hashes an empty file to the known SHA-256 digest', async () => {
		const path = tempFile('empty.txt', '');
		const digest = await hashFile(path);
		// SHA-256 of empty string
		expect(digest).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
	});

	it('hashes identical content to identical digests', async () => {
		const a = tempFile('a.txt', 'hello world');
		const b = tempFile('b.txt', 'hello world');
		const [hashA, hashB] = await Promise.all([hashFile(a), hashFile(b)]);
		expect(hashA).toBe(hashB);
	});

	it('hashes different content to different digests', async () => {
		const a = tempFile('a.txt', 'hello');
		const b = tempFile('b.txt', 'world');
		const [hashA, hashB] = await Promise.all([hashFile(a), hashFile(b)]);
		expect(hashA).not.toBe(hashB);
	});

	it('rejects on missing file', async () => {
		await expect(hashFile('/nonexistent/path/file.txt')).rejects.toThrow();
	});
});

// ── isFileStale ─────────────────────────────────────────────────────

describe('isFileStale', () => {
	it('returns true when working copy matches base revision', async () => {
		const wsRoot = tmpdir();
		const baseCopy = tempFile('base-match.txt', 'identical content');
		vi.mocked(execCmToFile).mockResolvedValue(baseCopy);

		// isFileStale joins wsRoot + filePath, so write the working copy to a
		// predictable path under wsRoot that we control.
		const relName = `bpscm-stale-work-${Date.now()}.txt`;
		const absWork = join(wsRoot, relName);
		writeFileSync(absWork, 'identical content');
		tempFiles.push(absWork);

		const stale = await isFileStale(relName, wsRoot);
		expect(stale).toBe(true);
	});

	it('returns false when working copy differs from base revision', async () => {
		const wsRoot = tmpdir();
		const baseCopy = tempFile('base-diff.txt', 'base content');
		vi.mocked(execCmToFile).mockResolvedValue(baseCopy);

		const relName = `bpscm-stale-diff-${Date.now()}.txt`;
		const absWork = join(wsRoot, relName);
		writeFileSync(absWork, 'modified content');
		tempFiles.push(absWork);

		const stale = await isFileStale(relName, wsRoot);
		expect(stale).toBe(false);
	});

	it('returns false when base revision cannot be fetched', async () => {
		vi.mocked(execCmToFile).mockResolvedValue(undefined);
		const stale = await isFileStale('some/file.txt', tmpdir());
		expect(stale).toBe(false);
	});

	it('returns false when working copy is missing', async () => {
		const baseCopy = tempFile('base-only.txt', 'content');
		vi.mocked(execCmToFile).mockResolvedValue(baseCopy);
		const stale = await isFileStale('nonexistent-file.txt', '/nonexistent-root');
		expect(stale).toBe(false);
	});

	it('cleans up the base temp file after comparison', async () => {
		const baseCopy = tempFile('base-cleanup.txt', 'content');
		vi.mocked(execCmToFile).mockResolvedValue(baseCopy);

		const relName = `bpscm-stale-cleanup-${Date.now()}.txt`;
		const absWork = join(tmpdir(), relName);
		writeFileSync(absWork, 'content');
		tempFiles.push(absWork);

		await isFileStale(relName, tmpdir());

		// Allow the unlink promise microtask to resolve.
		await new Promise(resolve => setImmediate(resolve));
		expect(existsSync(baseCopy)).toBe(false);
	});
});

// ── detectStaleChanges ──────────────────────────────────────────────

describe('detectStaleChanges', () => {
	const mkChange = (overrides: Partial<NormalizedChange>): NormalizedChange => ({
		path: overrides.path ?? 'file.txt',
		changeType: overrides.changeType ?? 'changed',
		dataType: overrides.dataType ?? 'File',
		sourcePath: overrides.sourcePath,
		revisionGuid: overrides.revisionGuid,
		oldRevisionId: overrides.oldRevisionId,
	});

	it('skips directories', async () => {
		const result = await detectStaleChanges(
			[mkChange({ path: 'src', dataType: 'Directory' })],
			tmpdir(),
		);
		expect(result.skippedPaths).toEqual(['src']);
		expect(result.stalePaths).toEqual([]);
		expect(execCmToFile).not.toHaveBeenCalled();
	});

	it('skips non-candidate change types (added, deleted, moved)', async () => {
		const result = await detectStaleChanges(
			[
				mkChange({ path: 'new.ts', changeType: 'added' }),
				mkChange({ path: 'gone.ts', changeType: 'deleted' }),
				mkChange({ path: 'renamed.ts', changeType: 'moved' }),
			],
			tmpdir(),
		);
		expect(result.skippedPaths).toEqual(['new.ts', 'gone.ts', 'renamed.ts']);
		expect(result.stalePaths).toEqual([]);
		expect(execCmToFile).not.toHaveBeenCalled();
	});

	it('scans changed and checkedOut files', async () => {
		const wsRoot = tmpdir();
		const relWork = `bpscm-detect-work-${Date.now()}.txt`;
		const absWork = join(wsRoot, relWork);
		writeFileSync(absWork, 'same');
		tempFiles.push(absWork);

		const baseCopy = tempFile('detect-base.txt', 'same');
		vi.mocked(execCmToFile).mockResolvedValue(baseCopy);

		const result = await detectStaleChanges(
			[mkChange({ path: relWork, changeType: 'changed' })],
			wsRoot,
		);
		expect(result.stalePaths).toEqual([relWork]);
		expect(result.trulyChangedPaths).toEqual([]);
	});

	it('separates stale from truly changed files', async () => {
		const wsRoot = tmpdir();

		const relStale = `bpscm-detect-stale-${Date.now()}.txt`;
		const absStale = join(wsRoot, relStale);
		writeFileSync(absStale, 'matches');
		tempFiles.push(absStale);

		const relChanged = `bpscm-detect-changed-${Date.now()}.txt`;
		const absChanged = join(wsRoot, relChanged);
		writeFileSync(absChanged, 'different from base');
		tempFiles.push(absChanged);

		vi.mocked(execCmToFile).mockImplementation(async (args: string[]) => {
			// execCmToFile is called as execCmToFile(['cat', filePath, '--raw'])
			const filePath = args[1];
			if (filePath === relStale) {
				return tempFile('base-stale.txt', 'matches');
			}
			return tempFile('base-changed.txt', 'base content');
		});

		const result = await detectStaleChanges(
			[
				mkChange({ path: relStale, changeType: 'changed' }),
				mkChange({ path: relChanged, changeType: 'changed' }),
			],
			wsRoot,
		);
		expect(result.stalePaths).toEqual([relStale]);
		expect(result.trulyChangedPaths).toEqual([relChanged]);
	});

	it('batches large inputs without losing files', async () => {
		const wsRoot = tmpdir();
		const count = STALE_DETECTION_BATCH_SIZE * 3 + 2; // 17 files, exercises multiple batches
		const changes: NormalizedChange[] = [];
		for (let i = 0; i < count; i++) {
			const rel = `bpscm-batch-${Date.now()}-${i}.txt`;
			const abs = join(wsRoot, rel);
			writeFileSync(abs, `file-${i}`);
			tempFiles.push(abs);
			changes.push(mkChange({ path: rel, changeType: 'changed' }));
		}

		// Every base matches every working copy — all should be flagged stale.
		vi.mocked(execCmToFile).mockImplementation(async (args: string[]) => {
			const filePath = args[1];
			const idx = changes.findIndex(c => c.path === filePath);
			return tempFile(`base-${idx}.txt`, `file-${idx}`);
		});

		const result = await detectStaleChanges(changes, wsRoot);
		expect(result.stalePaths).toHaveLength(count);
		expect(result.trulyChangedPaths).toEqual([]);
	});

	it('handles empty change list', async () => {
		const result = await detectStaleChanges([], tmpdir());
		expect(result.stalePaths).toEqual([]);
		expect(result.trulyChangedPaths).toEqual([]);
		expect(result.skippedPaths).toEqual([]);
		expect(execCmToFile).not.toHaveBeenCalled();
	});
});

// ── Constants ───────────────────────────────────────────────────────

describe('stale detection constants', () => {
	it('STALE_CANDIDATE_CHANGE_TYPES includes changed and checkedOut', () => {
		expect(STALE_CANDIDATE_CHANGE_TYPES.has('changed')).toBe(true);
		expect(STALE_CANDIDATE_CHANGE_TYPES.has('checkedOut')).toBe(true);
	});

	it('STALE_CANDIDATE_CHANGE_TYPES excludes non-modification types', () => {
		expect(STALE_CANDIDATE_CHANGE_TYPES.has('added')).toBe(false);
		expect(STALE_CANDIDATE_CHANGE_TYPES.has('deleted')).toBe(false);
		expect(STALE_CANDIDATE_CHANGE_TYPES.has('moved')).toBe(false);
		expect(STALE_CANDIDATE_CHANGE_TYPES.has('private')).toBe(false);
	});

	it('STALE_DETECTION_BATCH_SIZE is positive', () => {
		expect(STALE_DETECTION_BATCH_SIZE).toBeGreaterThan(0);
	});
});
