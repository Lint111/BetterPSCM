import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Uri } from '../../mocks/vscode';

vi.mock('../../../src/util/uri', () => ({
	buildPlasticUri: vi.fn((ws: string, rev: string, path: string) =>
		Uri.from({ scheme: 'plastic', authority: ws, path: `/${path}`, query: rev }),
	),
	parsePlasticUri: vi.fn(),
}));

vi.mock('../../../src/core/workspace', () => ({
	fetchFileContent: vi.fn(),
}));

vi.mock('../../../src/util/logger', () => ({
	logError: vi.fn(),
}));

vi.mock('../../../src/constants', () => ({
	PLASTIC_URI_SCHEME: 'plastic',
}));

import { PlasticQuickDiffProvider } from '../../../src/scm/quickDiffProvider';
import type { NormalizedChange } from '../../../src/core/types';

describe('PlasticQuickDiffProvider', () => {
	let provider: PlasticQuickDiffProvider;

	beforeEach(() => {
		vi.clearAllMocks();
		provider = new PlasticQuickDiffProvider('ws-guid-123');
	});

	it('returns undefined when no changes are set', () => {
		const uri = Uri.file('/workspace/src/foo.ts');
		expect(provider.provideOriginalResource(uri as any)).toBeUndefined();
	});

	it('returns undefined for added files', () => {
		provider.updateChanges([
			{ path: 'src/foo.ts', changeType: 'added', dataType: 'File' },
		], '/workspace');

		const uri = Uri.file('/workspace/src/foo.ts');
		expect(provider.provideOriginalResource(uri as any)).toBeUndefined();
	});

	it('returns undefined for private files', () => {
		provider.updateChanges([
			{ path: 'src/foo.ts', changeType: 'private', dataType: 'File' },
		], '/workspace');

		const uri = Uri.file('/workspace/src/foo.ts');
		expect(provider.provideOriginalResource(uri as any)).toBeUndefined();
	});

	it('returns plastic: URI for changed files with revisionGuid', () => {
		provider.updateChanges([
			{ path: 'src/foo.ts', changeType: 'changed', dataType: 'File', revisionGuid: 'rev-abc' },
		], '/workspace');

		const uri = Uri.file('/workspace/src/foo.ts');
		const result = provider.provideOriginalResource(uri as any);
		expect(result).toBeDefined();
		expect(result!.scheme).toBe('plastic');
	});

	it('returns plastic: URI for changed files without revisionGuid (CLI fallback)', () => {
		provider.updateChanges([
			{ path: 'src/foo.ts', changeType: 'changed', dataType: 'File' },
		], '/workspace');

		const uri = Uri.file('/workspace/src/foo.ts');
		const result = provider.provideOriginalResource(uri as any);
		expect(result).toBeDefined();
		expect(result!.scheme).toBe('plastic');
	});

	it('returns plastic: URI for checkedOut files', () => {
		provider.updateChanges([
			{ path: 'src/foo.ts', changeType: 'checkedOut', dataType: 'File' },
		], '/workspace');

		const uri = Uri.file('/workspace/src/foo.ts');
		const result = provider.provideOriginalResource(uri as any);
		expect(result).toBeDefined();
	});

	it('clears change map on empty update', () => {
		provider.updateChanges([
			{ path: 'src/foo.ts', changeType: 'changed', dataType: 'File' },
		], '/workspace');
		provider.updateChanges([], '/workspace');

		const uri = Uri.file('/workspace/src/foo.ts');
		expect(provider.provideOriginalResource(uri as any)).toBeUndefined();
	});
});
