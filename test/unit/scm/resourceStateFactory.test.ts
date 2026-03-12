import { describe, it, expect } from 'vitest';
import { Uri } from '../../mocks/vscode';
import { createResourceState } from '../../../src/scm/resourceStateFactory';
import type { NormalizedChange } from '../../../src/core/types';
import { COMMANDS } from '../../../src/constants';

describe('createResourceState', () => {
	const root = Uri.file('/workspace');

	it('creates resource state with correct URI', () => {
		const change: NormalizedChange = {
			path: 'src/foo.ts',
			changeType: 'changed',
			dataType: 'File',
		};
		const state = createResourceState(change, root as any);
		expect(state.resourceUri.path).toContain('src/foo.ts');
	});

	it('has open-change command for non-deleted files', () => {
		const change: NormalizedChange = {
			path: 'src/foo.ts',
			changeType: 'changed',
			dataType: 'File',
		};
		const state = createResourceState(change, root as any);
		expect(state.command?.command).toBe(COMMANDS.openChange);
	});

	it('has no command for deleted files', () => {
		const change: NormalizedChange = {
			path: 'src/foo.ts',
			changeType: 'deleted',
			dataType: 'File',
		};
		const state = createResourceState(change, root as any);
		expect(state.command).toBeUndefined();
	});

	it('has no command for locallyDeleted files', () => {
		const change: NormalizedChange = {
			path: 'src/foo.ts',
			changeType: 'locallyDeleted',
			dataType: 'File',
		};
		const state = createResourceState(change, root as any);
		expect(state.command).toBeUndefined();
	});

	it('sets contextValue to changeType', () => {
		const change: NormalizedChange = {
			path: 'src/foo.ts',
			changeType: 'added',
			dataType: 'File',
		};
		const state = createResourceState(change, root as any);
		expect(state.contextValue).toBe('added');
	});

	it('passes NormalizedChange as second command argument', () => {
		const change: NormalizedChange = {
			path: 'src/foo.ts',
			changeType: 'changed',
			dataType: 'File',
		};
		const state = createResourceState(change, root as any);
		expect(state.command?.arguments).toHaveLength(2);
		expect(state.command?.arguments?.[1]).toBe(change);
	});

	it('includes decorations', () => {
		const change: NormalizedChange = {
			path: 'src/foo.ts',
			changeType: 'changed',
			dataType: 'File',
		};
		const state = createResourceState(change, root as any);
		expect(state.decorations).toBeDefined();
		expect(state.decorations?.tooltip).toBeTruthy();
	});
});
