# CLI Code Review Parity — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement 7 of 11 code review backend methods in the CLI backend using `cm find review`, `cm find reviewcomment`, and `cm codereview` commands.

**Architecture:** Each method calls `execCm()` with the appropriate `cm find` or `cm codereview` arguments, then parses the output. Review queries use delimiter-based `--format`, comment queries use `--xml` (comments can contain newlines/delimiters). Comment type detection maps system-event prefixes like `[status-reviewed]` to `ReviewCommentType` values. Reviewer list is reconstructed from comment events.

**Tech Stack:** TypeScript, Vitest, `execCm()` from `src/core/cmCli.ts`

---

### Task 1: Review output parser + listCodeReviews

**Files:**
- Modify: `src/core/backendCli.ts:428-439`
- Test: `test/unit/core/backendCli.test.ts`

**Step 1: Write failing tests for review line parsing and listCodeReviews**

Add to the end of the existing `describe('CliBackend', ...)` block in `test/unit/core/backendCli.test.ts`:

```typescript
describe('listCodeReviews', () => {
	it('parses cm find review output into CodeReviewInfo[]', async () => {
		mockExecCm.mockResolvedValue({
			stdout: [
				'43381#Review of changeset 531#Status Reviewed#snoff4@icloud.com#17/02/2026 14:59:28#Changeset#531#theo.muenster@outlook.com',
				'48560#Review of branch /main/Tech/unit-formations#Status Rework required#ioanaraileanu24@yahoo.com#05/03/2026 15:43:26#Branch#id:47235#theo.muenster@outlook.com',
			].join('\n'),
			stderr: '',
			exitCode: 0,
		});

		const reviews = await backend.listCodeReviews();
		expect(reviews).toHaveLength(2);
		expect(reviews[0]).toMatchObject({
			id: 43381,
			title: 'Review of changeset 531',
			status: 'Reviewed',
			owner: 'snoff4@icloud.com',
			targetType: 'Changeset',
			assignee: 'theo.muenster@outlook.com',
		});
		expect(reviews[1]).toMatchObject({
			id: 48560,
			status: 'Rework required',
			targetType: 'Branch',
		});
	});

	it('applies assignedToMe filter', async () => {
		mockExecCm.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
		await backend.listCodeReviews('assignedToMe');
		expect(mockExecCm).toHaveBeenCalledWith(
			expect.arrayContaining(["where assignee = 'me'"]),
		);
	});

	it('applies createdByMe filter', async () => {
		mockExecCm.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
		await backend.listCodeReviews('createdByMe');
		expect(mockExecCm).toHaveBeenCalledWith(
			expect.arrayContaining(["where owner = 'me'"]),
		);
	});

	it('applies pending filter', async () => {
		mockExecCm.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
		await backend.listCodeReviews('pending');
		expect(mockExecCm).toHaveBeenCalledWith(
			expect.arrayContaining(["where status = 'Under review'"]),
		);
	});

	it('handles empty result', async () => {
		mockExecCm.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
		const reviews = await backend.listCodeReviews();
		expect(reviews).toEqual([]);
	});

	it('handles review with no assignee', async () => {
		mockExecCm.mockResolvedValue({
			stdout: '49200#My review#Status Under review#me@test.com#09/03/2026 15:39:08#Branch#id:123#\n',
			stderr: '',
			exitCode: 0,
		});
		const reviews = await backend.listCodeReviews();
		expect(reviews[0].assignee).toBeUndefined();
	});

	it('throws on cm failure', async () => {
		mockExecCm.mockResolvedValue({ stdout: '', stderr: 'error', exitCode: 1 });
		await expect(backend.listCodeReviews()).rejects.toThrow();
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /mnt/c/Github/BetterSCM && npx vitest run test/unit/core/backendCli.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — `NotSupportedError`

**Step 3: Implement parseReviewLine and listCodeReviews**

In `src/core/backendCli.ts`, replace the `listCodeReviews` stub (line 429) with:

```typescript
async listCodeReviews(filter?: 'all' | 'assignedToMe' | 'createdByMe' | 'pending'): Promise<CodeReviewInfo[]> {
	const filterMap: Record<string, string> = {
		assignedToMe: "where assignee = 'me'",
		createdByMe: "where owner = 'me'",
		pending: "where status = 'Under review'",
	};
	const args = [
		'find', 'review',
		...(filter && filterMap[filter] ? [filterMap[filter]] : []),
		'--format={id}#{title}#{status}#{owner}#{date}#{targettype}#{target}#{assignee}',
		'--nototal',
	];
	const result = await execCm(args);
	if (result.exitCode !== 0) {
		throw new Error(`cm find review failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
	}
	const lines = result.stdout.split(/\r?\n/).filter(l => l.length > 0);
	return lines.map(parseReviewLine).filter((r): r is CodeReviewInfo => r !== undefined);
}
```

Add the parser function before the class (near other parsers):

```typescript
function parseReviewLine(line: string): CodeReviewInfo | undefined {
	const parts = line.split('#');
	if (parts.length < 7) return undefined;
	const [idStr, title, rawStatus, owner, date, targetType, target, assignee] = parts;
	const id = parseInt(idStr, 10);
	if (isNaN(id)) return undefined;
	// Status comes as "Status Reviewed" — strip the prefix
	const status = rawStatus.replace(/^Status\s+/i, '') as ReviewStatus;
	return {
		id,
		title: title ?? '',
		status,
		owner: owner ?? '',
		created: date ?? '',
		modified: date ?? '', // cm find review doesn't expose modified separately
		targetType: (targetType === 'Branch' ? 'Branch' : 'Changeset') as 'Branch' | 'Changeset',
		targetSpec: target ?? undefined,
		targetId: parseInt(target ?? '0', 10) || 0,
		assignee: assignee?.trim() || undefined,
		commentsCount: 0, // not available via cm find review
		reviewers: [], // populated by getReviewers if needed
	};
}
```

Also add `ReviewStatus` to the import from `'./types'` if not already present.

**Step 4: Run tests to verify they pass**

Run: `cd /mnt/c/Github/BetterSCM && npx vitest run test/unit/core/backendCli.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: PASS

**Step 5: Commit**

```bash
cd /mnt/c/Github/BetterSCM && git add src/core/backendCli.ts test/unit/core/backendCli.test.ts
git commit -m "feat(cli): implement listCodeReviews via cm find review"
```

---

### Task 2: getCodeReview

**Files:**
- Modify: `src/core/backendCli.ts`
- Test: `test/unit/core/backendCli.test.ts`

**Step 1: Write failing test**

```typescript
describe('getCodeReview', () => {
	it('returns single review by ID', async () => {
		mockExecCm.mockResolvedValue({
			stdout: '43381#Review of changeset 531#Status Reviewed#snoff4@icloud.com#17/02/2026 14:59:28#Changeset#531#theo.muenster@outlook.com\n',
			stderr: '',
			exitCode: 0,
		});

		const review = await backend.getCodeReview(43381);
		expect(review.id).toBe(43381);
		expect(review.title).toBe('Review of changeset 531');
		expect(mockExecCm).toHaveBeenCalledWith(
			expect.arrayContaining(['where id=43381']),
		);
	});

	it('throws if review not found', async () => {
		mockExecCm.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
		await expect(backend.getCodeReview(99999)).rejects.toThrow('not found');
	});
});
```

**Step 2: Run tests — expect FAIL**

**Step 3: Implement getCodeReview**

Replace the `getCodeReview` stub:

```typescript
async getCodeReview(id: number): Promise<CodeReviewInfo> {
	const result = await execCm([
		'find', 'review',
		`where id=${id}`,
		'--format={id}#{title}#{status}#{owner}#{date}#{targettype}#{target}#{assignee}',
		'--nototal',
	]);
	if (result.exitCode !== 0) {
		throw new Error(`cm find review failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
	}
	const lines = result.stdout.split(/\r?\n/).filter(l => l.length > 0);
	const reviews = lines.map(parseReviewLine).filter((r): r is CodeReviewInfo => r !== undefined);
	if (reviews.length === 0) {
		throw new Error(`Code review ${id} not found`);
	}
	return reviews[0];
}
```

**Step 4: Run tests — expect PASS**

**Step 5: Commit**

```bash
cd /mnt/c/Github/BetterSCM && git add src/core/backendCli.ts test/unit/core/backendCli.test.ts
git commit -m "feat(cli): implement getCodeReview via cm find review"
```

---

### Task 3: createCodeReview

**Files:**
- Modify: `src/core/backendCli.ts`
- Test: `test/unit/core/backendCli.test.ts`

**Step 1: Write failing tests**

```typescript
describe('createCodeReview', () => {
	it('creates review for a changeset', async () => {
		// First call: cm codereview (create) returns the new ID
		mockExecCm
			.mockResolvedValueOnce({ stdout: '99001\n', stderr: '', exitCode: 0 })
			// Second call: cm find review (fetch created review)
			.mockResolvedValueOnce({
				stdout: '99001#My review#Status Under review#me@test.com#18/03/2026 10:00:00#Changeset#100#\n',
				stderr: '',
				exitCode: 0,
			});

		const review = await backend.createCodeReview({
			title: 'My review',
			targetType: 'Changeset',
			targetId: 100,
		});
		expect(review.id).toBe(99001);
		expect(review.title).toBe('My review');
		const createArgs = mockExecCm.mock.calls[0][0];
		expect(createArgs).toContain('codereview');
		expect(createArgs).toContain('cs:100');
		expect(createArgs).toContain('My review');
	});

	it('creates review for a branch with spec', async () => {
		mockExecCm
			.mockResolvedValueOnce({ stdout: '99002\n', stderr: '', exitCode: 0 })
			.mockResolvedValueOnce({
				stdout: '99002#Branch review#Status Under review#me@test.com#18/03/2026#Branch#/main/feature#\n',
				stderr: '',
				exitCode: 0,
			});

		await backend.createCodeReview({
			title: 'Branch review',
			targetType: 'Branch',
			targetId: 0,
			targetSpec: '/main/feature',
		});
		const createArgs = mockExecCm.mock.calls[0][0];
		expect(createArgs).toContain('br:/main/feature');
	});

	it('passes --assignee when reviewers provided', async () => {
		mockExecCm
			.mockResolvedValueOnce({ stdout: '99003\n', stderr: '', exitCode: 0 })
			.mockResolvedValueOnce({
				stdout: '99003#Review#Status Under review#me@test.com#18/03/2026#Changeset#50#bob@test.com\n',
				stderr: '',
				exitCode: 0,
			});

		await backend.createCodeReview({
			title: 'Review',
			targetType: 'Changeset',
			targetId: 50,
			reviewers: ['bob@test.com'],
		});
		const createArgs = mockExecCm.mock.calls[0][0];
		expect(createArgs).toContain('--assignee=bob@test.com');
	});

	it('throws on cm failure', async () => {
		mockExecCm.mockResolvedValue({ stdout: '', stderr: 'error', exitCode: 1 });
		await expect(backend.createCodeReview({
			title: 'Fail',
			targetType: 'Changeset',
			targetId: 1,
		})).rejects.toThrow();
	});
});
```

**Step 2: Run tests — expect FAIL**

**Step 3: Implement createCodeReview**

```typescript
async createCodeReview(params: CreateReviewParams): Promise<CodeReviewInfo> {
	// Build target spec
	let spec: string;
	if (params.targetSpec) {
		spec = params.targetType === 'Branch'
			? `br:${params.targetSpec}`
			: `cs:${params.targetSpec}`;
	} else {
		spec = params.targetType === 'Branch'
			? `br:id:${params.targetId}`
			: `cs:${params.targetId}`;
	}

	const args = ['codereview', spec, params.title, '--format={id}'];
	if (params.reviewers && params.reviewers.length > 0) {
		args.push(`--assignee=${params.reviewers[0]}`);
	}

	const result = await execCm(args);
	if (result.exitCode !== 0) {
		throw new Error(`cm codereview create failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
	}

	const newId = parseInt(result.stdout.trim(), 10);
	if (isNaN(newId)) {
		throw new Error(`cm codereview returned unexpected output: ${result.stdout}`);
	}

	// Fetch the full review object
	return this.getCodeReview(newId);
}
```

**Step 4: Run tests — expect PASS**

**Step 5: Commit**

```bash
cd /mnt/c/Github/BetterSCM && git add src/core/backendCli.ts test/unit/core/backendCli.test.ts
git commit -m "feat(cli): implement createCodeReview via cm codereview"
```

---

### Task 4: deleteCodeReview + updateCodeReviewStatus

**Files:**
- Modify: `src/core/backendCli.ts`
- Test: `test/unit/core/backendCli.test.ts`

**Step 1: Write failing tests**

```typescript
describe('deleteCodeReview', () => {
	it('calls cm codereview -d with ID', async () => {
		mockExecCm.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
		await backend.deleteCodeReview(43381);
		expect(mockExecCm).toHaveBeenCalledWith(['codereview', '-d', '43381']);
	});

	it('throws on failure', async () => {
		mockExecCm.mockResolvedValue({ stdout: '', stderr: 'not found', exitCode: 1 });
		await expect(backend.deleteCodeReview(99999)).rejects.toThrow();
	});
});

describe('updateCodeReviewStatus', () => {
	it('calls cm codereview -e with status', async () => {
		mockExecCm.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
		await backend.updateCodeReviewStatus(43381, 'Reviewed');
		expect(mockExecCm).toHaveBeenCalledWith([
			'codereview', '-e', '43381', '--status=Reviewed',
		]);
	});

	it('handles "Rework required" status with quotes', async () => {
		mockExecCm.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
		await backend.updateCodeReviewStatus(48560, 'Rework required');
		expect(mockExecCm).toHaveBeenCalledWith([
			'codereview', '-e', '48560', '--status=Rework required',
		]);
	});

	it('throws on failure', async () => {
		mockExecCm.mockResolvedValue({ stdout: '', stderr: 'error', exitCode: 1 });
		await expect(backend.updateCodeReviewStatus(1, 'Reviewed')).rejects.toThrow();
	});
});
```

**Step 2: Run tests — expect FAIL**

**Step 3: Implement both methods**

```typescript
async deleteCodeReview(id: number): Promise<void> {
	const result = await execCm(['codereview', '-d', String(id)]);
	if (result.exitCode !== 0) {
		throw new Error(`cm codereview delete failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
	}
}

async updateCodeReviewStatus(id: number, status: ReviewStatus): Promise<void> {
	const result = await execCm(['codereview', '-e', String(id), `--status=${status}`]);
	if (result.exitCode !== 0) {
		throw new Error(`cm codereview edit failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
	}
}
```

**Step 4: Run tests — expect PASS**

**Step 5: Commit**

```bash
cd /mnt/c/Github/BetterSCM && git add src/core/backendCli.ts test/unit/core/backendCli.test.ts
git commit -m "feat(cli): implement deleteCodeReview and updateCodeReviewStatus"
```

---

### Task 5: getReviewComments (XML parsing)

**Files:**
- Modify: `src/core/backendCli.ts`
- Test: `test/unit/core/backendCli.test.ts`

**Step 1: Write failing tests**

```typescript
describe('getReviewComments', () => {
	const xmlOutput = `<?xml version="1.0" encoding="utf-8" ?>
<PLASTICQUERY>
  <REVIEWCOMMENT>
    <ID>43382</ID>
    <OWNER>snoff4@icloud.com</OWNER>
    <DATE>2026-02-17T15:11:51+02:00</DATE>
    <COMMENT>[description]Initial feature creation of the UCT.</COMMENT>
    <REVISIONID>-1</REVISIONID>
    <REVIEWID>43381</REVIEWID>
    <LOCATION>-1</LOCATION>
  </REVIEWCOMMENT>
  <REVIEWCOMMENT>
    <ID>43386</ID>
    <OWNER>theo.muenster@outlook.com</OWNER>
    <DATE>2026-02-17T15:15:32+02:00</DATE>
    <COMMENT>Any reason to keep these comments?</COMMENT>
    <REVISIONID>42939</REVISIONID>
    <REVIEWID>43381</REVIEWID>
    <LOCATION>37</LOCATION>
  </REVIEWCOMMENT>
  <REVIEWCOMMENT>
    <ID>43400</ID>
    <OWNER>theo.muenster@outlook.com</OWNER>
    <DATE>2026-02-17T15:36:40+02:00</DATE>
    <COMMENT>[status-rework-required]Apply the feedback.</COMMENT>
    <REVISIONID>-1</REVISIONID>
    <REVIEWID>43381</REVIEWID>
    <LOCATION>-1</LOCATION>
  </REVIEWCOMMENT>
  <REVIEWCOMMENT>
    <ID>43401</ID>
    <OWNER>snoff4@icloud.com</OWNER>
    <DATE>2026-02-17T15:15:23+02:00</DATE>
    <COMMENT>[requested-review-from-theo.muenster@outlook.com]</COMMENT>
    <REVISIONID>-1</REVISIONID>
    <REVIEWID>43381</REVIEWID>
    <LOCATION>-1</LOCATION>
  </REVIEWCOMMENT>
</PLASTICQUERY>`;

	it('parses XML reviewcomment output', async () => {
		mockExecCm.mockResolvedValue({ stdout: xmlOutput, stderr: '', exitCode: 0 });

		const comments = await backend.getReviewComments(43381);
		expect(comments.length).toBeGreaterThanOrEqual(2);
		// Regular comment
		const inline = comments.find(c => c.id === 43386);
		expect(inline).toBeDefined();
		expect(inline!.text).toBe('Any reason to keep these comments?');
		expect(inline!.type).toBe('Comment');
		expect(inline!.locationSpec).toBe('42939#37');
	});

	it('maps system comments to correct types', async () => {
		mockExecCm.mockResolvedValue({ stdout: xmlOutput, stderr: '', exitCode: 0 });

		const comments = await backend.getReviewComments(43381);
		const statusComment = comments.find(c => c.id === 43400);
		expect(statusComment).toBeDefined();
		expect(statusComment!.type).toBe('StatusReworkRequired');
		expect(statusComment!.text).toBe('Apply the feedback.');
	});

	it('filters out reviewer-request system events', async () => {
		mockExecCm.mockResolvedValue({ stdout: xmlOutput, stderr: '', exitCode: 0 });

		const comments = await backend.getReviewComments(43381);
		const requestEvents = comments.filter(c => c.text.includes('[requested-review-from'));
		expect(requestEvents).toHaveLength(0);
	});

	it('passes reviewid in where clause', async () => {
		mockExecCm.mockResolvedValue({ stdout: '<?xml version="1.0" encoding="utf-8" ?>\n<PLASTICQUERY></PLASTICQUERY>', stderr: '', exitCode: 0 });
		await backend.getReviewComments(43381);
		expect(mockExecCm).toHaveBeenCalledWith(
			expect.arrayContaining(['where reviewid=43381']),
		);
	});

	it('handles empty result', async () => {
		mockExecCm.mockResolvedValue({
			stdout: '<?xml version="1.0" encoding="utf-8" ?>\n<PLASTICQUERY></PLASTICQUERY>',
			stderr: '',
			exitCode: 0,
		});
		const comments = await backend.getReviewComments(99999);
		expect(comments).toEqual([]);
	});

	it('handles multiline comment text', async () => {
		const multilineXml = `<?xml version="1.0" encoding="utf-8" ?>
<PLASTICQUERY>
  <REVIEWCOMMENT>
    <ID>50001</ID>
    <OWNER>user@test.com</OWNER>
    <DATE>2026-03-18T10:00:00+02:00</DATE>
    <COMMENT>First line.
Second line.
Third line.</COMMENT>
    <REVISIONID>-1</REVISIONID>
    <REVIEWID>43381</REVIEWID>
    <LOCATION>-1</LOCATION>
  </REVIEWCOMMENT>
</PLASTICQUERY>`;
		mockExecCm.mockResolvedValue({ stdout: multilineXml, stderr: '', exitCode: 0 });
		const comments = await backend.getReviewComments(43381);
		expect(comments[0].text).toBe('First line.\nSecond line.\nThird line.');
	});
});
```

**Step 2: Run tests — expect FAIL**

**Step 3: Implement XML parser and getReviewComments**

Add a lightweight XML parser for the REVIEWCOMMENT elements (no dependency needed — use regex):

```typescript
import type { ReviewCommentType } from './types';

/**
 * Parse cm find reviewcomment --xml output.
 * Uses regex extraction — no XML library dependency needed since the
 * output is simple, well-structured XML from the cm CLI.
 */
function parseReviewCommentXml(xml: string): ReviewCommentInfo[] {
	const comments: ReviewCommentInfo[] = [];
	const blockRegex = /<REVIEWCOMMENT>([\s\S]*?)<\/REVIEWCOMMENT>/g;
	let match;
	while ((match = blockRegex.exec(xml)) !== null) {
		const block = match[1];
		const get = (tag: string) => {
			const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
			return m ? m[1] : '';
		};
		const id = parseInt(get('ID'), 10);
		const owner = get('OWNER');
		const date = get('DATE');
		const rawComment = get('COMMENT');
		const revisionId = parseInt(get('REVISIONID'), 10);
		const location = parseInt(get('LOCATION'), 10);

		if (isNaN(id)) continue;

		// Skip reviewer-request system events
		if (rawComment.startsWith('[requested-review-from-')) continue;

		// Detect comment type from prefix
		const { type, text } = classifyComment(rawComment);

		// Build location spec from revisionId + line
		const locationSpec = revisionId > 0 ? `${revisionId}#${location}` : undefined;

		comments.push({
			id,
			owner,
			text,
			type,
			timestamp: date,
			locationSpec,
		});
	}
	return comments;
}

function classifyComment(raw: string): { type: ReviewCommentType; text: string } {
	if (raw.startsWith('[status-reviewed]')) {
		return { type: 'StatusReviewed', text: raw.slice('[status-reviewed]'.length).trim() };
	}
	if (raw.startsWith('[status-rework-required]')) {
		return { type: 'StatusReworkRequired', text: raw.slice('[status-rework-required]'.length).trim() };
	}
	if (raw.startsWith('[status-under-review]')) {
		return { type: 'StatusUnderReview', text: raw.slice('[status-under-review]'.length).trim() };
	}
	if (raw.startsWith('[description]')) {
		return { type: 'Comment', text: raw.slice('[description]'.length).trim() };
	}
	return { type: 'Comment', text: raw };
}
```

Then replace the `getReviewComments` stub:

```typescript
async getReviewComments(reviewId: number): Promise<ReviewCommentInfo[]> {
	const result = await execCm([
		'find', 'reviewcomment',
		`where reviewid=${reviewId}`,
		'--xml',
		'--nototal',
	]);
	if (result.exitCode !== 0) {
		throw new Error(`cm find reviewcomment failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
	}
	return parseReviewCommentXml(result.stdout);
}
```

**Step 4: Run tests — expect PASS**

**Step 5: Commit**

```bash
cd /mnt/c/Github/BetterSCM && git add src/core/backendCli.ts test/unit/core/backendCli.test.ts
git commit -m "feat(cli): implement getReviewComments with XML parsing"
```

---

### Task 6: getReviewers (reconstructed from comments)

**Files:**
- Modify: `src/core/backendCli.ts`
- Test: `test/unit/core/backendCli.test.ts`

**Step 1: Write failing tests**

```typescript
describe('getReviewers', () => {
	it('extracts reviewers from comment events', async () => {
		// getReviewers calls getCodeReview (for assignee) then cm find reviewcomment
		mockExecCm
			// First: getCodeReview
			.mockResolvedValueOnce({
				stdout: '43381#Review#Status Reviewed#owner@test.com#17/02/2026#Changeset#531#theo@test.com\n',
				stderr: '',
				exitCode: 0,
			})
			// Second: cm find reviewcomment --xml
			.mockResolvedValueOnce({
				stdout: `<?xml version="1.0" encoding="utf-8" ?>
<PLASTICQUERY>
  <REVIEWCOMMENT>
    <ID>1</ID><OWNER>owner@test.com</OWNER><DATE>2026-02-17T15:00:00</DATE>
    <COMMENT>[requested-review-from-theo@test.com]</COMMENT>
    <REVISIONID>-1</REVISIONID><REVIEWID>43381</REVIEWID><LOCATION>-1</LOCATION>
  </REVIEWCOMMENT>
  <REVIEWCOMMENT>
    <ID>2</ID><OWNER>owner@test.com</OWNER><DATE>2026-02-17T15:01:00</DATE>
    <COMMENT>[requested-review-from-alice@test.com]</COMMENT>
    <REVISIONID>-1</REVISIONID><REVIEWID>43381</REVIEWID><LOCATION>-1</LOCATION>
  </REVIEWCOMMENT>
  <REVIEWCOMMENT>
    <ID>3</ID><OWNER>theo@test.com</OWNER><DATE>2026-02-18T10:00:00</DATE>
    <COMMENT>[status-reviewed]Looks good.</COMMENT>
    <REVISIONID>-1</REVISIONID><REVIEWID>43381</REVIEWID><LOCATION>-1</LOCATION>
  </REVIEWCOMMENT>
</PLASTICQUERY>`,
				stderr: '',
				exitCode: 0,
			});

		const reviewers = await backend.getReviewers(43381);
		expect(reviewers).toHaveLength(2);
		const theo = reviewers.find(r => r.name === 'theo@test.com');
		expect(theo).toBeDefined();
		expect(theo!.status).toBe('Reviewed');
		const alice = reviewers.find(r => r.name === 'alice@test.com');
		expect(alice).toBeDefined();
		expect(alice!.status).toBe('Under review'); // no status-change comment
	});

	it('returns empty array if no reviewer events', async () => {
		mockExecCm
			.mockResolvedValueOnce({
				stdout: '43381#Review#Status Under review#owner@test.com#17/02/2026#Changeset#531#\n',
				stderr: '',
				exitCode: 0,
			})
			.mockResolvedValueOnce({
				stdout: '<?xml version="1.0" encoding="utf-8" ?>\n<PLASTICQUERY></PLASTICQUERY>',
				stderr: '',
				exitCode: 0,
			});

		const reviewers = await backend.getReviewers(43381);
		expect(reviewers).toEqual([]);
	});
});
```

**Step 2: Run tests — expect FAIL**

**Step 3: Implement getReviewers**

```typescript
async getReviewers(reviewId: number): Promise<ReviewerInfo[]> {
	// Fetch raw comments (including system events) to extract reviewer info
	const result = await execCm([
		'find', 'reviewcomment',
		`where reviewid=${reviewId}`,
		'--xml',
		'--nototal',
	]);
	if (result.exitCode !== 0) {
		throw new Error(`cm find reviewcomment failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
	}

	return extractReviewersFromComments(result.stdout);
}
```

Add the helper:

```typescript
function extractReviewersFromComments(xml: string): ReviewerInfo[] {
	const blockRegex = /<REVIEWCOMMENT>([\s\S]*?)<\/REVIEWCOMMENT>/g;
	const reviewerNames = new Set<string>();
	const latestStatus = new Map<string, ReviewStatus>();

	let match;
	while ((match = blockRegex.exec(xml)) !== null) {
		const block = match[1];
		const get = (tag: string) => {
			const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
			return m ? m[1] : '';
		};
		const owner = get('OWNER');
		const comment = get('COMMENT');

		// Extract reviewer names from request events
		const reqMatch = comment.match(/^\[requested-review-from-(.+)\]$/);
		if (reqMatch) {
			reviewerNames.add(reqMatch[1]);
			continue;
		}

		// Track latest status change per user
		if (comment.startsWith('[status-reviewed]')) {
			latestStatus.set(owner, 'Reviewed');
		} else if (comment.startsWith('[status-rework-required]')) {
			latestStatus.set(owner, 'Rework required');
		} else if (comment.startsWith('[status-under-review]')) {
			latestStatus.set(owner, 'Under review');
		}
	}

	return [...reviewerNames].map(name => ({
		name,
		status: latestStatus.get(name) ?? ('Under review' as ReviewStatus),
		isGroup: false,
	}));
}
```

**Step 4: Run tests — expect PASS**

**Step 5: Commit**

```bash
cd /mnt/c/Github/BetterSCM && git add src/core/backendCli.ts test/unit/core/backendCli.test.ts
git commit -m "feat(cli): implement getReviewers reconstructed from comment events"
```

---

### Task 7: Update remaining stubs with descriptive errors

**Files:**
- Modify: `src/core/backendCli.ts`
- Test: `test/unit/core/backendCli.test.ts`

**Step 1: Write tests for the 4 remaining NotSupportedError methods**

```typescript
describe('unsupported review operations', () => {
	it('addReviewComment throws NotSupportedError with helpful message', async () => {
		await expect(backend.addReviewComment({ reviewId: 1, text: 'test' }))
			.rejects.toThrow('REST API');
	});

	it('addReviewers throws NotSupportedError', async () => {
		await expect(backend.addReviewers(1, ['user@test.com']))
			.rejects.toThrow('REST API');
	});

	it('removeReviewer throws NotSupportedError', async () => {
		await expect(backend.removeReviewer(1, 'user@test.com'))
			.rejects.toThrow('REST API');
	});

	it('updateReviewerStatus throws NotSupportedError', async () => {
		await expect(backend.updateReviewerStatus(1, 'user@test.com', 'Reviewed'))
			.rejects.toThrow('REST API');
	});
});
```

**Step 2: Run tests — expect FAIL (current messages say "cm CLI" not "REST API")**

**Step 3: Update the error messages**

```typescript
async addReviewComment(): Promise<ReviewCommentInfo> {
	throw new NotSupportedError('addReviewComment', 'cm CLI (requires REST API backend for writing review comments)');
}
async addReviewers(): Promise<void> {
	throw new NotSupportedError('addReviewers', 'cm CLI (requires REST API backend for managing reviewers)');
}
async removeReviewer(): Promise<void> {
	throw new NotSupportedError('removeReviewer', 'cm CLI (requires REST API backend for managing reviewers)');
}
async updateReviewerStatus(): Promise<void> {
	throw new NotSupportedError('updateReviewerStatus', 'cm CLI (requires REST API backend for managing reviewers)');
}
```

**Step 4: Run tests — expect PASS**

**Step 5: Run full test suite**

Run: `cd /mnt/c/Github/BetterSCM && npx vitest run --reporter=verbose 2>&1 | tail -30`
Expected: All tests pass

**Step 6: Commit**

```bash
cd /mnt/c/Github/BetterSCM && git add src/core/backendCli.ts test/unit/core/backendCli.test.ts
git commit -m "feat(cli): update unsupported review methods with descriptive REST API error messages"
```

---

Plan complete and saved to `docs/plans/2026-03-18-cli-code-review-parity-impl.md`. Two execution options:

**1. Subagent-Driven (this session)** — I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** — Open new session with executing-plans, batch execution with checkpoints

Which approach?