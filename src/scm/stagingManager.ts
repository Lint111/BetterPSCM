import * as vscode from 'vscode';
import type { NormalizedChange } from '../core/types';

const MEMENTO_KEY = 'plasticScm.stagedPaths';

/**
 * Client-side staging manager that enables selective file checkin.
 * The staging set persists to workspace state (memento) across restarts.
 */
export class StagingManager implements vscode.Disposable {
	private stagedPaths: Set<string>;
	private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
	public readonly onDidChange = this.onDidChangeEmitter.event;

	constructor(private readonly memento: vscode.Memento) {
		const stored = memento.get<string[]>(MEMENTO_KEY, []);
		this.stagedPaths = new Set(stored);
	}

	/**
	 * Stage specific file paths.
	 */
	stage(paths: string[]): void {
		let changed = false;
		for (const p of paths) {
			if (!this.stagedPaths.has(p)) {
				this.stagedPaths.add(p);
				changed = true;
			}
		}
		if (changed) this.persist();
	}

	/**
	 * Unstage specific file paths.
	 */
	unstage(paths: string[]): void {
		let changed = false;
		for (const p of paths) {
			if (this.stagedPaths.delete(p)) {
				changed = true;
			}
		}
		if (changed) this.persist();
	}

	/**
	 * Stage all currently known changes.
	 */
	stageAll(changes: NormalizedChange[]): void {
		for (const c of changes) {
			this.stagedPaths.add(c.path);
		}
		this.persist();
	}

	/**
	 * Unstage everything.
	 */
	unstageAll(): void {
		if (this.stagedPaths.size === 0) return;
		this.stagedPaths.clear();
		this.persist();
	}

	/**
	 * Check if a path is staged.
	 */
	isStaged(path: string): boolean {
		return this.stagedPaths.has(path);
	}

	/**
	 * Get all staged paths.
	 */
	getStagedPaths(): string[] {
		return [...this.stagedPaths];
	}

	/**
	 * Split changes into staged and unstaged.
	 */
	splitChanges(changes: NormalizedChange[]): { staged: NormalizedChange[]; unstaged: NormalizedChange[] } {
		const staged: NormalizedChange[] = [];
		const unstaged: NormalizedChange[] = [];
		for (const c of changes) {
			if (this.stagedPaths.has(c.path)) {
				staged.push(c);
			} else {
				unstaged.push(c);
			}
		}
		return { staged, unstaged };
	}

	/**
	 * Remove staged paths that no longer appear in the change list.
	 * Called after status poll to keep staging set clean.
	 */
	pruneStale(currentChanges: NormalizedChange[]): void {
		const currentPaths = new Set(currentChanges.map(c => c.path));
		let changed = false;
		for (const p of this.stagedPaths) {
			if (!currentPaths.has(p)) {
				this.stagedPaths.delete(p);
				changed = true;
			}
		}
		if (changed) this.persist();
	}

	private persist(): void {
		this.memento.update(MEMENTO_KEY, [...this.stagedPaths]);
		this.onDidChangeEmitter.fire();
	}

	dispose(): void {
		this.onDidChangeEmitter.dispose();
	}
}
