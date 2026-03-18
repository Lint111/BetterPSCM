import type { StagingStore } from '../core/stagingStore';

// Minimal interface matching vscode.Memento — no vscode import needed for the logic
interface Memento {
	get<T>(key: string, defaultValue: T): T;
	update(key: string, value: unknown): Thenable<void>;
}

type Listener = () => void;

const MEMENTO_KEY = 'plasticScm.stagedPaths';

/**
 * Staging store backed by VS Code workspace memento.
 * Replaces StagingManager — same persistence, implements StagingStore interface.
 */
export class MementoStagingStore implements StagingStore {
	private readonly paths: Set<string>;
	private readonly listeners: Listener[] = [];

	constructor(private readonly memento: Memento) {
		const stored = memento.get<string[]>(MEMENTO_KEY, []);
		this.paths = new Set(stored);
	}

	getAll(): Set<string> {
		return new Set(this.paths);
	}

	add(paths: string[]): void {
		let changed = false;
		for (const p of paths) {
			if (!this.paths.has(p)) {
				this.paths.add(p);
				changed = true;
			}
		}
		if (changed) this.persist();
	}

	remove(paths: string[]): void {
		let changed = false;
		for (const p of paths) {
			if (this.paths.delete(p)) changed = true;
		}
		if (changed) this.persist();
	}

	clear(): void {
		if (this.paths.size === 0) return;
		this.paths.clear();
		this.persist();
	}

	has(path: string): boolean {
		return this.paths.has(path);
	}

	/**
	 * Subscribe to staging changes. Returns a dispose function.
	 */
	onDidChange(listener: Listener): { dispose: () => void } {
		this.listeners.push(listener);
		return { dispose: () => { const i = this.listeners.indexOf(listener); if (i >= 0) this.listeners.splice(i, 1); } };
	}

	private persist(): void {
		this.memento.update(MEMENTO_KEY, [...this.paths]);
		for (const l of this.listeners) l();
	}
}
