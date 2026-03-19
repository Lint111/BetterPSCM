import { describe, it, expect } from 'vitest';
import { Uri } from '../../mocks/vscode';
import { buildPlasticUri, parsePlasticUri } from '../../../src/util/uri';

describe('buildPlasticUri', () => {
	it('builds a plastic: URI with revSpec in query', () => {
		const uri = buildPlasticUri('ws-guid', 'rev-guid', 'src/foo.ts');
		expect(uri.scheme).toBe('bpscm');
		expect(uri.authority).toBe('ws-guid');
		expect(uri.path).toBe('/src/foo.ts');
		expect(uri.query).toBe('rev-guid');
	});
});

describe('parsePlasticUri', () => {
	it('round-trips with buildPlasticUri', () => {
		const uri = buildPlasticUri('ws-guid', 'rev-guid', 'src/foo.ts');
		const parsed = parsePlasticUri(uri);
		expect(parsed).toEqual({
			workspaceGuid: 'ws-guid',
			revisionGuid: 'rev-guid',
			filePath: 'src/foo.ts',
		});
	});

	it('returns undefined for non-plastic scheme', () => {
		const uri = Uri.file('/some/path');
		expect(parsePlasticUri(uri as any)).toBeUndefined();
	});

	it('returns undefined when revSpec is missing', () => {
		const uri = Uri.from({ scheme: 'bpscm', authority: 'ws', path: '/file.ts' });
		expect(parsePlasticUri(uri as any)).toBeUndefined();
	});

	it('handles nested file paths', () => {
		const uri = buildPlasticUri('ws', 'rev', 'src/deep/path/file.ts');
		const parsed = parsePlasticUri(uri);
		expect(parsed?.filePath).toBe('src/deep/path/file.ts');
	});

	it('handles serverpath revSpec with slashes', () => {
		const uri = buildPlasticUri('ws', 'serverpath:/Assets/Scripts/foo.cs', 'Assets/Scripts/foo.cs');
		const parsed = parsePlasticUri(uri);
		expect(parsed?.revisionGuid).toBe('serverpath:/Assets/Scripts/foo.cs');
		expect(parsed?.filePath).toBe('Assets/Scripts/foo.cs');
	});
});
