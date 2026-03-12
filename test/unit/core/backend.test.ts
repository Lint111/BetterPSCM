import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('backend singleton', () => {
	let backend: typeof import('../../../src/core/backend');

	beforeEach(async () => {
		vi.resetModules();
		backend = await import('../../../src/core/backend');
	});

	it('throws when no backend is set', () => {
		expect(() => backend.getBackend()).toThrow('No Plastic SCM backend configured');
	});

	it('hasBackend returns false initially', () => {
		expect(backend.hasBackend()).toBe(false);
	});

	it('setBackend + getBackend round-trips', () => {
		const fake = { name: 'test' } as any;
		backend.setBackend(fake);
		expect(backend.getBackend()).toBe(fake);
		expect(backend.hasBackend()).toBe(true);
	});

	it('getBackend returns the last set backend', () => {
		const first = { name: 'first' } as any;
		const second = { name: 'second' } as any;
		backend.setBackend(first);
		backend.setBackend(second);
		expect(backend.getBackend().name).toBe('second');
	});
});
