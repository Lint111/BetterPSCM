import { describe, it, expect } from 'vitest';
import { normalizeChange, NotSupportedError } from '../../../src/core/types';
import type { StatusChange } from '../../../src/core/types';

describe('normalizeChange', () => {
	it('normalizes a valid change', () => {
		const raw: StatusChange = {
			path: '/src/foo.ts',
			changeType: 'changed',
			dataType: 'File',
		};
		const result = normalizeChange(raw);
		expect(result).toEqual({
			path: '/src/foo.ts',
			changeType: 'changed',
			dataType: 'File',
			sourcePath: undefined,
			revisionGuid: undefined,
			oldRevisionId: undefined,
		});
	});

	it('maps Dir to Directory', () => {
		const raw: StatusChange = {
			path: '/src',
			changeType: 'added',
			dataType: 'Dir',
		};
		const result = normalizeChange(raw);
		expect(result?.dataType).toBe('Directory');
	});

	it('returns undefined for missing path', () => {
		const raw = { changeType: 'changed' } as StatusChange;
		expect(normalizeChange(raw)).toBeUndefined();
	});

	it('returns undefined for missing changeType', () => {
		const raw = { path: '/foo' } as StatusChange;
		expect(normalizeChange(raw)).toBeUndefined();
	});
});

describe('NotSupportedError', () => {
	it('formats message with operation and backend', () => {
		const err = new NotSupportedError('getDiff', 'cm CLI');
		expect(err.message).toBe('"getDiff" is not supported by the cm CLI backend');
		expect(err.name).toBe('NotSupportedError');
		expect(err).toBeInstanceOf(Error);
	});
});
