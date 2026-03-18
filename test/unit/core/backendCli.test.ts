import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execCm, execCmToFile, getCmWorkspaceRoot } from '../../../src/core/cmCli';

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
		it('reads branch from .plastic/plastic.selector when available', async () => {
			const { hasPlasticWorkspace, detectWorkspace } = await import('../../../src/util/plasticDetector');
			vi.mocked(hasPlasticWorkspace).mockReturnValue(true);
			vi.mocked(detectWorkspace).mockReturnValue({
				workspaceName: 'test', workspaceGuid: 'guid',
				organizationName: 'org', repositoryName: 'repo',
				currentBranch: '/main/Tech/Feature', isCloud: true,
				serverUrl: 'https://example.com',
			});
			mockGetCmWorkspaceRoot.mockReturnValue('/project');

			const branch = await backend.getCurrentBranch();
			expect(branch).toBe('/main/Tech/Feature');
		});

		it('falls back to cm wi when .plastic not available', async () => {
			const { hasPlasticWorkspace } = await import('../../../src/util/plasticDetector');
			vi.mocked(hasPlasticWorkspace).mockReturnValue(false);

			// cm wi returns changeset ID
			mockExecCm.mockResolvedValueOnce({
				stdout: 'CS 42 cs:42@rep:Repo@org',
				stderr: '',
				exitCode: 0,
			});
			// cm find changeset returns branch
			mockExecCm.mockResolvedValueOnce({
				stdout: '/main/Feature\n',
				stderr: '',
				exitCode: 0,
			});

			const branch = await backend.getCurrentBranch();
			expect(branch).toBe('/main/Feature');
		});

		it('returns undefined when all methods fail', async () => {
			const { hasPlasticWorkspace } = await import('../../../src/util/plasticDetector');
			vi.mocked(hasPlasticWorkspace).mockReturnValue(false);

			mockExecCm.mockResolvedValue({
				stdout: 'UNEXPECTED OUTPUT',
				stderr: '',
				exitCode: 0,
			});

			const branch = await backend.getCurrentBranch();
			expect(branch).toBeUndefined();
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

	describe('updateWorkspace', () => {
		it('calls cm update and returns file count', async () => {
			mockExecCm.mockResolvedValue({
				stdout: '/src/foo.ts\n/src/bar.ts\nTotal 2 updated\n',
				stderr: '',
				exitCode: 0,
			});

			const result = await backend.updateWorkspace();
			expect(result.updatedFiles).toBe(2);
			expect(result.conflicts).toHaveLength(0);
			expect(mockExecCm).toHaveBeenCalledWith(['update', '--machinereadable']);
		});

		it('reports conflicts from output', async () => {
			mockExecCm.mockResolvedValue({
				stdout: '',
				stderr: 'CONFLICT in /src/foo.ts\nconflict in /src/bar.ts',
				exitCode: 1,
			});

			const result = await backend.updateWorkspace();
			expect(result.conflicts).toHaveLength(2);
			expect(result.updatedFiles).toBe(0);
		});

		it('throws on non-conflict error', async () => {
			mockExecCm.mockResolvedValue({
				stdout: '',
				stderr: 'workspace not found',
				exitCode: 1,
			});

			await expect(backend.updateWorkspace()).rejects.toThrow('cm update failed');
		});

		it('handles empty update (already up to date)', async () => {
			mockExecCm.mockResolvedValue({
				stdout: '',
				stderr: '',
				exitCode: 0,
			});

			const result = await backend.updateWorkspace();
			expect(result.updatedFiles).toBe(0);
			expect(result.conflicts).toHaveLength(0);
		});
	});

	describe('listChangesets', () => {
		it('parses changeset lines with parent field', async () => {
			mockExecCm.mockResolvedValue({
				stdout: '42#/main#alice#2026-01-01#fix bug#41\n43#/main#bob#2026-01-02#add feature#42\n',
				stderr: '',
				exitCode: 0,
			});

			const result = await backend.listChangesets(undefined, 50);
			expect(result).toHaveLength(2);
			expect(result[0]).toEqual({
				id: 42, branch: '/main', owner: 'alice',
				date: '2026-01-01', comment: 'fix bug', parent: 41,
			});
			expect(result[1].parent).toBe(42);
		});

		it('falls back to format without parent on error', async () => {
			// First call fails with parent field error
			mockExecCm.mockResolvedValueOnce({
				stdout: '',
				stderr: 'parent field not valid',
				exitCode: 1,
			});
			// Second call succeeds without parent
			mockExecCm.mockResolvedValueOnce({
				stdout: '42#/main#alice#2026-01-01#fix bug\n',
				stderr: '',
				exitCode: 0,
			});

			const result = await backend.listChangesets();
			expect(result).toHaveLength(1);
			expect(result[0].id).toBe(42);
			expect(result[0].parent).toBe(41); // best-guess: id - 1
		});

		it('includes branch filter when provided', async () => {
			mockExecCm.mockResolvedValue({
				stdout: '10#/main/feature#dev#2026-01-01#wip#9\n',
				stderr: '',
				exitCode: 0,
			});

			await backend.listChangesets('/main/feature', 10);
			const args = mockExecCm.mock.calls[0][0];
			expect(args.join(' ')).toContain("where branch='/main/feature'");
			expect(args.join(' ')).toContain('limit 10');
		});

		it('skips malformed lines', async () => {
			mockExecCm.mockResolvedValue({
				stdout: '42#/main#alice#2026-01-01#fix#41\nbad line\n',
				stderr: '',
				exitCode: 0,
			});

			const result = await backend.listChangesets();
			expect(result).toHaveLength(1);
		});
	});

	describe('getChangesetDiff', () => {
		it('parses machinereadable diff output', async () => {
			mockExecCm.mockResolvedValue({
				stdout: 'Added /src/new.ts\nChanged /src/old.ts\nDeleted /src/gone.ts\n',
				stderr: '',
				exitCode: 0,
			});

			const result = await backend.getChangesetDiff(2, 1);
			expect(result).toHaveLength(3);
			expect(result[0]).toEqual({ path: '/src/new.ts', type: 'added' });
			expect(result[1]).toEqual({ path: '/src/old.ts', type: 'changed' });
			expect(result[2]).toEqual({ path: '/src/gone.ts', type: 'deleted' });
		});

		it('parses single-char prefix with quotes', async () => {
			mockExecCm.mockResolvedValue({
				stdout: 'A "src/new file.ts"\nC "src/changed.ts"\nD "src/deleted.ts"\n',
				stderr: '',
				exitCode: 0,
			});

			const result = await backend.getChangesetDiff(2, 1);
			expect(result).toHaveLength(3);
			expect(result[0]).toEqual({ path: 'src/new file.ts', type: 'added' });
		});

		it('parses move format with two quoted paths', async () => {
			mockExecCm.mockResolvedValue({
				stdout: 'M "old\\path\\file.ts" "new\\path\\file.ts"\n',
				stderr: '',
				exitCode: 0,
			});

			const result = await backend.getChangesetDiff(2, 1);
			expect(result).toHaveLength(1);
			expect(result[0]).toEqual({ path: 'new/path/file.ts', type: 'moved' });
		});

		it('falls back to cm find revision when cm diff fails', async () => {
			// cm diff --machinereadable fails
			mockExecCm.mockResolvedValueOnce({ stdout: '', stderr: 'error', exitCode: 1 });
			// cm diff (no flag) also fails
			mockExecCm.mockResolvedValueOnce({ stdout: '', stderr: 'error', exitCode: 1 });
			// cm find revision fallback succeeds
			mockExecCm.mockResolvedValueOnce({
				stdout: '/src/foo.ts#added\n/src/bar.ts#changed\n',
				stderr: '',
				exitCode: 0,
			});

			const result = await backend.getChangesetDiff(2, 1);
			expect(result).toHaveLength(2);
			expect(result[0]).toEqual({ path: '/src/foo.ts', type: 'added' });
		});
	});

	describe('code review methods (CLI)', () => {
		it('addReviewComment throws NotSupportedError', async () => {
			await expect(backend.addReviewComment({
				reviewId: 1, text: 'test',
			})).rejects.toThrow('not supported');
		});
	});

	describe('listCodeReviews', () => {
		it('parses cm find review output into CodeReviewInfo[]', async () => {
			mockExecCm.mockResolvedValue({
				stdout: [
					'43381#Review of changeset 531#Status Reviewed#snoff4@icloud.com#17/02/2026 14:59:28#Changeset#531#theo.muenster@outlook.com',
					'48560#Review of branch /main/Tech/unit-formations#Status Rework required#ioanaraileanu24@yahoo.com#05/03/2026 15:43:26#Branch#id:47235#theo.muenster@outlook.com',
				].join('\n'),
				stderr: '',
				exitCode: 0,
			});

			const reviews = await backend.listCodeReviews();
			expect(reviews).toHaveLength(2);

			expect(reviews[0]).toEqual({
				id: 43381,
				title: 'Review of changeset 531',
				status: 'Reviewed',
				owner: 'snoff4@icloud.com',
				created: '17/02/2026 14:59:28',
				modified: '17/02/2026 14:59:28',
				targetType: 'Changeset',
				targetSpec: '531',
				targetId: 531,
				assignee: 'theo.muenster@outlook.com',
				commentsCount: 0,
				reviewers: [],
			});

			expect(reviews[1]).toEqual({
				id: 48560,
				title: 'Review of branch /main/Tech/unit-formations',
				status: 'Rework required',
				owner: 'ioanaraileanu24@yahoo.com',
				created: '05/03/2026 15:43:26',
				modified: '05/03/2026 15:43:26',
				targetType: 'Branch',
				targetSpec: 'id:47235',
				targetId: 0,
				assignee: 'theo.muenster@outlook.com',
				commentsCount: 0,
				reviewers: [],
			});
		});

		it('applies assignedToMe filter', async () => {
			mockExecCm.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

			await backend.listCodeReviews('assignedToMe');
			const args = mockExecCm.mock.calls[0][0];
			expect(args.join(' ')).toContain("where assignee = 'me'");
		});

		it('applies createdByMe filter', async () => {
			mockExecCm.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

			await backend.listCodeReviews('createdByMe');
			const args = mockExecCm.mock.calls[0][0];
			expect(args.join(' ')).toContain("where owner = 'me'");
		});

		it('applies pending filter', async () => {
			mockExecCm.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

			await backend.listCodeReviews('pending');
			const args = mockExecCm.mock.calls[0][0];
			expect(args.join(' ')).toContain("where status = 'Under review'");
		});

		it('handles empty result', async () => {
			mockExecCm.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

			const reviews = await backend.listCodeReviews();
			expect(reviews).toEqual([]);
		});

		it('handles review with no assignee', async () => {
			mockExecCm.mockResolvedValue({
				stdout: '100#Some review#Status Under review#owner@test.com#01/01/2026 10:00:00#Changeset#42#\n',
				stderr: '',
				exitCode: 0,
			});

			const reviews = await backend.listCodeReviews();
			expect(reviews).toHaveLength(1);
			expect(reviews[0].assignee).toBeUndefined();
		});

		it('throws on cm failure', async () => {
			mockExecCm.mockResolvedValue({ stdout: '', stderr: 'error', exitCode: 1 });

			await expect(backend.listCodeReviews()).rejects.toThrow('cm find review failed');
		});
	});

	describe('createCodeReview', () => {
		it('creates review for a changeset', async () => {
			// First call: cm codereview create returns new ID
			mockExecCm.mockResolvedValueOnce({
				stdout: '99001\n',
				stderr: '',
				exitCode: 0,
			});
			// Second call: getCodeReview fetches the created review
			mockExecCm.mockResolvedValueOnce({
				stdout: '99001#My review#Status Under review#me@test.com#01/01/2026 10:00:00#Changeset#100#\n',
				stderr: '',
				exitCode: 0,
			});

			const review = await backend.createCodeReview({
				title: 'My review',
				targetType: 'Changeset',
				targetId: 100,
			});
			expect(review.id).toBe(99001);
			expect(review.title).toBe('My review');

			const createArgs = mockExecCm.mock.calls[0][0];
			expect(createArgs).toContain('cs:100');
			expect(createArgs).toContain('My review');
		});

		it('creates review for a branch with spec', async () => {
			mockExecCm.mockResolvedValueOnce({
				stdout: '99002\n',
				stderr: '',
				exitCode: 0,
			});
			mockExecCm.mockResolvedValueOnce({
				stdout: '99002#Branch review#Status Under review#me@test.com#01/01/2026 10:00:00#Branch#/main/feature#\n',
				stderr: '',
				exitCode: 0,
			});

			await backend.createCodeReview({
				title: 'Branch review',
				targetType: 'Branch',
				targetId: 0,
				targetSpec: '/main/feature',
			});

			const createArgs = mockExecCm.mock.calls[0][0];
			expect(createArgs).toContain('br:/main/feature');
		});

		it('passes --assignee when reviewers provided', async () => {
			mockExecCm.mockResolvedValueOnce({
				stdout: '99003\n',
				stderr: '',
				exitCode: 0,
			});
			mockExecCm.mockResolvedValueOnce({
				stdout: '99003#Review#Status Under review#me@test.com#01/01/2026 10:00:00#Changeset#50#bob@test.com\n',
				stderr: '',
				exitCode: 0,
			});

			await backend.createCodeReview({
				title: 'Review',
				targetType: 'Changeset',
				targetId: 50,
				reviewers: ['bob@test.com'],
			});

			const createArgs = mockExecCm.mock.calls[0][0];
			expect(createArgs).toContain('--assignee=bob@test.com');
		});

		it('throws on cm failure', async () => {
			mockExecCm.mockResolvedValue({
				stdout: '',
				stderr: 'something went wrong',
				exitCode: 1,
			});

			await expect(backend.createCodeReview({
				title: 'Bad review',
				targetType: 'Changeset',
				targetId: 1,
			})).rejects.toThrow('cm codereview create failed');
		});
	});

	describe('getCodeReview', () => {
		it('returns single review by ID', async () => {
			mockExecCm.mockResolvedValue({
				stdout: '43381#Review of changeset 531#Status Reviewed#snoff4@icloud.com#17/02/2026 14:59:28#Changeset#531#theo.muenster@outlook.com\n',
				stderr: '',
				exitCode: 0,
			});

			const review = await backend.getCodeReview(43381);
			expect(review.id).toBe(43381);
			expect(review.title).toBe('Review of changeset 531');
			const args = mockExecCm.mock.calls[0][0];
			expect(args).toContain('where id=43381');
		});

		it('throws if review not found', async () => {
			mockExecCm.mockResolvedValue({
				stdout: '',
				stderr: '',
				exitCode: 0,
			});

			await expect(backend.getCodeReview(99999)).rejects.toThrow('Code review 99999 not found');
		});
	});

	describe('lock methods (CLI)', () => {
		it('listLockRules throws NotSupportedError', async () => {
			await expect(backend.listLockRules()).rejects.toThrow('not supported');
		});

		it('createLockRule throws NotSupportedError', async () => {
			const rule = { name: 'x', rules: '*.x', targetBranch: '', excludedBranches: [], destinationBranches: [] };
			await expect(backend.createLockRule(rule)).rejects.toThrow('not supported');
		});

		it('deleteLockRules throws NotSupportedError', async () => {
			await expect(backend.deleteLockRules()).rejects.toThrow('not supported');
		});

		it('deleteLockRulesForRepo throws NotSupportedError', async () => {
			await expect(backend.deleteLockRulesForRepo()).rejects.toThrow('not supported');
		});

		it('releaseLocks throws NotSupportedError', async () => {
			await expect(backend.releaseLocks([1], 'Release')).rejects.toThrow('not supported');
		});

		it('lock NotSupportedError includes backend name', async () => {
			try {
				await backend.listLockRules();
			} catch (err: any) {
				expect(err.name).toBe('NotSupportedError');
				expect(err.message).toContain('cm CLI');
			}
		});
	});
});
