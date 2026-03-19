import { log } from '../util/logger';
import type { ReviewCommentInfo, ResolvedComment } from './types';

function parseLocationSpec(spec: string | undefined): { revisionId: number; lineNumber: number } | undefined {
	if (!spec) return undefined;
	const sep = spec.indexOf('#');
	if (sep < 0) return undefined;
	const revisionId = parseInt(spec.substring(0, sep), 10);
	const lineNumber = parseInt(spec.substring(sep + 1), 10);
	if (isNaN(revisionId) || isNaN(lineNumber)) return undefined;
	return { revisionId, lineNumber };
}

export async function resolveComments(
	comments: ReviewCommentInfo[],
	resolvePaths: (revisionIds: number[]) => Promise<Map<number, string>>,
): Promise<ResolvedComment[]> {
	log(`[resolveComments] ${comments.length} comments to resolve`);
	const parsed = comments.map(c => ({ comment: c, loc: parseLocationSpec(c.locationSpec) }));
	const withLoc = parsed.filter(p => p.loc);
	const withoutLoc = parsed.filter(p => !p.loc);
	log(`[resolveComments] ${withLoc.length} with locationSpec, ${withoutLoc.length} without`);
	if (withoutLoc.length > 0) {
		log(`[resolveComments] comments without locationSpec: ${withoutLoc.map(p => `id=${p.comment.id} type=${p.comment.type} locationSpec=${p.comment.locationSpec}`).join(', ')}`);
	}
	const revisionIds = [...new Set(
		parsed.map(p => p.loc?.revisionId).filter((id): id is number => id !== undefined),
	)];

	if (revisionIds.length === 0) {
		log('[resolveComments] no revision IDs found — returning empty');
		return [];
	}

	log(`[resolveComments] resolving paths for ${revisionIds.length} unique revision IDs (first 10: ${revisionIds.slice(0, 10).join(', ')})`);
	const pathMap = await resolvePaths(revisionIds);
	log(`[resolveComments] pathMap returned ${pathMap.size} entries`);
	if (pathMap.size > 0) {
		const first5 = [...pathMap.entries()].slice(0, 5);
		log(`[resolveComments] sample paths: ${first5.map(([id, p]) => `${id}→${p}`).join(', ')}`);
	} else if (revisionIds.length > 0) {
		log(`[resolveComments] WARNING: pathMap empty despite ${revisionIds.length} revision IDs`);
	}

	const resolved: ResolvedComment[] = [];
	for (const { comment, loc } of parsed) {
		if (!loc) continue;
		const filePath = pathMap.get(loc.revisionId);
		if (!filePath) continue;
		resolved.push({
			id: comment.id,
			owner: comment.owner,
			text: comment.text,
			type: comment.type,
			timestamp: comment.timestamp,
			filePath,
			lineNumber: loc.lineNumber,
			revisionId: loc.revisionId,
		});
	}

	log(`[resolveComments] ${resolved.length} comments resolved with file paths`);

	resolved.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.lineNumber - b.lineNumber);

	return resolved;
}
