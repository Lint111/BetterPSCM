/**
 * Generic caching utilities for immutable and time-sensitive data.
 *
 * - LruCache: bounded cache with LRU eviction, ideal for immutable data
 *   (changeset diffs, file content at revision).
 * - TtlCache: time-to-live cache for data that goes stale
 *   (branch lists, current branch, changeset lists).
 */

/**
 * Bounded LRU cache — oldest entry is evicted when capacity is reached.
 * Use for data that never changes (changeset diffs, file content at revision).
 */
export class LruCache<K, V> {
	private readonly map = new Map<K, V>();

	constructor(private readonly maxSize: number) {}

	get(key: K): V | undefined {
		const value = this.map.get(key);
		if (value === undefined) return undefined;
		// Move to end (most recently used)
		this.map.delete(key);
		this.map.set(key, value);
		return value;
	}

	set(key: K, value: V): void {
		if (this.map.has(key)) {
			this.map.delete(key);
		} else if (this.map.size >= this.maxSize) {
			// Evict oldest (first entry)
			const oldest = this.map.keys().next().value;
			if (oldest !== undefined) this.map.delete(oldest);
		}
		this.map.set(key, value);
	}

	has(key: K): boolean {
		return this.map.has(key);
	}

	delete(key: K): boolean {
		return this.map.delete(key);
	}

	clear(): void {
		this.map.clear();
	}

	get size(): number {
		return this.map.size;
	}
}

/**
 * TTL cache — entries expire after a configurable duration.
 * Use for data that changes occasionally (branches, current branch, changeset lists).
 */
export class TtlCache<K, V> {
	private readonly map = new Map<K, { value: V; expiresAt: number }>();

	constructor(private readonly ttlMs: number) {}

	get(key: K): V | undefined {
		const entry = this.map.get(key);
		if (!entry) return undefined;
		if (Date.now() > entry.expiresAt) {
			this.map.delete(key);
			return undefined;
		}
		return entry.value;
	}

	set(key: K, value: V): void {
		this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
		if (this.map.size > 50) this.prune();
	}

	/** Remove all expired entries. */
	prune(): void {
		const now = Date.now();
		for (const [k, v] of this.map) {
			if (now > v.expiresAt) this.map.delete(k);
		}
	}

	/**
	 * Check if a non-expired entry exists for the key.
	 * Unlike get(), this correctly handles stored `undefined` values.
	 */
	has(key: K): boolean {
		const entry = this.map.get(key);
		if (!entry) return false;
		if (Date.now() > entry.expiresAt) {
			this.map.delete(key);
			return false;
		}
		return true;
	}

	delete(key: K): boolean {
		return this.map.delete(key);
	}

	clear(): void {
		this.map.clear();
	}

	get size(): number {
		return this.map.size;
	}
}
