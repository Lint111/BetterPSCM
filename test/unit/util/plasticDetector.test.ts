import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';

vi.mock('fs');

import { detectWorkspace, hasPlasticWorkspace, detectCachedToken } from '../../../src/util/plasticDetector';

const mockFs = vi.mocked(fs);

describe('hasPlasticWorkspace', () => {
	it('returns true when plastic.workspace exists', () => {
		mockFs.existsSync.mockReturnValue(true);
		expect(hasPlasticWorkspace('/project')).toBe(true);
	});

	it('returns false when missing', () => {
		mockFs.existsSync.mockReturnValue(false);
		expect(hasPlasticWorkspace('/project')).toBe(false);
	});
});

describe('detectWorkspace', () => {
	const origLocalAppData = process.env.LOCALAPPDATA;

	beforeEach(() => {
		vi.clearAllMocks();
		process.env.LOCALAPPDATA = 'C:\\Users\\test\\AppData\\Local';
	});

	afterAll(() => {
		process.env.LOCALAPPDATA = origLocalAppData;
	});

	it('returns undefined when .plastic folder missing', () => {
		mockFs.existsSync.mockReturnValue(false);
		expect(detectWorkspace('/project')).toBeUndefined();
	});

	it('parses workspace info from .plastic files', () => {
		mockFs.existsSync.mockImplementation((p: any) => {
			const path = String(p);
			if (path.includes('.plastic')) return true;
			if (path.includes('unityorgs.conf')) return true;
			return false;
		});

		mockFs.readFileSync.mockImplementation((p: any) => {
			const path = String(p);
			if (path.includes('plastic.workspace')) {
				return 'MyWorkspace\n0208f971-645e-41ec-b635-303facd7df1d\nType';
			}
			if (path.includes('plastic.selector')) {
				return 'repository "MyOrg/MyRepo@20067454181069@cloud"\n  path "/"\n    smartbranch "/main/Feature"\n';
			}
			if (path.includes('unityorgs.conf')) {
				return '20067454181069:my-org-slug\n';
			}
			return '';
		});

		const result = detectWorkspace('/project');
		expect(result).toBeDefined();
		expect(result!.workspaceName).toBe('MyWorkspace');
		expect(result!.workspaceGuid).toBe('0208f971-645e-41ec-b635-303facd7df1d');
		expect(result!.repositoryName).toBe('MyOrg/MyRepo');
		expect(result!.currentBranch).toBe('/main/Feature');
		expect(result!.isCloud).toBe(true);
		expect(result!.organizationName).toBe('my-org-slug');
	});

	it('uses local server URL for non-cloud workspaces', () => {
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockImplementation((p: any) => {
			const path = String(p);
			if (path.includes('plastic.workspace')) return 'WS\nguid\nType';
			if (path.includes('plastic.selector')) return 'repository "Org/Repo@localhost:8087"\n  path "/"\n    branch "/main"\n';
			return '';
		});

		const result = detectWorkspace('/project');
		expect(result).toBeDefined();
		expect(result!.isCloud).toBe(false);
		expect(result!.serverUrl).toBe('http://localhost:7178');
	});
});

describe('detectCachedToken', () => {
	const origEnv = process.env.LOCALAPPDATA;

	beforeEach(() => {
		vi.clearAllMocks();
		process.env.LOCALAPPDATA = 'C:\\Users\\test\\AppData\\Local';
	});

	afterAll(() => {
		process.env.LOCALAPPDATA = origEnv;
	});

	it('returns undefined when LOCALAPPDATA not set', () => {
		delete process.env.LOCALAPPDATA;
		expect(detectCachedToken()).toBeUndefined();
	});

	it('returns undefined when tokens.conf missing', () => {
		mockFs.existsSync.mockReturnValue(false);
		expect(detectCachedToken()).toBeUndefined();
	});

	it('parses token from tokens.conf', () => {
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockReturnValue(
			'server=20067454181069@cloud user=test@example.com token=TOKENeyJhbGciOiJSUzI1NiJ9 seiddata=test@example.com\n'
		);

		const result = detectCachedToken();
		expect(result).toBeDefined();
		expect(result!.server).toBe('20067454181069@cloud');
		expect(result!.user).toBe('test@example.com');
		expect(result!.token).toBe('eyJhbGciOiJSUzI1NiJ9');
	});

	it('filters by server spec when provided', () => {
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockReturnValue(
			'server=other@cloud user=a@b.com token=TOKENabc seiddata=a@b.com\nserver=target@cloud user=x@y.com token=TOKENxyz seiddata=x@y.com\n'
		);

		const result = detectCachedToken('target@cloud');
		expect(result!.user).toBe('x@y.com');
		expect(result!.token).toBe('xyz');
	});
});
