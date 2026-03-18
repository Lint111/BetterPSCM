import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryStagingStore } from '../../../src/core/stagingStore';

describe('InMemoryStagingStore', () => {
	let store: InMemoryStagingStore;

	beforeEach(() => {
		store = new InMemoryStagingStore();
	});

	it('starts empty', () => {
		expect(store.getAll().size).toBe(0);
	});

	it('adds and checks paths', () => {
		store.add(['a.cs', 'b.cs']);
		expect(store.has('a.cs')).toBe(true);
		expect(store.has('c.cs')).toBe(false);
		expect(store.getAll().size).toBe(2);
	});

	it('removes paths', () => {
		store.add(['a.cs', 'b.cs']);
		store.remove(['a.cs']);
		expect(store.has('a.cs')).toBe(false);
		expect(store.has('b.cs')).toBe(true);
	});

	it('clears all paths', () => {
		store.add(['a.cs', 'b.cs']);
		store.clear();
		expect(store.getAll().size).toBe(0);
	});

	it('ignores duplicate adds', () => {
		store.add(['a.cs', 'a.cs']);
		expect(store.getAll().size).toBe(1);
	});

	it('ignores removing non-existent paths', () => {
		store.add(['a.cs']);
		store.remove(['nope.cs']);
		expect(store.getAll().size).toBe(1);
	});
});
