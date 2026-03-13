import * as vscode from 'vscode';
import { PLASTIC_URI_SCHEME } from '../constants';
import { buildPlasticUri, parsePlasticUri } from '../util/uri';
import { fetchFileContent } from '../core/workspace';
import { logError } from '../util/logger';
import { LruCache } from '../util/cache';
import type { NormalizedChange } from '../core/types';

const DIFF_CHANGE_TYPES = new Set([
	'changed', 'checkedOut', 'replaced', 'moved', 'copied',
]);

/**
 * QuickDiffProvider for Plastic SCM — supplies the original file URI for inline diffs.
 *
 * Maintains a path→change map updated by the SCM provider after each poll.
 * Only returns original-resource URIs for change types that have a base revision
 * (changed, checkedOut, replaced, moved, copied).
 */
export class PlasticQuickDiffProvider implements vscode.QuickDiffProvider {
	private changeMap = new Map<string, NormalizedChange>();
	private workspaceRootPath = '';

	constructor(private readonly workspaceGuid: string) {}

	updateChanges(changes: NormalizedChange[], workspaceRoot: string): void {
		this.workspaceRootPath = workspaceRoot;
		this.changeMap.clear();
		for (const change of changes) {
			this.changeMap.set(change.path, change);
		}
	}

	provideOriginalResource(uri: vscode.Uri): vscode.Uri | undefined {
		const uriPath = uri.fsPath.replace(/\\/g, '/');
		const rootPath = this.workspaceRootPath.replace(/\\/g, '/');
		let relativePath = uriPath;
		if (rootPath && uriPath.startsWith(rootPath)) {
			relativePath = uriPath.substring(rootPath.length);
			if (relativePath.startsWith('/')) {
				relativePath = relativePath.substring(1);
			}
		}

		const change = this.changeMap.get(relativePath);
		if (!change || !DIFF_CHANGE_TYPES.has(change.changeType)) {
			return undefined;
		}

		const revSpec = change.revisionGuid ?? `serverpath:/${change.path}`;
		return buildPlasticUri(this.workspaceGuid, revSpec, change.path);
	}
}

/**
 * TextDocumentContentProvider for the plastic: URI scheme.
 * Fetches file content from the Plastic SCM server for diff views.
 * Caches results keyed by revSpec — revision content is immutable.
 */
export class PlasticContentProvider implements vscode.TextDocumentContentProvider {
	private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
	public readonly onDidChange = this.onDidChangeEmitter.event;
	private readonly cache = new LruCache<string, string>(50);

	async provideTextDocumentContent(uri: vscode.Uri): Promise<string | undefined> {
		const parsed = parsePlasticUri(uri);
		if (!parsed) return undefined;

		const cacheKey = parsed.revisionGuid;
		const cached = this.cache.get(cacheKey);
		if (cached !== undefined) return cached;

		try {
			const content = await fetchFileContent(parsed.revisionGuid);
			const text = content ? new TextDecoder('utf-8').decode(content) : '';
			this.cache.set(cacheKey, text);
			return text;
		} catch (err) {
			logError(`Failed to fetch content for ${uri.toString()}`, err);
			return '';
		}
	}

	dispose(): void {
		this.onDidChangeEmitter.dispose();
		this.cache.clear();
	}
}
