import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { unlink } from 'fs/promises';
import { join } from 'path';
import { execCmToFile } from './cmCli';
import type { NormalizedChange } from './types';

/** Batch size for parallel SHA-256 comparisons. Balances throughput against cm CLI load. */
export const STALE_DETECTION_BATCH_SIZE = 5;

/** Change types whose content can be stale (reported as modified but identical to base revision). */
export const STALE_CANDIDATE_CHANGE_TYPES = new Set<string>(['changed', 'checkedOut']);

/** Hash a file using streaming SHA-256 — no full content in memory. */
export function hashFile(filePath: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash('sha256');
		const stream = createReadStream(filePath);
		stream.on('data', (chunk) => hash.update(chunk));
		stream.on('end', () => resolve(hash.digest('hex')));
		stream.on('error', reject);
	});
}

/**
 * Check if a file is stale by comparing its SHA-256 hash against
 * the base revision fetched via `cm cat` (streamed to temp file for raw bytes).
 *
 * Returns true only when hashes match. Any error (missing base, cm failure)
 * returns false — the safe default is "assume changed".
 */
export async function isFileStale(filePath: string, wsRoot: string): Promise<boolean> {
	try {
		const absPath = join(wsRoot, filePath);
		const baseTempPath = await execCmToFile(['cat', filePath, '--raw']);
		if (!baseTempPath) return false;
		try {
			const [workHash, baseHash] = await Promise.all([
				hashFile(absPath),
				hashFile(baseTempPath),
			]);
			return workHash === baseHash;
		} finally {
			unlink(baseTempPath).catch(() => {});
		}
	} catch {
		return false;
	}
}

/** Result of a stale-detection sweep over a list of changes. */
export interface StaleDetectionResult {
	/** Paths whose content is byte-identical to the base revision. */
	stalePaths: string[];
	/** Paths that were scanned but had real content differences. */
	trulyChangedPaths: string[];
	/** Paths that were skipped entirely (non-candidate changeType, directories, etc.). */
	skippedPaths: string[];
}

/**
 * Scan a set of changes and identify which ones are stale via content hash comparison.
 * Only file-type changes with a candidate changeType (changed, checkedOut) are scanned.
 * Added, deleted, moved, and private files are returned in `skippedPaths`.
 */
export async function detectStaleChanges(
	changes: readonly NormalizedChange[],
	wsRoot: string,
): Promise<StaleDetectionResult> {
	const stalePaths: string[] = [];
	const trulyChangedPaths: string[] = [];
	const skippedPaths: string[] = [];

	const candidates: string[] = [];
	for (const change of changes) {
		if (change.dataType !== 'File' || !STALE_CANDIDATE_CHANGE_TYPES.has(change.changeType)) {
			skippedPaths.push(change.path);
			continue;
		}
		candidates.push(change.path);
	}

	for (let i = 0; i < candidates.length; i += STALE_DETECTION_BATCH_SIZE) {
		const batch = candidates.slice(i, i + STALE_DETECTION_BATCH_SIZE);
		const results = await Promise.all(
			batch.map(async (filePath) => ({
				filePath,
				stale: await isFileStale(filePath, wsRoot),
			})),
		);
		for (const { filePath, stale } of results) {
			if (stale) {
				stalePaths.push(filePath);
			} else {
				trulyChangedPaths.push(filePath);
			}
		}
	}

	return { stalePaths, trulyChangedPaths, skippedPaths };
}
