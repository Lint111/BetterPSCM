# Changelog

## [0.4.0] - 2026-04-07

### Added

- **Clean Stale Changes** SCM command (`bpscm.cleanStale`) — new icon in the SCM title bar that scans the current change list for files reported as `changed`/`checkedOut` whose working copy is byte-identical to the base revision (the Unity reimport "stale CH" pattern). Confirms before reverting, displays the Unity-critical file count, writes a backup, and shows the surviving paths if the revert was incomplete.
- **Integration test tier** under `test/integration/` — opt-in suite that drives a real `cm` binary against a throwaway Plastic workspace. Catches CLI semantics bugs that mocked unit tests cannot see. 14 tests across `undoCheckout`, `destructiveOps` backup creation, `addToSourceControl`, `getStatus` path round-trip, and `checkin` lifecycle. Run via `npm run test:integration`. See `test/integration/README.md` for setup.
- **PlasticContext** — explicit per-workspace context (`{ workspaceRoot, cmPath }`) that replaces module-level cm globals. Both the extension and the standalone MCP server build their own context on startup; integration tests construct isolated `CliBackend` instances per fixture. Enables future multi-workspace support and parallel test execution.
- **Shared destructive-ops layer** (`src/core/destructiveOps.ts`) — `executeDestructiveRevert` orchestrates backup, audit logging, bulk-operation guard, and Unity-critical / reimport classification. Both the UI Clean Stale command and the MCP `bpscm_clean_stale` / `bpscm_undo_checkout` tools route through it, so their safety posture stays in sync.
- **`BetterPanel` base class** for webview panels — extracts the `createWebviewPanel` + `onDidDispose` + `onDidReceiveMessage` + dispose-once boilerplate. `CodeReviewPanel` and `ReviewSnippetPanel` now extend it.
- **WSL ↔ Windows path translation** in `stripWorkspaceRoot` — `cm.exe` always emits Windows-form paths even when run from WSL Node, so the workspace-root comparison now translates `/mnt/c/...` → `c:/...` before stripping the prefix. Fixed a latent bug where `NormalizedChange.path` returned absolute Windows paths from a WSL-driven extension.
- **Webview panel modules** under `src/views/panels/<name>/` — historyGraph and codeReview panels' inline HTML/CSS/JS extracted into sibling `styles.ts` and `client.ts` files. `historyGraphPanel.ts` dropped from 1176 → 899 lines.

### Fixed

- **`cm undocheckout -a` flag** — `CliBackend.undoCheckout` did not pass `-a` to `cm undocheckout`, which made the call a silent no-op on locally-modified (CH) files. Plastic only handles CO state by default; the `-a` flag is required to also revert CH content. This bug was masking failures in `bpscm_clean_stale`, `bpscm_undo_checkout`, and `branchSwitch "Shelve"` / `"Discard"` for any locally-modified file. Diagnosed by adding stdout/stderr surfacing to the wrapper, then verified directly against `cm.exe`.
- **`undoCheckout` empty-paths guard** — passing `[]` would invoke `cm undocheckout -a --silent` with no items. Plastic's behavior for that combination is undocumented; defending now via an early-return matches the existing pattern in `addToSourceControl` and `removeFromSourceControl`.
- **Backup directory traversal hardening** — `sanitizeWorkspaceName` (now `sanitizePathComponent`) only stripped `<>:"/\|?* `, NOT `..`. The `tool` parameter from `executeDestructiveRevert` had no sanitization at all. Both flow into backup directory paths via `path.join`, which resolves `..` as parent traversal. Not currently attacker-reachable (internal callers hardcode tool names) but defense-in-depth: now strips `..` sequences and forces single-component names via `path.basename`.
- **`isFileStale` bare `catch {}`** in `staleDetection.ts` — silently swallowed all errors including programming bugs. Now logs the error before returning the safe default so genuine failures surface in the output channel.
- **`hashFile` stream cleanup** — explicitly calls `stream.destroy()` in the error handler to guarantee file descriptor release on error paths.
- **`createPlasticContext` validation** — throws on empty `workspaceRoot` or `cmPath` instead of constructing a context that crashes later at spawn time.
- **`cleanStale` O(n×m) lookup** — change-type lookup now uses a precomputed `Set` instead of `Array.includes()` inside the loop. Trivial today; cliff for future scale.
- **Integration fixture cleanup** — the `afterEach` hook now reverts AD records on the auto-added parent directory of newly-added scratch files, not just the file records themselves. Without this, `rmSync` would leave `AD+LD` orphan records in cm status that accumulated across runs.
- **`writeScratch` path-traversal guard** — the integration fixture's scratch-file helper now verifies the resolved path stays inside the per-test scratch directory.
- **`BetterPanel` registry-leak regression** — the first draft only ran `onPanelDispose` from the `onDidDispose` listener. Direct `instance.dispose()` calls (e.g., from a parent disposable container) bypassed the cleanup, leaking entries from subclass static registries. Caught in pre-commit audit before landing.

### Refactored

- **Production migration to PlasticContext** — `extension.ts` and `mcp/server.ts` build their own `PlasticContext` on startup and pass it to `new CliBackend(ctx)`. The dead `setCmWorkspaceRoot` calls are removed; the symbol is retained only for unit-test mocks. `CliBackend`'s 37 internal `execCm` call sites all route through instance methods that pick the context-aware variant when present.
- **MCP `bpscm_clean_stale` / `bpscm_undo_checkout`** — destructive phase delegated to the shared `executeDestructiveRevert`. Tool-specific concerns (CO/CH breakdown reporting, dry-run mode, bulk threshold messaging) stay in the tool handler; backup, audit, and Unity classification move to the shared layer. ~80 lines of MCP-only logic eliminated.
- **`src/mcp/backup.ts` → `src/core/backup.ts`** — was already framework-free, just lived in the wrong directory. Single source of truth for backup creation, listing, and restore.
- **Webview HTML/CSS/JS extraction** — `historyGraphPanel.ts` (1176 → 899 lines) and `codeReviewPanel.ts` (298 → 215 lines) no longer drown in concatenated template literals. The dynamic interpolation stays inline; the static blocks are imported as string constants from sibling files.

### Tests

- Unit test count: 384 → 465 (+81). New test files cover `staleDetection`, `destructiveOps` (21), `context`, `path`, `betterPanel` (9), and the new path-traversal regressions in `backup`.
- Integration test count: 0 → 14 (new tier).
- All tests verified against the local `testEnviroment` Plastic workspace.

## [0.3.0] - 2026-04-06

### Fixed
- `bpscm_file_history`: `cm history --format` rejected `{changeset}`/`{type}` — use `{changesetid}` and drop the (unavailable) type field
- `bpscm_annotate`: parser never matched cm's padded default output — switch to an explicit `--format` with a unit-separator delimiter, correctly populating changeset IDs, authors, and line numbers
- `bpscm_branches`: was routed to the REST backend and failed with "invalid user api token" for local-only workspaces — route `listBranches` to the CLI backend
- `bpscm_clean_stale`: unconditionally reverted all CO files, which could wipe legitimate in-progress edits (Unity opens scenes/assets as CO before the filesystem watcher promotes real edits to CH). CO files are now SHA-256 compared against the base revision; only byte-identical files are reverted
- `bpscm_get_status(detect_stale=true)`: now content-hashes CO files the same way as CH, so `possiblyStale` reflects real content divergence

### Added
- WSL → Windows path translation at the cm execution boundary. MCP clients running under WSL can now pass `/mnt/c/...` paths to any cm-backed tool (history, annotate, diff, etc.); they are rewritten to `C:\...` before handoff to `cm.exe`.

## [0.2.0] - 2026-03-25

### Added
- Moved file diff titles showing old → new filename
- Stale CH file detection via SHA-256 content comparison in MCP clean_stale
- IPC notifications from MCP server to refresh SCM panel on mutations
- CLI-first hybrid fallback for changeset diffs and listings

### Fixed
- Operator precedence bug in cm CLI killed/SIGTERM error handling
- Checkin now allows checkedOut files through filter (external tool edits)
- Robust checkin retry with broader cm rejection pattern matching
- Quick diff fetches base content from sourcePath for moved files
- REST backend propagates diff errors instead of silently returning empty

## [0.1.0] - 2026-03-13

### Added
- Git-like staging with "Staged Changes" and "Changes" resource groups
- Quick diff with inline gutter decorations
- Revert individual file changes
- Branch explorer with create, switch, and delete
- Status bar showing current branch
- Interactive SVG history graph with branch lines
- File history and annotate (blame) views
- Code review lifecycle — create, comment, change status, manage reviewers
- Threaded review comments with tree view filtering
- Merge branches with conflict preview
- Label management on changesets
- Lock rule management (create, list, delete)
- Lock release for file locks
- Workspace auto-detection from `.plastic/` folder
- Workspace update with conflict handling
- SSO auto-login via Unity Plastic desktop client tokens
- MCP server with 14 tools, 3 resources, and 2 prompts
- Standalone MCP mode: `node dist/mcp-server.js --workspace /path`
- Dual backend: REST API (primary) with cm CLI fallback
