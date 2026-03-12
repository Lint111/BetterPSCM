# Phase 2: Diffs + Branch Detection — Design

**Goal:** Make the SCM panel interactive — clicking a changed file shows useful content — and keep branch display in sync with the actual Plastic workspace.

**Architecture:** Extend the existing SCM resource states to carry full change metadata, dispatch click behavior by change type, and piggyback branch polling on the existing status polling loop.

**Tech Stack:** VS Code SCM API (`vscode.diff`, `TextDocumentContentProvider`), existing `PlasticBackend` interface, `cm cat` CLI command.

---

## 1. Click-to-View Behavior

| changeType | Click behavior |
|---|---|
| `added`, `private` | Open the file directly |
| `changed`, `checkedOut`, `replaced` | Side-by-side diff: base revision vs working copy |
| `moved`, `copied` | Side-by-side diff: old path content vs new content |
| `deleted`, `locallyDeleted` | No click command (already handled) |

### Implementation

- `resourceStateFactory.ts` passes the full `NormalizedChange` in command arguments (not just URI)
- `openChange` command in `general.ts` reads `changeType` and dispatches:
  - Added/private → `vscode.window.showTextDocument(uri)`
  - Modified → `vscode.commands.executeCommand('vscode.diff', originalUri, workingUri, title)`
- Original content is served by `PlasticContentProvider` (already implemented)

### Original Content Resolution

- **REST backend:** `revisionGuid` is already populated on `NormalizedChange` from the status response. Build a `plastic:` URI and `PlasticContentProvider` fetches via the content endpoint.
- **CLI backend:** `cm status --machinereadable` does not include revision GUIDs. Use `cm cat serverpath:/{path}` to get the last checked-in version without needing a GUID. The `revSpec` passed to `getFileContent()` is the server path string.

### QuickDiffProvider

`provideOriginalResource()` maps a workspace file URI to a `plastic:` URI by looking up the file's `NormalizedChange` (via a path→change map on the provider). Returns `undefined` for added/private files (no original).

## 2. Diff Editor "Go to File" Button

Register `plasticScm.openFile` in the `editor/title` menu group in `package.json`, scoped to the Plastic SCM diff editor context. This adds a toolbar icon to jump from the diff view to the full file.

## 3. Branch Change Detection

**Problem:** `PlasticStatusBar.updateBranch()` only runs once at startup. Branch switches via `cm switch` or the Plastic GUI are never detected.

**Fix:** Poll the branch alongside status in `PlasticScmProvider.pollStatus()`:
- Call `getCurrentBranch()` each poll cycle
- Compare against cached branch name
- If changed, fire `onDidChangeBranch` event
- `PlasticStatusBar` subscribes and updates display

This adds one lightweight API call per poll cycle (`cm wi` or REST workspace GET). No extra timer needed.

## 4. Binary File Detection

Check `dataType` on the `NormalizedChange`. If the file is not a text file (binary/image), clicking opens the file directly instead of attempting a diff. For now, all `File` dataTypes attempt diff — binary detection can use a simple extension-based heuristic if needed.

## Files Changed

| File | Change |
|---|---|
| `src/scm/resourceStateFactory.ts` | Pass full `NormalizedChange` in command arguments |
| `src/commands/general.ts` | `openChange` dispatches by changeType (open file vs diff) |
| `src/scm/quickDiffProvider.ts` | Implement `provideOriginalResource()` with change map |
| `src/scm/plasticScmProvider.ts` | Poll branch in `pollStatus()`, expose change map + `onDidChangeBranch` |
| `src/statusBar/plasticStatusBar.ts` | Subscribe to `onDidChangeBranch` |
| `package.json` | Add `openFile` to diff editor title menu |
