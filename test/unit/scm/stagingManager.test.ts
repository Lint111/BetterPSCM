import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockMemento } from '../../mocks/vscode';
import { StagingManager } from '../../../src/scm/stagingManager';
import type { NormalizedChange } from '../../../src/core/types';

function makeChange(path: string): NormalizedChange {
	return { path, changeType: 'changed', dataType: 'File' };
}

describe('StagingManager', () => {
	let memento: ReturnType<typeof createMockMemento>;
	let manager: StagingManager;

	beforeEach(() => {
		memento = createMockMemento();
		manager = new StagingManager(memento);
	});

	it('starts with no staged paths', () => {
		expect(manager.getStagedPaths()).toEqual([]);
	});

	it('restores staged paths from memento', () => {
		const mem = createMockMemento({ 'plasticScm.stagedPaths': ['/a', '/b'] });
		const m = new StagingManager(mem);
		expect(m.getStagedPaths()).toEqual(['/a', '/b']);
	});

	describe('stage', () => {
		it('adds paths to staged set', () => {
			manager.stage(['/a', '/b']);
			expect(manager.isStaged('/a')).toBe(true);
			expect(manager.isStaged('/b')).toBe(true);
		});

		it('persists to memento', () => {
			manager.stage(['/a']);
			expect(memento.update).toHaveBeenCalled();
		});

		it('does not fire event for duplicate stage', () => {
			manager.stage(['/a']);
			vi.clearAllMocks();
			manager.stage(['/a']);
			expect(memento.update).not.toHaveBeenCalled();
		});
	});

	describe('unstage', () => {
		it('removes paths from staged set', () => {
			manager.stage(['/a', '/b']);
			manager.unstage(['/a']);
			expect(manager.isStaged('/a')).toBe(false);
			expect(manager.isStaged('/b')).toBe(true);
		});

		it('no-ops for unstaged paths', () => {
			vi.clearAllMocks();
			manager.unstage(['/nonexistent']);
			expect(memento.update).not.toHaveBeenCalled();
		});
	});

	describe('stageAll', () => {
		it('stages all change paths', () => {
			manager.stageAll([makeChange('/a'), makeChange('/b')]);
			expect(manager.getStagedPaths()).toEqual(['/a', '/b']);
		});
	});

	describe('unstageAll', () => {
		it('clears all staged paths', () => {
			manager.stage(['/a', '/b']);
			manager.unstageAll();
			expect(manager.getStagedPaths()).toEqual([]);
		});

		it('no-ops when already empty', () => {
			vi.clearAllMocks();
			manager.unstageAll();
			expect(memento.update).not.toHaveBeenCalled();
		});
	});

	describe('splitChanges', () => {
		it('partitions changes by staged status', () => {
			manager.stage(['/a']);
			const changes = [makeChange('/a'), makeChange('/b'), makeChange('/c')];
			const { staged, unstaged } = manager.splitChanges(changes);

			expect(staged.map(c => c.path)).toEqual(['/a']);
			expect(unstaged.map(c => c.path)).toEqual(['/b', '/c']);
		});
	});

	describe('pruneStale', () => {
		it('removes staged paths not in current changes', () => {
			manager.stage(['/a', '/b', '/c']);
			manager.pruneStale([makeChange('/b')]);

			expect(manager.isStaged('/a')).toBe(false);
			expect(manager.isStaged('/b')).toBe(true);
			expect(manager.isStaged('/c')).toBe(false);
		});

		it('no-ops when nothing to prune', () => {
			manager.stage(['/a']);
			vi.clearAllMocks();
			manager.pruneStale([makeChange('/a')]);
			expect(memento.update).not.toHaveBeenCalled();
		});
	});

	describe('onDidChange', () => {
		it('fires when staging changes', () => {
			const listener = vi.fn();
			manager.onDidChange(listener);
			manager.stage(['/a']);
			expect(listener).toHaveBeenCalledTimes(1);
		});

		it('fires when unstaging changes', () => {
			manager.stage(['/a']);
			const listener = vi.fn();
			manager.onDidChange(listener);
			manager.unstage(['/a']);
			expect(listener).toHaveBeenCalledTimes(1);
		});
	});

	describe('dispose', () => {
		it('does not throw', () => {
			expect(() => manager.dispose()).not.toThrow();
		});
	});
});
