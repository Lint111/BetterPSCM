# CLI Code Review Parity — Design

## Goal

Implement code review operations in the CLI backend (`backendCli.ts`) so the standalone MCP server has full read access and core write access to Plastic SCM code reviews without requiring REST API authentication.

## Background

The MCP server uses the CLI backend exclusively. Currently all 11 code review methods throw `NotSupportedError`. Research into the `cm` CLI revealed:

- **`cm find review`** — documented query command for reviews
- **`cm find reviewcomment`** — undocumented but fully functional query for review comments (not listed in `cm showfindobjects` but works in practice)
- **`cm codereview`** — CRUD for reviews with `--status` and `--assignee` flags
- **No CLI support** for writing comments or managing multiple reviewers

## CLI Capability Matrix

| Backend Method | CLI Command | Status |
|---|---|---|
| `listCodeReviews(filter?)` | `cm find review "where ..." --format=...` | Implementable |
| `getCodeReview(id)` | `cm find review "where id=N" --format=...` | Implementable |
| `createCodeReview(params)` | `cm codereview <spec> <title> --assignee=... --status=...` | Implementable |
| `deleteCodeReview(id)` | `cm codereview -d <id>` | Implementable |
| `updateCodeReviewStatus(id, status)` | `cm codereview -e <id> --status=...` | Implementable |
| `getReviewComments(reviewId)` | `cm find reviewcomment "where reviewid=N" --format=...` | Implementable |
| `addReviewComment(params)` | — | Not available in CLI |
| `getReviewers(reviewId)` | Partial: `assignee` field on review only | See approach below |
| `addReviewers(reviewId, reviewers[])` | Partial: `--assignee` on create/edit (single user) | See approach below |
| `removeReviewer(reviewId, reviewer)` | — | Not available in CLI |
| `updateReviewerStatus(reviewId, ...)` | — | Not available in CLI |

## CLI Field Reference

### `cm find review` fields (documented)

Format: `--format={id}#{title}#{status}#{owner}#{date}#{targettype}#{target}#{assignee}`

- `id` — review integer ID
- `title` — review title string
- `status` — prefixed with "Status " (e.g., "Status Reviewed") — must strip prefix
- `owner` — creator email
- `date` — creation date (locale-dependent format)
- `targettype` — "Branch" or "Changeset"
- `target` — branch spec or changeset ID
- `assignee` — assigned reviewer email

Query conditions: `status`, `assignee`, `title`, `target`, `targetid`, `targettype`, `date`, `owner`, `GUID`, `ID`

Sort: `date`, `modifieddate`, `status`

### `cm find reviewcomment` fields (undocumented)

Discovered via `--xml` output. Format: `--format={id}#{owner}#{date}#{comment}#{revisionid}#{reviewid}#{location}`

- `id` — comment integer ID
- `owner` — author email
- `date` — timestamp
- `comment` — full comment text (may contain newlines, special prefixes)
- `revisionid` — target revision (-1 = general/non-inline comment)
- `reviewid` — parent review ID
- `location` — line number in file (-1 = general comment)

### `cm codereview` operations

- **Create**: `cm codereview <spec> <title> [--status=<s>] [--assignee=<u>] [--format={id}]`
  - `<spec>`: `cs:<id>`, `br:<branchSpec>`, or `sh:<shelveSpec>`
  - Returns ID when `--format={id}` used
- **Edit**: `cm codereview -e <id> [--status=<s>] [--assignee=<u>]`
- **Delete**: `cm codereview -d <id> [<id2> ...]`

### Comment type detection

Review comments include system events as text prefixes:
- `[description]...` — review description (first comment)
- `[requested-review-from-<user>]` — reviewer assignment event
- `[status-reviewed]` / `[status-rework-required]` — status change events

These should be mapped to `ReviewCommentType` values and filtered appropriately.

## Approach

### 7 methods fully implemented via CLI

1. **`listCodeReviews`** — `cm find review` with filter-to-where-clause mapping:
   - `all` → no where clause
   - `assignedToMe` → `where assignee = 'me'`
   - `createdByMe` → `where owner = 'me'`
   - `pending` → `where status = 'Under review'`

2. **`getCodeReview`** — `cm find review "where id=N"` returning single result

3. **`createCodeReview`** — `cm codereview <spec> <title>` with optional `--assignee` and `--status`, returns created review via `--format={id}` then fetches full object

4. **`deleteCodeReview`** — `cm codereview -d <id>`

5. **`updateCodeReviewStatus`** — `cm codereview -e <id> --status=<s>`

6. **`getReviewComments`** — `cm find reviewcomment "where reviewid=N"` with:
   - System event comments (`[requested-review-from-...]`, `[status-...]`) mapped to appropriate `ReviewCommentType`
   - Description prefix `[description]` mapped to `'Comment'` type
   - `revisionid` + `location` mapped to `itemName` + `locationSpec`
   - Multi-line comments handled (use `--xml` output for reliable parsing)

7. **`getReviewers`** — Extract from review comments: parse `[requested-review-from-<user>]` entries to build reviewer list, cross-reference with `assignee` field. Reviewer status derived from status-change comments by that user.

### 4 methods remain as NotSupportedError

- `addReviewComment` — no CLI write support for comments
- `addReviewers` — only `--assignee` (single), not multi-reviewer; keep as not-supported since partial support would be misleading
- `removeReviewer` — no CLI command
- `updateReviewerStatus` — no CLI command

Error messages updated to explain: `"addReviewComment requires the REST API backend (no CLI support for writing review comments)"`

### XML parsing for reviewcomment

Comment text can contain `#` and newlines, making delimiter-based parsing unreliable. Use `--xml` output for `reviewcomment` queries:

```xml
<REVIEWCOMMENT>
  <ID>43386</ID>
  <OWNER>theo.muenster@outlook.com</OWNER>
  <DATE>2026-02-17T15:15:32+02:00</DATE>
  <COMMENT>Any reason to keep these comments?</COMMENT>
  <REVISIONID>42939</REVISIONID>
  <REVIEWID>43381</REVIEWID>
  <LOCATION>37</LOCATION>
</REVIEWCOMMENT>
```

For `review` queries, delimiter-based `--format` is safe since review titles don't contain the separator.

### Target spec construction

`createCodeReview` needs a spec string from `CreateReviewParams`:
- `targetType: 'Branch'` + `targetSpec` → `br:<targetSpec>`
- `targetType: 'Branch'` + `targetId` (no spec) → `br:id:<targetId>`
- `targetType: 'Changeset'` + `targetId` → `cs:<targetId>`

### Reviewer list reconstruction

Since `cm find reviewer` doesn't exist, reconstruct from comments:
1. Query `cm find reviewcomment "where reviewid=N" --xml`
2. Extract `[requested-review-from-<user>]` entries → reviewer names
3. For each reviewer, find their latest status comment (`[status-reviewed]`, `[status-rework-required]`) → reviewer status
4. Combine with `assignee` field from the review itself
5. `isGroup` always `false` (CLI has no group info)

## Testing

- Unit tests with mocked `execCm` (same pattern as existing CLI backend tests)
- Parser tests for `cm find review` output (delimiter-based)
- Parser tests for `cm find reviewcomment` XML output
- Parser tests for comment type detection (system event prefixes)
- Integration smoke test against Divine Ambition workspace (manual)

## Files Modified

- `src/core/backendCli.ts` — Replace 11 NotSupportedError stubs with implementations
- `test/unit/core/backendCli.review.test.ts` — New test file for review parsing + methods
