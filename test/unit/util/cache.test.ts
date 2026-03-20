import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LruCache, TtlCache } from '../../../src/util/cache';

describe('LruCache', () => {
	it('stores and retrieves values', () => {
		const cache = new LruCache<string, number>(5);
		cache.set('a', 1);
		expect(cache.get('a')).toBe(1);
	});

	it('returns undefined for missing keys', () => {
		const cache = new LruCache<string, number>(5);
		expect(cache.get('missing')).toBeUndefined();
	});

	it('evicts oldest entry when capacity exceeded', () => {
		const cache = new LruCache<string, number>(3);
		cache.set('a', 1);
		cache.set('b', 2);
		cache.set('c', 3);
		cache.set('d', 4); // evicts 'a'
		expect(cache.get('a')).toBeUndefined();
		expect(cache.get('b')).toBe(2);
		expect(cache.get('d')).toBe(4);
		expect(cache.size).toBe(3);
	});

	it('access refreshes LRU position', () => {
		const cache = new LruCache<string, number>(3);
		cache.set('a', 1);
		cache.set('b', 2);
		cache.set('c', 3);
		cache.get('a'); // refresh 'a'
		cache.set('d', 4); // should evict 'b' (oldest non-accessed)
		expect(cache.get('a')).toBe(1);
		expect(cache.get('b')).toBeUndefined();
	});

	it('overwriting a key does not increase size', () => {
		const cache = new LruCache<string, number>(3);
		cache.set('a', 1);
		cache.set('b', 2);
		cache.set('a', 10); // overwrite
		expect(cache.size).toBe(2);
		expect(cache.get('a')).toBe(10);
	});

	it('has() returns true for existing keys', () => {
		const cache = new LruCache<string, number>(5);
		cache.set('x', 42);
		expect(cache.has('x')).toBe(true);
		expect(cache.has('y')).toBe(false);
	});

	it('delete() removes entry', () => {
		const cache = new LruCache<string, number>(5);
		cache.set('a', 1);
		expect(cache.delete('a')).toBe(true);
		expect(cache.get('a')).toBeUndefined();
		expect(cache.size).toBe(0);
	});

	it('clear() empties the cache', () => {
		const cache = new LruCache<string, number>(5);
		cache.set('a', 1);
		cache.set('b', 2);
		cache.clear();
		expect(cache.size).toBe(0);
		expect(cache.get('a')).toBeUndefined();
	});

	it('works with capacity of 1', () => {
		const cache = new LruCache<string, number>(1);
		cache.set('a', 1);
		cache.set('b', 2);
		expect(cache.get('a')).toBeUndefined();
		expect(cache.get('b')).toBe(2);
		expect(cache.size).toBe(1);
	});
});

describe('TtlCache', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('stores and retrieves values within TTL', () => {
		const cache = new TtlCache<string, number>(1000);
		cache.set('a', 1);
		expect(cache.get('a')).toBe(1);
	});

	it('returns undefined for expired entries', () => {
		const cache = new TtlCache<string, number>(1000);
		cache.set('a', 1);
		vi.advanceTimersByTime(1001);
		expect(cache.get('a')).toBeUndefined();
	});

	it('has() returns false for expired entries', () => {
		const cache = new TtlCache<string, number>(500);
		cache.set('a', 1);
		expect(cache.has('a')).toBe(true);
		vi.advanceTimersByTime(501);
		expect(cache.has('a')).toBe(false);
	});

	it('has() correctly handles stored undefined values', () => {
		const cache = new TtlCache<string, undefined>(1000);
		cache.set('a', undefined);
		expect(cache.has('a')).toBe(true);
		expect(cache.get('a')).toBeUndefined(); // value IS undefined but entry exists
	});

	it('refreshes TTL on re-set', () => {
		const cache = new TtlCache<string, number>(1000);
		cache.set('a', 1);
		vi.advanceTimersByTime(800);
		cache.set('a', 2); // reset TTL
		vi.advanceTimersByTime(800); // total 1600ms from first set, 800 from second
		expect(cache.get('a')).toBe(2); // still valid
	});

	it('delete() removes entry', () => {
		const cache = new TtlCache<string, number>(1000);
		cache.set('a', 1);
		expect(cache.delete('a')).toBe(true);
		expect(cache.get('a')).toBeUndefined();
	});

	it('clear() empties the cache', () => {
		const cache = new TtlCache<string, number>(1000);
		cache.set('a', 1);
		cache.set('b', 2);
		cache.clear();
		expect(cache.size).toBe(0);
	});

	it('expired entries are cleaned up on access', () => {
		const cache = new TtlCache<string, number>(100);
		cache.set('a', 1);
		cache.set('b', 2);
		vi.advanceTimersByTime(101);
		cache.get('a'); // triggers cleanup of 'a'
		cache.has('b'); // triggers cleanup of 'b'
		// Internal map should have cleaned up on access
		expect(cache.size).toBe(0);
	});

	it('prunes expired entries when size exceeds 50', () => {
		const cache = new TtlCache<number, string>(10); // 10ms TTL
		for (let i = 0; i < 51; i++) {
			cache.set(i, `val-${i}`);
		}
		expect(cache.size).toBe(51);

		vi.advanceTimersByTime(15);
		cache.set(999, 'trigger');

		expect(cache.size).toBe(1);
		expect(cache.get(999)).toBe('trigger');
	});

	it('prune() removes only expired entries', () => {
		const cache = new TtlCache<string, number>(100);
		cache.set('a', 1);
		cache.set('b', 2);

		vi.advanceTimersByTime(50);
		cache.set('c', 3);

		vi.advanceTimersByTime(60); // a,b expired (110ms), c still valid (60ms)
		cache.prune();

		expect(cache.size).toBe(1);
		expect(cache.get('c')).toBe(3);
		expect(cache.get('a')).toBeUndefined();
	});
});
