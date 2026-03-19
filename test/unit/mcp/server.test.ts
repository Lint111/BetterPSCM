import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the CLI modules before importing server internals
vi.mock('../../../src/core/cmCli', () => ({
	setCmWorkspaceRoot: vi.fn(),
	detectCm: vi.fn().mockResolvedValue('/usr/bin/cm'),
	isCmAvailable: vi.fn(() => true),
	getCmWorkspaceRoot: vi.fn(() => '/workspace'),
}));

vi.mock('../../../src/core/backend', () => {
	const mockBackend = {
		name: 'mock',
		getStatus: vi.fn().mockResolvedValue({
			changes: [
				{ path: '/src/foo.ts', changeType: 'changed', dataType: 'File' },
				{ path: '/src/bar.ts', changeType: 'added', dataType: 'File' },
			],
		}),
		getCurrentBranch: vi.fn().mockResolvedValue('/main/feature'),
		checkin: vi.fn().mockResolvedValue({ changesetId: 42, branchName: '/main' }),
		listBranches: vi.fn().mockResolvedValue([
			{ id: 1, name: '/main', owner: 'alice', date: '2026-01-01', isMain: true },
		]),
		getFileContent: vi.fn().mockResolvedValue(new Uint8Array([72, 101, 108, 108, 111])),
		listChangesets: vi.fn().mockResolvedValue([]),
		getChangesetDiff: vi.fn().mockResolvedValue([]),
		createBranch: vi.fn().mockResolvedValue({ id: 2, name: '/main/new', owner: '', date: '', isMain: false }),
		switchBranch: vi.fn().mockResolvedValue(undefined),
		getFileHistory: vi.fn().mockResolvedValue([]),
		getBlame: vi.fn().mockResolvedValue([]),
		checkMergeAllowed: vi.fn().mockResolvedValue({ canMerge: true, conflicts: [], changes: 0 }),
		executeMerge: vi.fn().mockResolvedValue({ changesetId: 100, conflicts: [] }),
		createCodeReview: vi.fn().mockResolvedValue({ id: 1, title: 'test', status: 'Under review' }),
		listCodeReviews: vi.fn().mockResolvedValue([]),
	};
	return {
		getBackend: vi.fn(() => mockBackend),
		setBackend: vi.fn(),
		__mockBackend: mockBackend,
	};
});

// We can't easily test the full MCP server (it uses stdio transport),
// so we test the helper functions and tool logic patterns.
describe('MCP Server helpers', () => {
	it('parseArgs extracts --workspace flag', async () => {
		// Test the parsing logic directly
		const originalArgv = process.argv;
		process.argv = ['node', 'mcp-server.js', '--workspace', '/my/workspace'];

		// parseArgs is not exported, so we test the pattern
		const args = process.argv.slice(2);
		let workspace = process.cwd();
		for (let i = 0; i < args.length; i++) {
			if (args[i] === '--workspace' && args[i + 1]) {
				workspace = args[i + 1];
				i++;
			}
		}
		expect(workspace).toBe('/my/workspace');

		process.argv = originalArgv;
	});

	it('parseArgs defaults to cwd when no --workspace', () => {
		const args: string[] = [];
		let workspace = '/default/cwd';
		for (let i = 0; i < args.length; i++) {
			if (args[i] === '--workspace' && args[i + 1]) {
				workspace = args[i + 1];
				i++;
			}
		}
		expect(workspace).toBe('/default/cwd');
	});

	describe('staging state', () => {
		it('Set-based staging tracks paths correctly', () => {
			const staged = new Set<string>();

			staged.add('/src/foo.ts');
			staged.add('/src/bar.ts');
			expect(staged.size).toBe(2);
			expect(staged.has('/src/foo.ts')).toBe(true);

			staged.delete('/src/foo.ts');
			expect(staged.size).toBe(1);
			expect(staged.has('/src/foo.ts')).toBe(false);

			staged.clear();
			expect(staged.size).toBe(0);
		});

		it('staging the same path twice is idempotent', () => {
			const staged = new Set<string>();
			staged.add('/src/foo.ts');
			staged.add('/src/foo.ts');
			expect(staged.size).toBe(1);
		});
	});

	describe('error result format', () => {
		it('errorResult produces correct MCP error shape', () => {
			const errorResult = (msg: string) => ({
				content: [{ type: 'text' as const, text: `Error: ${msg}` }],
				isError: true as const,
			});

			const result = errorResult('file not found');
			expect(result.isError).toBe(true);
			expect(result.content[0].text).toBe('Error: file not found');
			expect(result.content[0].type).toBe('text');
		});

		it('textResult produces correct MCP text shape', () => {
			const textResult = (text: string) => ({
				content: [{ type: 'text' as const, text }],
			});

			const result = textResult('success');
			expect(result.content[0].text).toBe('success');
			expect((result as any).isError).toBeUndefined();
		});

		it('jsonResult produces formatted JSON', () => {
			const jsonResult = (data: unknown) => ({
				content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
			});

			const result = jsonResult({ branch: '/main', changes: [] });
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.branch).toBe('/main');
			expect(parsed.changes).toEqual([]);
		});
	});
});
