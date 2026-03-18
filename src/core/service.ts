import type { PlasticBackend } from './backend';
import type { StagingStore } from './stagingStore';
import type { StatusResult } from './types';
import { expandMetaCompanions } from './safety';

export interface StageOptions {
	autoMeta?: boolean;
}

/**
 * Shared orchestration service for Plastic SCM operations.
 * Both the VS Code extension and standalone MCP server instantiate this
 * with their own backend and staging store implementations.
 */
export class PlasticService {
	constructor(
		private readonly backend: PlasticBackend,
		private readonly store: StagingStore,
	) {}

	// ── Status ──────────────────────────────────────────────────────

	async getStatus(showPrivate = true): Promise<StatusResult> {
		return this.backend.getStatus(showPrivate);
	}

	// ── Staging ─────────────────────────────────────────────────────

	async stage(paths: string[], options?: StageOptions): Promise<void> {
		let toStage = paths;
		if (options?.autoMeta) {
			const status = await this.backend.getStatus(true);
			const allPaths = new Set(status.changes.map(c => c.path));
			toStage = expandMetaCompanions(paths, allPaths);
		}
		this.store.add(toStage);
	}

	async unstage(paths: string[]): Promise<void> {
		this.store.remove(paths);
	}

	async stageAll(): Promise<void> {
		const status = await this.backend.getStatus(true);
		this.store.add(status.changes.map(c => c.path));
	}

	async unstageAll(): Promise<void> {
		this.store.clear();
	}

	getStagedPaths(): string[] {
		return [...this.store.getAll()];
	}

	isStaged(path: string): boolean {
		return this.store.has(path);
	}

	/**
	 * Remove staged paths that no longer appear in current changes.
	 */
	async pruneStale(): Promise<void> {
		const status = await this.backend.getStatus(true);
		const currentPaths = new Set(status.changes.map(c => c.path));
		const stale = this.getStagedPaths().filter(p => !currentPaths.has(p));
		if (stale.length > 0) this.store.remove(stale);
	}
}
