import type { PlasticBackend } from './backend';
import type { StagingStore } from './stagingStore';
import type { StatusResult, CheckinResult } from './types';
import { expandMetaCompanions, isCommittableChange } from './safety';
import { normalizePath } from '../util/path';

/** Options for staging and add-to-source-control operations. */
export interface StageOptions {
	/** Automatically include companion .meta files (Unity convention). */
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

	/** Retrieve pending workspace changes. */
	async getStatus(showPrivate = true): Promise<StatusResult> {
		return this.backend.getStatus(showPrivate);
	}

	// ── Staging ─────────────────────────────────────────────────────

	/** Stage files for the next checkin. With autoMeta, companion .meta files are included. */
	async stage(paths: string[], options?: StageOptions): Promise<void> {
		let toStage = paths;
		if (options?.autoMeta) {
			const status = await this.backend.getStatus(true);
			const allPaths = new Set(status.changes.map(c => c.path));
			toStage = expandMetaCompanions(paths, allPaths);
		}
		this.store.add(toStage);
	}

	/** Remove files from the staging area. */
	async unstage(paths: string[]): Promise<void> {
		this.store.remove(paths);
	}

	/** Stage all pending changes. */
	async stageAll(): Promise<void> {
		const status = await this.backend.getStatus(true);
		this.store.add(status.changes.map(c => c.path));
	}

	/** Clear the entire staging area. */
	async unstageAll(): Promise<void> {
		this.store.clear();
	}

	/** Return a snapshot of all currently staged file paths. */
	getStagedPaths(): string[] {
		return [...this.store.getAll()];
	}

	/** Check whether a specific path is currently staged. */
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

	/**
	 * Check in staged (or all) files. Automatically adds private files,
	 * excludes uncommittable items, and retries on transient "not changed" errors.
	 */
	async checkin(options: {
		comment: string;
		all?: boolean;
		excludePaths?: string[];
		autoAddPrivate?: boolean;
	}): Promise<CheckinResult & { autoExcluded: string[]; autoAdded: string[]; autoRemoved: string[] }> {
		const { comment, all, excludePaths, autoAddPrivate = true } = options;

		const status = await this.backend.getStatus(true);
		const changeMap = new Map(status.changes.map(c => [c.path, c.changeType]));

		let paths = this._resolvePaths(status, { all, excludePaths });
		const autoAdded = autoAddPrivate ? await this._autoAddPrivate(paths, changeMap) : [];
		const autoRemoved = await this._autoRemoveDeleted(paths, changeMap);
		const { filtered, autoExcluded } = this._filterCommittable(paths, changeMap, autoAdded);
		const result = await this._checkinWithRetry(filtered, comment, autoExcluded);

		this.store.clear();
		return { ...result, autoExcluded, autoAdded, autoRemoved };
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
			const excludeSet = new Set(options.excludePaths.map(p => normalizePath(p)));
			paths = paths.filter(p => !excludeSet.has(normalizePath(p)));
		}

		return paths;
	}

	private async _autoAddPrivate(
		paths: string[],
		changeMap: Map<string, string>,
	): Promise<string[]> {
		const autoAdded: string[] = [];
		const privatePaths = paths.filter(p => {
			const ct = changeMap.get(p) || changeMap.get(normalizePath(p));
			return ct === 'private';
		});
		if (privatePaths.length > 0) {
			const metaToAdd: string[] = [];
			for (const filePath of privatePaths) {
				const metaPath = filePath + '.meta';
				const normalizedMeta = normalizePath(metaPath);
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

	/**
	 * Detect locally-deleted files and run `cm remove` to mark them for deletion.
	 * Without this, cm checkin fails because it can't read content from missing files.
	 */
	private async _autoRemoveDeleted(
		paths: string[],
		changeMap: Map<string, string>,
	): Promise<string[]> {
		const locallyDeleted = paths.filter(p => {
			const ct = changeMap.get(p) || changeMap.get(normalizePath(p));
			return ct === 'locallyDeleted';
		});
		if (locallyDeleted.length === 0) return [];
		await this.backend.removeFromSourceControl(locallyDeleted);
		// Update changeMap so downstream filters see 'deleted' instead of 'locallyDeleted'
		for (const p of locallyDeleted) {
			changeMap.set(p, 'deleted');
		}
		return locallyDeleted;
	}

	private _filterCommittable(
		paths: string[],
		changeMap: Map<string, string>,
		autoAdded: string[],
	): { filtered: string[]; autoExcluded: string[] } {
		const autoExcluded: string[] = [];
		const filtered = paths.filter(p => {
			if (autoAdded.includes(p)) return true;
			const ct = changeMap.get(p) || changeMap.get(normalizePath(p));
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
		const MAX_RETRIES = 20;
		let remaining = paths;
		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			try {
				return await this.backend.checkin(remaining, comment);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				// Match various cm rejection patterns for unchanged/stale files
				const match = msg.match(/The item '([^']+)' is not changed/i)
					|| msg.match(/item '([^']+)' (?:has no changes|is unchanged|was not modified)/i)
					|| msg.match(/cannot checkin '([^']+)'/i)
					|| msg.match(/not changed in current workspace.*?'([^']+)'/i)
					|| msg.match(/'([^']+)'.*not changed/i);
				if (match && attempt < MAX_RETRIES) {
					const rejected = normalizePath(match[1]);
					const filtered = remaining.filter(p => {
						const norm = normalizePath(p);
						return p !== rejected && norm !== rejected
							&& !p.endsWith(rejected) && !norm.endsWith(rejected)
							&& !rejected.endsWith(norm) && !rejected.endsWith(p);
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

	/** Add private files to source control, expanding directories and companion .meta files. */
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
			const normalized = normalizePath(p).replace(/\/$/, '');

			// Exact match
			const exact = privateFiles.find(f =>
				f === normalized || f === p || normalizePath(f) === normalized,
			);
			if (exact) {
				toAdd.add(exact);
				continue;
			}

			// Directory prefix
			const prefix = normalized.endsWith('/') ? normalized : normalized + '/';
			let matched = false;
			for (const priv of privateFiles) {
				const normPriv = normalizePath(priv);
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
				const normalizedMeta = normalizePath(metaPath);
				const metaExists = privateFiles.find(f =>
					f === metaPath || normalizePath(f) === normalizedMeta,
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
