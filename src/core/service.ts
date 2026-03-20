import type { PlasticBackend } from './backend';
import type { StagingStore } from './stagingStore';
import type { StatusResult, CheckinResult } from './types';
import { expandMetaCompanions, isCommittableChange } from './safety';

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

	// ── Checkin ─────────────────────────────────────────────────────

	async checkin(options: {
		comment: string;
		all?: boolean;
		excludePaths?: string[];
		autoAddPrivate?: boolean;
	}): Promise<CheckinResult & { autoExcluded: string[]; autoAdded: string[] }> {
		const { comment, all, excludePaths, autoAddPrivate = true } = options;

		const status = await this.backend.getStatus(true);
		const changeMap = new Map(status.changes.map(c => [c.path, c.changeType]));

		let paths = this._resolvePaths(status, { all, excludePaths });
		const autoAdded = autoAddPrivate ? await this._autoAddPrivate(paths, changeMap) : [];
		const { filtered, autoExcluded } = this._filterCommittable(paths, changeMap, autoAdded);
		const result = await this._checkinWithRetry(filtered, comment, autoExcluded);

		this.store.clear();
		return { ...result, autoExcluded, autoAdded };
	}

	private _resolvePaths(
		status: StatusResult,
		options: { all?: boolean; excludePaths?: string[] },
	): string[] {
		let paths: string[];
		if (options.all) {
			paths = status.changes.filter(c => c.dataType !== 'Directory').map(c => c.path);
		} else if (this.store.getAll().size > 0) {
			paths = [...this.store.getAll()];
		} else {
			throw new Error('No files staged. Use stage first, or set all=true.');
		}

		if (options.excludePaths && options.excludePaths.length > 0) {
			const excludeSet = new Set(options.excludePaths.map(p => p.replace(/\\/g, '/')));
			paths = paths.filter(p => !excludeSet.has(p.replace(/\\/g, '/')));
		}

		return paths;
	}

	private async _autoAddPrivate(
		paths: string[],
		changeMap: Map<string, string>,
	): Promise<string[]> {
		const autoAdded: string[] = [];
		const privatePaths = paths.filter(p => {
			const ct = changeMap.get(p) || changeMap.get(p.replace(/\\/g, '/'));
			return ct === 'private';
		});
		if (privatePaths.length > 0) {
			const metaToAdd: string[] = [];
			for (const filePath of privatePaths) {
				const metaPath = filePath + '.meta';
				const normalizedMeta = metaPath.replace(/\\/g, '/');
				const metaChange = changeMap.get(metaPath) || changeMap.get(normalizedMeta);
				if (metaChange === 'private' && !paths.includes(metaPath) && !paths.includes(normalizedMeta)) {
					metaToAdd.push(changeMap.has(metaPath) ? metaPath : normalizedMeta);
				}
			}
			// Mutate paths array so downstream steps see expanded list
			paths.push(...metaToAdd);
			const allToAdd = [...privatePaths, ...metaToAdd];
			await this.backend.addToSourceControl(allToAdd);
			autoAdded.push(...allToAdd);
		}
		return autoAdded;
	}

	private _filterCommittable(
		paths: string[],
		changeMap: Map<string, string>,
		autoAdded: string[],
	): { filtered: string[]; autoExcluded: string[] } {
		const autoExcluded: string[] = [];
		const filtered = paths.filter(p => {
			if (autoAdded.includes(p)) return true;
			const ct = changeMap.get(p) || changeMap.get(p.replace(/\\/g, '/'));
			if (!ct || !isCommittableChange(ct)) {
				autoExcluded.push(p);
				return false;
			}
			return true;
		});

		if (filtered.length === 0) {
			throw new Error(
				'No files with real changes to check in. ' +
				(autoExcluded.length > 0
					? `${autoExcluded.length} stale item(s) were auto-excluded.`
					: 'All files were excluded.'),
			);
		}

		return { filtered, autoExcluded };
	}

	private async _checkinWithRetry(
		paths: string[],
		comment: string,
		autoExcluded: string[],
	): Promise<CheckinResult> {
		const MAX_RETRIES = 5;
		let remaining = paths;
		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			try {
				return await this.backend.checkin(remaining, comment);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				const match = msg.match(/The item '([^']+)' is not changed/i);
				if (match && attempt < MAX_RETRIES) {
					const rejected = match[1];
					const filtered = remaining.filter(p => {
						const norm = p.replace(/\\/g, '/');
						return p !== rejected && norm !== rejected
							&& !p.endsWith(rejected) && !norm.endsWith(rejected);
					});
					autoExcluded.push(rejected);
					if (filtered.length === 0) throw err;
					remaining = filtered;
					continue;
				}
				throw err;
			}
		}
		// Unreachable — loop always returns or throws
		throw new Error('Checkin retry loop exhausted');
	}

	// ── Add to source control ───────────────────────────────────────

	async addToSourceControl(
		paths: string[],
		options?: StageOptions,
	): Promise<string[]> {
		const status = await this.backend.getStatus(true);
		const privateFiles = status.changes
			.filter(c => c.changeType === 'private' && c.dataType === 'File')
			.map(c => c.path);

		const toAdd = new Set<string>();

		for (const p of paths) {
			const normalized = p.replace(/\\/g, '/').replace(/\/$/, '');

			// Exact match
			const exact = privateFiles.find(f =>
				f === normalized || f === p || f.replace(/\\/g, '/') === normalized,
			);
			if (exact) {
				toAdd.add(exact);
				continue;
			}

			// Directory prefix
			const prefix = normalized.endsWith('/') ? normalized : normalized + '/';
			let matched = false;
			for (const priv of privateFiles) {
				const normPriv = priv.replace(/\\/g, '/');
				if (normPriv.startsWith(prefix) || normPriv.toLowerCase().startsWith(prefix.toLowerCase())) {
					toAdd.add(priv);
					matched = true;
				}
			}

			if (!matched) toAdd.add(p);
		}

		// Meta expansion
		if (options?.autoMeta !== false) {
			const metaToAdd: string[] = [];
			for (const filePath of toAdd) {
				const metaPath = filePath + '.meta';
				const normalizedMeta = metaPath.replace(/\\/g, '/');
				const metaExists = privateFiles.find(f =>
					f === metaPath || f.replace(/\\/g, '/') === normalizedMeta,
				);
				if (metaExists && !toAdd.has(metaExists)) {
					metaToAdd.push(metaExists);
				}
			}
			for (const m of metaToAdd) toAdd.add(m);
		}

		if (toAdd.size === 0) return [];
		const addArray = [...toAdd];
		await this.backend.addToSourceControl(addArray);
		return addArray;
	}
}
