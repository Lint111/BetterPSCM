import { describe, it, expect } from 'vitest';
import {
	COMMITTABLE_CHANGE_TYPES,
	BULK_OPERATION_THRESHOLD,
	UNITY_CRITICAL_EXTENSIONS,
	isCommittableChange,
	expandMetaCompanions,
} from '../../../src/core/safety';

describe('safety constants', () => {
	it('COMMITTABLE_CHANGE_TYPES includes real changes', () => {
		expect(COMMITTABLE_CHANGE_TYPES.has('added')).toBe(true);
		expect(COMMITTABLE_CHANGE_TYPES.has('changed')).toBe(true);
		expect(COMMITTABLE_CHANGE_TYPES.has('deleted')).toBe(true);
		expect(COMMITTABLE_CHANGE_TYPES.has('moved')).toBe(true);
	});

	it('COMMITTABLE_CHANGE_TYPES excludes non-changes', () => {
		expect(COMMITTABLE_CHANGE_TYPES.has('checkedOut')).toBe(false);
		expect(COMMITTABLE_CHANGE_TYPES.has('private')).toBe(false);
		expect(COMMITTABLE_CHANGE_TYPES.has('ignored')).toBe(false);
	});

	it('BULK_OPERATION_THRESHOLD is 20', () => {
		expect(BULK_OPERATION_THRESHOLD).toBe(20);
	});

	it('UNITY_CRITICAL_EXTENSIONS includes .meta', () => {
		expect(UNITY_CRITICAL_EXTENSIONS).toContain('.meta');
		expect(UNITY_CRITICAL_EXTENSIONS).toContain('.unity');
		expect(UNITY_CRITICAL_EXTENSIONS).toContain('.asmdef');
	});
});

describe('isCommittableChange', () => {
	it('returns true for added', () => {
		expect(isCommittableChange('added')).toBe(true);
	});

	it('returns false for checkedOut', () => {
		expect(isCommittableChange('checkedOut')).toBe(false);
	});

	it('returns false for undefined', () => {
		expect(isCommittableChange(undefined)).toBe(false);
	});
});

describe('expandMetaCompanions', () => {
	it('adds .meta companion for non-meta file', () => {
		const candidates = new Set(['foo.cs', 'foo.cs.meta', 'bar.cs']);
		const result = expandMetaCompanions(['foo.cs'], candidates);
		expect(result).toContain('foo.cs');
		expect(result).toContain('foo.cs.meta');
		expect(result).not.toContain('bar.cs');
	});

	it('adds base file for .meta file', () => {
		const candidates = new Set(['foo.cs', 'foo.cs.meta']);
		const result = expandMetaCompanions(['foo.cs.meta'], candidates);
		expect(result).toContain('foo.cs.meta');
		expect(result).toContain('foo.cs');
	});

	it('does not add companion if not in candidates', () => {
		const candidates = new Set(['foo.cs']);
		const result = expandMetaCompanions(['foo.cs'], candidates);
		expect(result).toEqual(['foo.cs']);
	});

	it('deduplicates', () => {
		const candidates = new Set(['foo.cs', 'foo.cs.meta']);
		const result = expandMetaCompanions(['foo.cs', 'foo.cs.meta'], candidates);
		expect(result.length).toBe(2);
	});
});
