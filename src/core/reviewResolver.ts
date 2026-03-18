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
	const parsed = comments.map(c => ({ comment: c, loc: parseLocationSpec(c.locationSpec) }));
	const revisionIds = [...new Set(
		parsed.map(p => p.loc?.revisionId).filter((id): id is number => id !== undefined),
	)];

	if (revisionIds.length === 0) return [];

	const pathMap = await resolvePaths(revisionIds);

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
		});
	}

	resolved.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.lineNumber - b.lineNumber);

	return resolved;
}
