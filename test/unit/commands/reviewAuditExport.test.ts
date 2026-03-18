import { describe, it, expect } from 'vitest';
import { generateAuditMarkdown } from '../../../src/commands/reviewAuditExport';
import type { ResolvedComment, CodeReviewInfo } from '../../../src/core/types';

describe('generateAuditMarkdown', () => {
	const review: CodeReviewInfo = {
		id: 43381,
		title: 'Refactor unit config tool',
		status: 'Rework required',
		owner: 'theo@outlook.com',
		created: '2026-02-17T10:00:00',
		modified: '2026-02-17T16:00:00',
		targetType: 'Branch',
		targetSpec: '/main/feature-x',
		targetId: 100,
		commentsCount: 2,
		reviewers: [],
	};

	it('generates markdown with code snippets and comments', () => {
		const comments: ResolvedComment[] = [
			{ id: 1, owner: 'theo@outlook.com', text: 'Fix this null check', type: 'Comment', timestamp: '2026-02-17T15:00:00', filePath: 'Assets/Scripts/Foo.cs', lineNumber: 37 },
		];
		const fileContents = new Map<string, string[]>([
			['Assets/Scripts/Foo.cs', [
				'using System;',
				...Array(34).fill(''),
				'    if (x == null) {',
				'        return null;',
				'    }',
				...Array(2).fill(''),
			]],
		]);

		const md = generateAuditMarkdown(review, comments, fileContents, 2);

		expect(md).toContain('# Code Review Audit: Review #43381');
		expect(md).toContain('Refactor unit config tool');
		expect(md).toContain('Rework required');
		expect(md).toContain('## Assets/Scripts/Foo.cs');
		expect(md).toContain('### Line 37');
		expect(md).toContain('theo@outlook.com');
		expect(md).toContain('>> 37');
		expect(md).toContain('Fix this null check');
	});

	it('groups multiple comments under same file', () => {
		const comments: ResolvedComment[] = [
			{ id: 1, owner: 'a', text: 'First', type: 'Comment', timestamp: '', filePath: 'Foo.cs', lineNumber: 5 },
			{ id: 2, owner: 'b', text: 'Second', type: 'Question', timestamp: '', filePath: 'Foo.cs', lineNumber: 20 },
		];
		const fileContents = new Map<string, string[]>([
			['Foo.cs', Array(30).fill('code')],
		]);

		const md = generateAuditMarkdown(review, comments, fileContents, 2);

		const fileHeaders = md.match(/## Foo\.cs/g);
		expect(fileHeaders).toHaveLength(1);
		expect(md).toContain('### Line 5');
		expect(md).toContain('### Line 20');
	});
});
