import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execCm, getCmWorkspaceRoot } from '../../../src/core/cmCli';

vi.mock('../../../src/core/cmCli', () => ({
	execCm: vi.fn(),
	getCmWorkspaceRoot: vi.fn(() => undefined),
}));

import { CliBackend } from '../../../src/core/backendCli';

const mockExecCm = vi.mocked(execCm);
const mockGetCmWorkspaceRoot = vi.mocked(getCmWorkspaceRoot);

describe('CliBackend', () => {
	let backend: CliBackend;

	beforeEach(() => {
		vi.clearAllMocks();
		backend = new CliBackend();
	});

	it('has name "cm CLI"', () => {
		expect(backend.name).toBe('cm CLI');
	});

	describe('getStatus', () => {
		it('parses machine-readable status output', async () => {
			mockExecCm.mockResolvedValue({
				stdout: [
					'STATUS cs:42 rep:DAPrototype org@cloud',
					'CH /src/foo.ts False NO_MERGE',
					'AD /src/bar.ts False NO_MERGE',
					'PR /src/baz.ts False NO_MERGE',
				].join('\n'),
				stderr: '',
				exitCode: 0,
			});

			const result = await backend.getStatus(true);
			expect(result.changes).toHaveLength(3);
			expect(result.changes[0]).toEqual({
				path: '/src/foo.ts',
				changeType: 'changed',
				dataType: 'File',
			});
			expect(result.changes[1].changeType).toBe('added');
			expect(result.changes[2].changeType).toBe('private');
		});

		it('filters private files when showPrivate=false', async () => {
			mockExecCm.mockResolvedValue({
				stdout: 'CH /src/foo.ts False NO_MERGE\nPR /src/baz.ts False NO_MERGE\n',
				stderr: '',
				exitCode: 0,
			});

			const result = await backend.getStatus(false);
			expect(result.changes).toHaveLength(1);
			expect(result.changes[0].changeType).toBe('changed');
		});

		it('returns empty changes for empty workspace', async () => {
			mockExecCm.mockResolvedValue({
				stdout: 'STATUS cs:42 rep:DAPrototype org@cloud\n',
				stderr: '',
				exitCode: 0,
			});

			const result = await backend.getStatus(true);
			expect(result.changes).toHaveLength(0);
		});

		it('parses directory changes', async () => {
			mockExecCm.mockResolvedValue({
				stdout: 'AD /src/newdir True NO_MERGE\n',
				stderr: '',
				exitCode: 0,
			});

			const result = await backend.getStatus(true);
			expect(result.changes[0].dataType).toBe('Directory');
		});

		it('strips workspace root from absolute paths', async () => {
			mockGetCmWorkspaceRoot.mockReturnValue('C:\\GitHub\\Divine Ambition\\DAPrototype');
			mockExecCm.mockResolvedValue({
				stdout: [
					'CH C:\\GitHub\\Divine Ambition\\DAPrototype\\Assets\\Scripts\\Foo.cs False NO_MERGE',
					'AD C:\\GitHub\\Divine Ambition\\DAPrototype\\Assets\\Prefabs\\Bar.prefab False NO_MERGE',
					'PR C:\\GitHub\\Divine Ambition\\DAPrototype\\Assets\\_Recovery False NO_MERGE',
				].join('\n'),
				stderr: '',
				exitCode: 0,
			});

			const result = await backend.getStatus(true);
			expect(result.changes).toHaveLength(3);
			expect(result.changes[0].path).toBe('Assets/Scripts/Foo.cs');
			expect(result.changes[1].path).toBe('Assets/Prefabs/Bar.prefab');
			expect(result.changes[2].path).toBe('Assets/_Recovery');
		});

		it('throws on non-zero exit code', async () => {
			mockExecCm.mockResolvedValue({
				stdout: '',
				stderr: 'Error: workspace not found',
				exitCode: 1,
			});

			await expect(backend.getStatus(true)).rejects.toThrow('cm status failed');
		});

		it('maps all known change type codes', async () => {
			const codes = ['CH', 'AD', 'CO', 'DE', 'LD', 'MV', 'RP', 'CP', 'IG', 'HD'];
			const expected = ['changed', 'added', 'checkedOut', 'deleted', 'locallyDeleted', 'moved', 'replaced', 'copied', 'ignored', 'changed'];

			for (let i = 0; i < codes.length; i++) {
				mockExecCm.mockResolvedValue({
					stdout: `${codes[i]} /file.ts False NO_MERGE\n`,
					stderr: '',
					exitCode: 0,
				});
				const result = await backend.getStatus(true);
				expect(result.changes[0].changeType).toBe(expected[i]);
			}
		});

		it('handles compound type codes (e.g. "AD LD" for added then locally deleted)', async () => {
			mockGetCmWorkspaceRoot.mockReturnValue('C:\\GitHub\\Divine Ambition\\DAPrototype');
			mockExecCm.mockResolvedValue({
				stdout: [
					'AD LD C:\\GitHub\\Divine Ambition\\DAPrototype\\Assets\\Scripts\\Foo.meta False NO_MERGES',
					'CH C:\\GitHub\\Divine Ambition\\DAPrototype\\Assets\\Scripts\\Bar.cs False NO_MERGES',
				].join('\n'),
				stderr: '',
				exitCode: 0,
			});

			const result = await backend.getStatus(true);
			expect(result.changes).toHaveLength(2);
			// Compound "AD LD" should resolve to the second (more specific) type
			expect(result.changes[0].changeType).toBe('locallyDeleted');
			expect(result.changes[0].path).toBe('Assets/Scripts/Foo.meta');
			// Regular single type still works
			expect(result.changes[1].changeType).toBe('changed');
			expect(result.changes[1].path).toBe('Assets/Scripts/Bar.cs');
		});

		it('handles compound type codes with spaces in path', async () => {
			mockGetCmWorkspaceRoot.mockReturnValue('C:\\GitHub\\Divine Ambition\\DAPrototype');
			mockExecCm.mockResolvedValue({
				stdout: 'AD LD C:\\GitHub\\Divine Ambition\\DAPrototype\\Assets\\Default Chain\\File 1.meta False NO_MERGES\n',
				stderr: '',
				exitCode: 0,
			});

			const result = await backend.getStatus(true);
			expect(result.changes).toHaveLength(1);
			expect(result.changes[0].changeType).toBe('locallyDeleted');
			expect(result.changes[0].path).toBe('Assets/Default Chain/File 1.meta');
		});
	});

	describe('getCurrentBranch', () => {
		it('parses branch from wi output', async () => {
			mockExecCm.mockResolvedValue({
				stdout: 'BR /main/Tech/Feature rep:DAPrototype@org@cloud\n',
				stderr: '',
				exitCode: 0,
			});

			const branch = await backend.getCurrentBranch();
			expect(branch).toBe('/main/Tech/Feature');
		});

		it('returns undefined when no branch match', async () => {
			mockExecCm.mockResolvedValue({
				stdout: 'UNEXPECTED OUTPUT',
				stderr: '',
				exitCode: 0,
			});

			const branch = await backend.getCurrentBranch();
			expect(branch).toBeUndefined();
		});

		it('throws on non-zero exit code', async () => {
			mockExecCm.mockResolvedValue({
				stdout: '',
				stderr: 'workspace error',
				exitCode: 1,
			});

			await expect(backend.getCurrentBranch()).rejects.toThrow('cm wi failed');
		});
	});

	describe('checkin', () => {
		it('parses changeset ID from output', async () => {
			mockExecCm.mockResolvedValue({
				stdout: 'cs:123 on br:/main/Feature',
				stderr: '',
				exitCode: 0,
			});

			const result = await backend.checkin(['/src/foo.ts'], 'fix bug');
			expect(result.changesetId).toBe(123);
			expect(result.branchName).toContain('main');
		});

		it('throws on non-zero exit code', async () => {
			mockExecCm.mockResolvedValue({
				stdout: '',
				stderr: 'nothing to checkin',
				exitCode: 1,
			});

			await expect(backend.checkin(['/foo'], 'msg')).rejects.toThrow('cm checkin failed');
		});

		it('throws when changeset ID not parseable', async () => {
			mockExecCm.mockResolvedValue({
				stdout: 'some unexpected output',
				stderr: '',
				exitCode: 0,
			});

			await expect(backend.checkin(['/foo'], 'msg')).rejects.toThrow('could not parse changeset ID');
		});

		it('passes comment and paths to execCm', async () => {
			mockExecCm.mockResolvedValue({
				stdout: 'cs:1',
				stderr: '',
				exitCode: 0,
			});

			await backend.checkin(['/a.ts', '/b.ts'], 'my comment');
			expect(mockExecCm).toHaveBeenCalledWith([
				'checkin', '-c=my comment', '--machinereadable', '/a.ts', '/b.ts',
			]);
		});
	});

	describe('getFileContent', () => {
		it('returns Uint8Array on success', async () => {
			mockExecCm.mockResolvedValue({
				stdout: 'file content here',
				stderr: '',
				exitCode: 0,
			});

			const result = await backend.getFileContent('revid:42');
			expect(result).toBeInstanceOf(Buffer);
			expect(result?.toString()).toBe('file content here');
		});

		it('returns undefined on non-zero exit (file not found)', async () => {
			mockExecCm.mockResolvedValue({
				stdout: '',
				stderr: 'object not found',
				exitCode: 1,
			});

			const result = await backend.getFileContent('revid:999');
			expect(result).toBeUndefined();
		});
	});

	describe('listBranches', () => {
		it('parses branch lines from cm find branch', async () => {
			mockExecCm.mockResolvedValue({
				stdout: [
					'/main#1#alice#2026-01-01#initial',
					'/main/feature#2#bob#2026-01-02#wip',
				].join('\n'),
				stderr: '',
				exitCode: 0,
			});

			const branches = await backend.listBranches();
			expect(branches).toHaveLength(2);
			expect(branches[0]).toEqual({
				id: 1, name: '/main', owner: 'alice', date: '2026-01-01',
				comment: 'initial', isMain: true,
			});
			expect(branches[1].name).toBe('/main/feature');
			expect(branches[1].isMain).toBe(false);
			expect(branches[1].comment).toBe('wip');
		});

		it('returns empty array for empty output', async () => {
			mockExecCm.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
			const branches = await backend.listBranches();
			expect(branches).toHaveLength(0);
		});

		it('throws on non-zero exit code', async () => {
			mockExecCm.mockResolvedValue({ stdout: '', stderr: 'error', exitCode: 1 });
			await expect(backend.listBranches()).rejects.toThrow('cm find branch failed');
		});

		it('skips malformed lines', async () => {
			mockExecCm.mockResolvedValue({
				stdout: '/main#1#alice#2026-01-01#initial\nbadline\n',
				stderr: '',
				exitCode: 0,
			});
			const branches = await backend.listBranches();
			expect(branches).toHaveLength(1);
		});
	});

	describe('createBranch', () => {
		it('calls cm branch create with name', async () => {
			mockExecCm.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

			const result = await backend.createBranch('feature-x');
			expect(result.name).toBe('feature-x');
			expect(result.isMain).toBe(false);
			expect(mockExecCm).toHaveBeenCalledWith(['branch', 'create', 'feature-x']);
		});

		it('passes comment flag when provided', async () => {
			mockExecCm.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

			await backend.createBranch('feature-y', 'my comment');
			expect(mockExecCm).toHaveBeenCalledWith(['branch', 'create', 'feature-y', '-c=my comment']);
		});

		it('throws on non-zero exit code', async () => {
			mockExecCm.mockResolvedValue({ stdout: '', stderr: 'error', exitCode: 1 });
			await expect(backend.createBranch('bad')).rejects.toThrow('cm branch create failed');
		});
	});

	describe('deleteBranch', () => {
		it('calls cm branch delete with ID as string', async () => {
			mockExecCm.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

			await backend.deleteBranch(42);
			expect(mockExecCm).toHaveBeenCalledWith(['branch', 'delete', '42']);
		});

		it('throws on non-zero exit code', async () => {
			mockExecCm.mockResolvedValue({ stdout: '', stderr: 'error', exitCode: 1 });
			await expect(backend.deleteBranch(99)).rejects.toThrow('cm branch delete failed');
		});
	});

	describe('switchBranch', () => {
		it('calls cm switch with br: prefix', async () => {
			mockExecCm.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

			await backend.switchBranch('/main/feature');
			expect(mockExecCm).toHaveBeenCalledWith(['switch', 'br:/main/feature']);
		});

		it('throws on non-zero exit code', async () => {
			mockExecCm.mockResolvedValue({ stdout: '', stderr: 'error', exitCode: 1 });
			await expect(backend.switchBranch('/bad')).rejects.toThrow('cm switch failed');
		});
	});
});
