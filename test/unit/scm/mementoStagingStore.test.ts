import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MementoStagingStore } from '../../../src/scm/mementoStagingStore';

// Minimal mock of vscode.Memento
function mockMemento(initial: string[] = []) {
	const data: Record<string, unknown> = { 'bpscm.stagedPaths': initial };
	return {
		get: vi.fn((key: string, fallback?: unknown) => data[key] ?? fallback),
		update: vi.fn((key: string, value: unknown) => { data[key] = value; return Promise.resolve(); }),
	};
}

describe('MementoStagingStore', () => {
	it('loads initial state from memento', () => {
		const memento = mockMemento(['a.cs', 'b.cs']);
		const store = new MementoStagingStore(memento as any);
		expect(store.has('a.cs')).toBe(true);
		expect(store.getAll().size).toBe(2);
	});

	it('persists on add', () => {
		const memento = mockMemento();
		const store = new MementoStagingStore(memento as any);
		store.add(['new.cs']);
		expect(memento.update).toHaveBeenCalledWith('bpscm.stagedPaths', ['new.cs']);
	});

	it('persists on remove', () => {
		const memento = mockMemento(['a.cs', 'b.cs']);
		const store = new MementoStagingStore(memento as any);
		store.remove(['a.cs']);
		expect(memento.update).toHaveBeenCalledWith('bpscm.stagedPaths', ['b.cs']);
	});

	it('persists on clear', () => {
		const memento = mockMemento(['a.cs']);
		const store = new MementoStagingStore(memento as any);
		store.clear();
		expect(memento.update).toHaveBeenCalledWith('bpscm.stagedPaths', []);
	});

	it('fires onDidChange on add', () => {
		const memento = mockMemento();
		const store = new MementoStagingStore(memento as any);
		const listener = vi.fn();
		store.onDidChange(listener);
		store.add(['a.cs']);
		expect(listener).toHaveBeenCalled();
	});

	it('does not fire onDidChange when add is no-op', () => {
		const memento = mockMemento(['a.cs']);
		const store = new MementoStagingStore(memento as any);
		const listener = vi.fn();
		store.onDidChange(listener);
		store.add(['a.cs']); // already present
		expect(listener).not.toHaveBeenCalled();
	});
});
