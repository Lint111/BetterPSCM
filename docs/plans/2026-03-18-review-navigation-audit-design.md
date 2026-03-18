# Code Review Navigation & Audit Export — Design

## Goal

Add inline code review comment navigation to the VS Code extension: link comments to specific lines, show truncated code snippets, provide next/back traversal across commented files, and export an audit-ready Markdown issue log.

## Background

Review comments from `cm find reviewcomment` include `REVISIONID` (Plastic revision ID) and `LOCATION` (line number). Currently these are stored as `locationSpec: "revisionId#lineNumber"` but not resolved to file paths. The CLI supports batch resolution via a single query:

```bash
cm find revision where id=A or id=B or id=C --format={item}#{id} --nototal
```

This returns file paths for all revision IDs in one round-trip. Combined with `cm cat revid:N --raw` for file content, we have everything needed to link comments to code.

## Architecture

Three new components triggered when a review is opened:

### 1. Review Comments Tree View (sidebar)

A VS Code TreeView grouped by file:

```
📁 Assets/Scripts/Foo.cs (3 comments)
  💬 line 37: "Any reason to keep these comments?" — theo
  💬 line 52: "This null check is redundant" — maria
  ❓ line 89: "Should this handle the edge case?" — alex
📁 Assets/Scripts/Bar.cs (1 comment)
  💬 line 12: "Consider using StringBuilder" — theo
```

Clicking a comment opens a **truncated code snippet view** — a read-only webview showing ±5 lines around the commented line, with:
- Highlighted target line
- Comment text displayed below the snippet
- "Show More" button to expand context (±15, ±30 lines)
- "Go to File" button to open the full file at that line in the editor

### 2. Inline Decorations + Navigation (editor)

When a reviewed file is open in the editor:
- **Gutter icons** on commented lines (speech bubble icon)
- **Background highlight** (subtle yellow/orange tint) on commented lines
- **Hover provider** shows comment text + author on hover
- **Next/Back commands** (`plasticScm.nextReviewComment` / `plasticScm.prevReviewComment`) to traverse all comments across all files in the review, opening files as needed
- **Status bar item** showing position: "Review Comment 3/12"

Navigation order: sorted by file path, then by line number within each file.

### 3. Audit Export (command)

`plasticScm.exportReviewAudit` command generates a Markdown file:

```markdown
# Code Review Audit: Review #43381 — "Refactor unit config tool"

**Status:** Rework required | **Owner:** theo@outlook.com | **Date:** 2026-02-17

---

## Assets/Scripts/EditorOnly/CreationTools/UnitConfigToolEditorWindow.cs

### Line 37 — Comment by theo@outlook.com (2026-02-17 15:15)

```csharp
    35 |     if (string.IsNullOrWhiteSpace(outputPath))
    36 |         throw new ArgumentException("Output path cannot be empty");
 >> 37 |     // TODO: validate file extension
    38 |     if (filenameNoExtension.EndsWith(FILE_EXTENSTION)) {
    39 |         filenameNoExtension = filenameNoExtension[..^7];
```

> Any reason to keep these comments?

---
```

Saves to workspace root as `review-audit-{reviewId}.md`.

## Data Flow

```
Open Review
  → getReviewComments(reviewId)
  → collect unique revisionIds from comments with locationSpec
  → single CLI call: cm find revision where id=A or id=B or ... --format={item}#{id} --nototal
  → parse result → Map<revisionId, filePath>
  → enrich each comment: filePath + lineNumber from locationSpec + resolution map
  → populate ReviewCommentsTreeProvider
  → register ReviewDecorationProvider for open editors
  → initialize ReviewNavigationController with sorted comment list

On snippet click:
  → cm cat revid:N --raw → full file text
  → slice to [line-5 .. line+5]
  → render in webview with highlight + comment

On next/back:
  → NavigationController advances/retreats index
  → if different file: open file in editor
  → reveal line, update status bar

On export:
  → for each file with comments: cm cat revid:N → extract context lines
  → render Markdown template
  → write to workspace root
```

## New Backend Methods

### `resolveRevisionPaths(revisionIds: number[]): Promise<Map<number, string>>`

Builds dynamic `or` chain:
```
cm find revision where id=123 or id=456 or id=789 --format={item}#{id} --nototal
```

Parses `path#id` lines into a Map. Handles:
- Chunking if revision list exceeds reasonable command-line length (~50 IDs per call)
- Path normalization (Windows paths → workspace-relative)

### `getFileAtRevision(revisionId: number): Promise<string>`

```
cm cat revid:N --raw
```

Returns full file text. Already partially implemented via `getFileContent()` in CLI backend — extend to accept `revid:N` format directly.

## New Files

| File | Purpose |
|------|---------|
| `src/views/reviewCommentsTreeProvider.ts` | TreeView grouping comments by file |
| `src/views/reviewSnippetPanel.ts` | Webview showing truncated code + comment |
| `src/providers/reviewDecorationProvider.ts` | Gutter icons + line highlights + hover |
| `src/providers/reviewNavigationController.ts` | Next/back state machine, status bar |
| `src/commands/reviewAuditExport.ts` | Markdown audit generation |

## Modified Files

| File | Change |
|------|--------|
| `src/core/backendCli.ts` | Add `resolveRevisionPaths()`, extend `getFileContent()` for `revid:N` |
| `src/core/backend.ts` | Add `resolveRevisionPaths()` to interface |
| `src/core/backendRest.ts` | Stub or REST implementation for `resolveRevisionPaths()` |
| `src/core/types.ts` | Add `ResolvedComment` type (comment + filePath + lineNumber) |
| `src/views/codeReviewPanel.ts` | Trigger comment resolution on review open |
| `src/commands/codeReview.ts` | Register new commands |
| `src/constants.ts` | Add new command IDs |
| `package.json` | Register commands, tree view, menus, keybindings |

## Testing

- Unit tests for `resolveRevisionPaths` parsing (mocked `execCm`)
- Unit tests for comment enrichment (locationSpec → filePath + line)
- Unit tests for audit Markdown generation (snapshot-style)
- Unit tests for navigation controller (next/back/wrap-around)
- Integration smoke test against Divine Ambition workspace (manual)
