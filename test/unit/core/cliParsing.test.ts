/**
 * Tests for CLI output parsing edge cases.
 * These verify the robustness of parseDiffOutput, parseStatusLine, etc.
 * which are critical code paths without direct unit test coverage.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/core/cmCli', () => ({
	execCm: vi.fn(),
	execCmToFile: vi.fn(),
	getCmWorkspaceRoot: vi.fn(() => undefined),
}));

vi.mock('../../../src/util/plasticDetector', () => ({
	hasPlasticWorkspace: vi.fn(() => false),
	detectWorkspace: vi.fn(),
}));

vi.mock('fs/promises', () => ({
	readFile: vi.fn(),
	unlink: vi.fn(),
}));

import { CliBackend } from '../../../src/core/backendCli';
import { execCm, getCmWorkspaceRoot } from '../../../src/core/cmCli';

const mockExecCm = vi.mocked(execCm);
const mockGetRoot = vi.mocked(getCmWorkspaceRoot);

describe('CLI output parsing edge cases', () => {
	let backend: CliBackend;

	beforeEach(() => {
		vi.clearAllMocks();
		backend = new CliBackend();
	});

	describe('status parsing — malformed input', () => {
		it('skips lines with unknown type codes', async () => {
			mockExecCm.mockResolvedValue({
				stdout: 'XX /src/foo.ts False NO_MERGE\nCH /src/bar.ts False NO_MERGE\n',
				stderr: '', exitCode: 0,
			});

			const result = await backend.getStatus(true);
			expect(result.changes).toHaveLength(1);
			expect(result.changes[0].path).toBe('/src/bar.ts');
		});

		it('handles empty lines and whitespace', async () => {
			mockExecCm.mockResolvedValue({
				stdout: '\n  \n\nCH /src/foo.ts False NO_MERGE\n\n',
				stderr: '', exitCode: 0,
			});

			const result = await backend.getStatus(true);
			expect(result.changes).toHaveLength(1);
		});

		it('handles lines with only type code and no path', async () => {
			mockExecCm.mockResolvedValue({
				stdout: 'CH\n',
				stderr: '', exitCode: 0,
			});

			const result = await backend.getStatus(true);
			expect(result.changes).toHaveLength(0);
		});

		it('handles triple compound type codes gracefully', async () => {
			// If cm ever emits 3 codes, the parser should still not crash
			mockExecCm.mockResolvedValue({
				stdout: 'AD LD MV /some/path False NO_MERGE\n',
				stderr: '', exitCode: 0,
			});

			const result = await backend.getStatus(true);
			// May or may not parse correctly, but must not throw
			expect(result.changes.length).toBeGreaterThanOrEqual(0);
		});

		it('handles paths with # characters', async () => {
			// # is used as delimiter in branch/changeset parsing — paths with # could be tricky
			mockExecCm.mockResolvedValue({
				stdout: 'CH /src/file#backup.ts False NO_MERGE\n',
				stderr: '', exitCode: 0,
			});

			const result = await backend.getStatus(true);
			// Path should contain the # character
			expect(result.changes).toHaveLength(1);
			expect(result.changes[0].path).toContain('#');
		});
	});

	describe('diff parsing — edge cases', () => {
		it('handles empty diff output', async () => {
			mockExecCm.mockResolvedValue({
				stdout: '', stderr: '', exitCode: 0,
			});
			// Second call also empty
			mockExecCm.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
			// Fallback cm find revision also empty
			mockExecCm.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });

			const result = await backend.getChangesetDiff(2, 1);
			expect(result).toEqual([]);
		});

		it('handles tab-separated format', async () => {
			mockExecCm.mockResolvedValue({
				stdout: 'A\t/src/new.ts\nC\t/src/changed.ts\n',
				stderr: '', exitCode: 0,
			});

			const result = await backend.getChangesetDiff(2, 1);
			expect(result).toHaveLength(2);
			expect(result[0].type).toBe('added');
			expect(result[1].type).toBe('changed');
		});

		it('handles Windows-style backslash paths', async () => {
			mockExecCm.mockResolvedValue({
				stdout: 'A "src\\new file.ts"\n',
				stderr: '', exitCode: 0,
			});

			const result = await backend.getChangesetDiff(2, 1);
			expect(result).toHaveLength(1);
			expect(result[0].path).toBe('src/new file.ts');
		});
	});

	describe('branch parsing — edge cases', () => {
		it('handles branch names with special characters', async () => {
			mockExecCm.mockResolvedValue({
				stdout: '/main/feature-ABC_123#5#alice#2026-01-01#comment with spaces\n',
				stderr: '', exitCode: 0,
			});

			const branches = await backend.listBranches();
			expect(branches).toHaveLength(1);
			expect(branches[0].name).toBe('/main/feature-ABC_123');
			expect(branches[0].comment).toBe('comment with spaces');
		});

		it('handles branch with empty comment', async () => {
			mockExecCm.mockResolvedValue({
				stdout: '/main/dev#3#bob#2026-01-01#\n',
				stderr: '', exitCode: 0,
			});

			const branches = await backend.listBranches();
			expect(branches).toHaveLength(1);
			expect(branches[0].comment).toBeUndefined();
		});
	});

	describe('changeset parsing — edge cases', () => {
		it('handles changeset with # in comment', async () => {
			// Comment field contains # — the @@CS@@ marker approach with {comment}
			// last means extra #s are collected into the comment via join.
			mockExecCm.mockResolvedValue({
				stdout: '@@CS@@42#/main#alice#2026-01-01T00:00:00Z#41#fix issue #123\n',
				stderr: '', exitCode: 0,
			});

			const result = await backend.listChangesets();
			expect(result).toHaveLength(1);
			expect(result[0].id).toBe(42);
			expect(result[0].parent).toBe(41);
			expect(result[0].comment).toBe('fix issue #123');
		});

		it('handles NaN changeset IDs', async () => {
			mockExecCm.mockResolvedValue({
				stdout: '@@CS@@not-a-number#/main#alice#2026-01-01T00:00:00Z#0#comment\n',
				stderr: '', exitCode: 0,
			});

			const result = await backend.listChangesets();
			expect(result).toHaveLength(0);
		});

		it('does not drop changesets with multi-line comments', async () => {
			// Before the fix, multi-line comments fragmented the record across
			// newlines, causing both fragments to fail the parts.length check
			// and silently dropping the changeset.
			mockExecCm.mockResolvedValue({
				stdout: [
					'@@CS@@10#/main#alice#2026-01-01T00:00:00Z#9#simple comment',
					'@@CS@@11#/main#bob#2026-01-02T00:00:00Z#10#line one',
					'line two',
					'line three',
					'@@CS@@12#/main#carol#2026-01-03T00:00:00Z#11#another simple',
				].join('\n'),
				stderr: '', exitCode: 0,
			});

			const result = await backend.listChangesets();
			expect(result).toHaveLength(3);
			expect(result[0].id).toBe(10);
			expect(result[0].comment).toBe('simple comment');
			expect(result[1].id).toBe(11);
			expect(result[1].comment).toBe('line one\nline two\nline three');
			expect(result[1].parent).toBe(10);
			expect(result[2].id).toBe(12);
			expect(result[2].comment).toBe('another simple');
		});

		it('handles comments with multiple # characters and preserves full text', async () => {
			mockExecCm.mockResolvedValue({
				stdout: '@@CS@@50#/main/feature#dev#2026-03-15T10:30:00Z#49#fix #42: refactor auth (#17) — closes #99\n',
				stderr: '', exitCode: 0,
			});

			const result = await backend.listChangesets();
			expect(result).toHaveLength(1);
			expect(result[0].id).toBe(50);
			expect(result[0].branch).toBe('/main/feature');
			expect(result[0].parent).toBe(49);
			expect(result[0].comment).toBe('fix #42: refactor auth (#17) — closes #99');
		});

		it('handles empty comment', async () => {
			mockExecCm.mockResolvedValue({
				stdout: '@@CS@@7#/main#alice#2026-01-01T00:00:00Z#6#\n',
				stderr: '', exitCode: 0,
			});

			const result = await backend.listChangesets();
			expect(result).toHaveLength(1);
			expect(result[0].id).toBe(7);
			expect(result[0].comment).toBeUndefined();
		});

		it('falls back to no-parent parser and handles multi-line comments', async () => {
			// First call fails with "parent" in stderr → triggers fallback
			mockExecCm.mockResolvedValueOnce({
				stdout: '', stderr: 'Unknown field: parent', exitCode: 1,
			});
			// Fallback call succeeds with @@CS@@ marker format (no parent field)
			mockExecCm.mockResolvedValueOnce({
				stdout: [
					'@@CS@@20#/main#alice#2026-01-01T00:00:00Z#first line',
					'second line',
					'@@CS@@21#/main#bob#2026-01-02T00:00:00Z#simple',
				].join('\n'),
				stderr: '', exitCode: 0,
			});

			const result = await backend.listChangesets();
			expect(result).toHaveLength(2);
			expect(result[0].id).toBe(20);
			expect(result[0].comment).toBe('first line\nsecond line');
			expect(result[0].parent).toBe(19); // best-guess sequential parent
			expect(result[1].id).toBe(21);
			expect(result[1].comment).toBe('simple');
		});
	});

	describe('annotate parsing', () => {
		// Real `getBlame` invokes cm with an explicit `{line}\u001f{changeset}\u001f…`
		// format; the parser is built around that delimiter, so fixtures must use it.
		const SEP = '\u001f';
		it('parses standard annotate format', async () => {
			mockExecCm.mockResolvedValue({
				stdout:
					`1${SEP}42${SEP}alice${SEP}2026-01-01${SEP}const x = 1;\n` +
					`2${SEP}43${SEP}bob${SEP}2026-01-02${SEP}const y = 2;\n`,
				stderr: '', exitCode: 0,
			});

			const blame = await backend.getBlame('/src/foo.ts');
			expect(blame).toHaveLength(2);
			expect(blame[0].changesetId).toBe(42);
			expect(blame[0].author).toBe('alice');
			expect(blame[0].content).toBe('const x = 1;');
			expect(blame[1].lineNumber).toBe(2);
		});

		it('handles lines that do not match annotate format', async () => {
			// Non-matching leading line has no SEP — the parser should attach it
			// as a continuation of the first real entry (embedded-newline case).
			mockExecCm.mockResolvedValue({
				stdout:
					`1${SEP}42${SEP}alice${SEP}2026-01-01${SEP}first line\n` +
					`some continuation\n` +
					`2${SEP}43${SEP}bob${SEP}2026-01-02${SEP}code\n`,
				stderr: '', exitCode: 0,
			});

			const blame = await backend.getBlame('/src/foo.ts');
			expect(blame).toHaveLength(2);
			expect(blame[0].changesetId).toBe(42);
			expect(blame[0].content).toBe('first line\nsome continuation');
			expect(blame[1].changesetId).toBe(43);
		});

		it('does not pass --dateformat to cm annotate', async () => {
			// cm annotate does NOT support --dateformat (only cm find does).
			// Passing it causes "Unexpected option --dateformat" errors.
			mockExecCm.mockResolvedValue({
				stdout: `1${SEP}42${SEP}alice${SEP}2026-01-01${SEP}code\n`,
				stderr: '', exitCode: 0,
			});

			await backend.getBlame('/src/foo.ts');
			const args = mockExecCm.mock.calls[mockExecCm.mock.calls.length - 1][0] as string[];
			expect(args.join(' ')).not.toContain('--dateformat');
		});
	});

	describe('label parsing', () => {
		it('parses label lines from cm find', async () => {
			mockExecCm.mockResolvedValue({
				stdout: 'v1.0#1#alice#2026-01-01#42#first release\nv1.1#2#bob#2026-02-01#50#\n',
				stderr: '', exitCode: 0,
			});

			const labels = await backend.listLabels();
			expect(labels).toHaveLength(2);
			expect(labels[0].name).toBe('v1.0');
			expect(labels[0].changesetId).toBe(42);
			expect(labels[0].comment).toBe('first release');
			expect(labels[1].comment).toBeUndefined();
		});
	});

	describe('file history parsing', () => {
		it('parses history lines', async () => {
			// Format: {changesetid}#{branch}#{owner}#{date}#{comment}
			// cm history does not support {type} — all entries default to 'changed'.
			mockExecCm.mockResolvedValue({
				stdout: '42#/main#alice#2026-01-01#initial commit\n43#/main#bob#2026-01-02#update\n',
				stderr: '', exitCode: 0,
			});

			const history = await backend.getFileHistory('/src/foo.ts');
			expect(history).toHaveLength(2);
			expect(history[0].changesetId).toBe(42);
			expect(history[0].comment).toBe('initial commit');
			expect(history[0].type).toBe('changed');
			expect(history[1].changesetId).toBe(43);
			expect(history[1].type).toBe('changed');
		});

		it('handles comments containing # characters', async () => {
			// {comment} is the last field, so '#' in comments is safe.
			mockExecCm.mockResolvedValue({
				stdout: '42#/main#alice#2026-01-01#fix issue #123 and #456\n',
				stderr: '', exitCode: 0,
			});

			const history = await backend.getFileHistory('/src/foo.ts');
			expect(history[0].comment).toBe('fix issue #123 and #456');
		});

		it('does not pass --dateformat to cm history', async () => {
			// cm history does NOT support --dateformat (only cm find does).
			// Passing it causes "Unexpected option --dateformat" errors.
			mockExecCm.mockResolvedValue({
				stdout: '42#/main#alice#2026-01-01#initial\n',
				stderr: '', exitCode: 0,
			});

			await backend.getFileHistory('/src/foo.ts');
			const args = mockExecCm.mock.calls[mockExecCm.mock.calls.length - 1][0] as string[];
			expect(args.join(' ')).not.toContain('--dateformat');
		});
	});

	describe('merge', () => {
		it('checkMergeAllowed detects conflicts', async () => {
			mockExecCm.mockResolvedValue({
				stdout: 'Conflict in /src/foo.ts\nConflict in /src/bar.ts\n',
				stderr: '', exitCode: 1,
			});

			const report = await backend.checkMergeAllowed('/main/feature', '/main');
			expect(report.canMerge).toBe(false);
			expect(report.conflicts).toHaveLength(2);
		});

		it('executeMerge extracts changeset ID from output', async () => {
			mockExecCm.mockResolvedValue({
				stdout: 'Merge complete. Created changeset 99',
				stderr: '', exitCode: 0,
			});

			const result = await backend.executeMerge('/main/feature', '/main', 'merge');
			expect(result.changesetId).toBe(99);
			expect(result.conflicts).toHaveLength(0);
		});

		it('executeMerge returns conflicts on failure', async () => {
			mockExecCm.mockResolvedValue({
				stdout: '', stderr: 'CONFLICT in /src/foo.ts', exitCode: 1,
			});

			const result = await backend.executeMerge('/main/feature', '/main');
			expect(result.conflicts).toHaveLength(1);
			expect(result.changesetId).toBe(0);
		});
	});
});
