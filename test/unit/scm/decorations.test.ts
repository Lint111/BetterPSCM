import { describe, it, expect } from 'vitest';
import { getChangeDecoration, getChangeLetter } from '../../../src/scm/decorations';

describe('getChangeDecoration', () => {
	it('returns strikeThrough for deleted', () => {
		const dec = getChangeDecoration('deleted');
		expect(dec.strikeThrough).toBe(true);
	});

	it('returns strikeThrough for locallyDeleted', () => {
		const dec = getChangeDecoration('locallyDeleted');
		expect(dec.strikeThrough).toBe(true);
	});

	it('does not strikeThrough for added', () => {
		const dec = getChangeDecoration('added');
		expect(dec.strikeThrough).toBe(false);
	});

	it('has tooltip for each change type', () => {
		const types = ['added', 'changed', 'deleted', 'checkedOut', 'moved', 'private'] as const;
		for (const t of types) {
			const dec = getChangeDecoration(t);
			expect(dec.tooltip).toBeTruthy();
		}
	});

	it('has iconPath for each change type', () => {
		const dec = getChangeDecoration('changed');
		expect(dec.iconPath).toBeDefined();
	});
});

describe('getChangeLetter', () => {
	it('returns A for added', () => {
		expect(getChangeLetter('added')).toBe('A');
	});

	it('returns M for changed', () => {
		expect(getChangeLetter('changed')).toBe('M');
	});

	it('returns D for deleted', () => {
		expect(getChangeLetter('deleted')).toBe('D');
	});

	it('returns CO for checkedOut', () => {
		expect(getChangeLetter('checkedOut')).toBe('CO');
	});

	it('returns MV for moved', () => {
		expect(getChangeLetter('moved')).toBe('MV');
	});

	it('returns ? for private', () => {
		expect(getChangeLetter('private')).toBe('?');
	});

	it('returns I for ignored', () => {
		expect(getChangeLetter('ignored')).toBe('I');
	});
});
