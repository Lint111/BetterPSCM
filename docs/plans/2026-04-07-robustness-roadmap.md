# BetterPSCM Robustness Roadmap

**Date:** 2026-04-07
**Status:** Planning → In Progress
**Context:** Post-Clean-Stale feature, post-March-20 audit follow-through

## Motivation

The March 20 audit turned over 43 findings (4 critical, 18 major, 14 minor, 7 info). Git log shows 42 commits in the following two weeks addressing 24+ of them — criticals fully closed, majority of majors cleaned up, most minors touched. The project is in a good state.

But today's `cm undocheckout -a` bug — a silent no-op on CH files that broke `bpscm_clean_stale`, `bpscm_undo_checkout`, `branchSwitch "Shelve"`, and `branchSwitch "Discard"` simultaneously — survived a 34-file test suite, multiple contributors, and a 4-specialist audit. That's a signal: the next class of robustness improvement is not more polish on code we understand, it's closing the seam where BetterPSCM meets the outside world (the `cm.exe` binary, VS Code webviews, module-level state).

This document captures the four remaining gaps and the plan to close them.

---

## Gap 1: No Integration Test Tier Against Real `cm` Binary

### Problem

Every existing test mocks `execCm` / `execCmToFile` / the entire `CliBackend`. There is no tier that drives a real `cm.exe` against a real Plastic workspace. This means:

- Flag semantics bugs like `-a` are invisible until a user reports "the button does nothing"
- Output format changes across Plastic versions (the existing audit notes "cm status compound types: `AD LD`", "Merge info field is `NO_MERGES` not `NO_MERGE`" — these were all discovered the hard way from user reports, not tests)
- Path format issues (forward vs backslash, absolute vs relative, WSL `/mnt/c/` translation) only get tested ad-hoc
- Concurrency bugs between multiple cm processes racing on the same workspace go unverified

### Why It Matters

Today's `-a` bug is evidence. It broke four callers silently. A single integration test (`cleanStale on a workspace with one stale CH file → assert cm status does not contain that file`) would have caught it in seconds. Without this tier, every `cm` flag change, every path format assumption, and every binary-version difference is a latent bug waiting for a user to find.

### Proposed Approach

**Scaffold a throwaway Plastic workspace fixture in `test/integration/`:**

1. **Fixture bootstrap**: A helper that, given an empty temp directory, creates a local Plastic repository (`cm repository create`) and a workspace bound to it. Populated with a handful of seed files. Torn down in `afterAll`.
2. **Scoped `CliBackend` instance**: Constructed against the fixture workspace (not the global module-level one). This requires either (a) making `CliBackend` constructible without the global `setCmWorkspaceRoot`, or (b) a per-test `withWorkspace(root, fn)` helper that saves/restores the module state.
3. **Gating**: Integration tests live in `test/integration/` with their own vitest project config, excluded from the default `npx vitest run` (because they need cm.exe on PATH and take seconds each). Enabled via `npm run test:integration` or CI env var.
4. **Minimum coverage on day one**:
   - `undoCheckout` — reverts CH files (regression test for today's bug)
   - `undoCheckout` — reverts CO files (the original pre-`-a` behavior, still expected)
   - `undoCheckout` — empty paths returns `[]` without invoking cm (regression for MAJ-1)
   - `cleanStale` flow — modify a file, restore its base bytes, confirm stale detection + revert → file disappears from status
   - `checkin` — commit a file, confirm revision appears
   - `addToSourceControl` — private file → added status
   - `getStatus` — round-trip path format (ensures forward/backslash translation works)

### Success Criteria

- `npm run test:integration` creates a throwaway workspace, runs 7+ tests, cleans up, passes
- The -a regression test fails against the pre-fix codebase and passes against current main
- CI config (future) can opt in via env var without breaking default unit test runs
- A section in `CLAUDE.md` documents how to run integration tests locally

### Dependencies

None. Can be built first. Actually *should* be built first, because it becomes the safety net for gaps 2–4.

---

## Gap 2: UI Destructive Commands Lack the Safety Infrastructure the MCP Tools Have

### Problem

The MCP `bpscm_clean_stale` tool wraps reverts in:
- `createBackup()` — copies pre-revert working copies into a timestamped backup directory
- `dry_run=true` default — preview mode is the safe default, destructive requires explicit opt-out
- `BULK_OPERATION_THRESHOLD` block — >20 files requires `confirm_bulk=true`
- Unity-critical extension flagging — warns when `.meta`, `.unity`, `.prefab`, `.asset`, `.asmdef`, `.asmref` are about to be reverted
- Audit logging to stderr — timestamped JSON entries for every destructive action

The new UI `cleanStale` command has a modal confirmation dialog and nothing else. No backup, no audit log, no Unity-critical warning, no bulk guard beyond a text line in the dialog.

This asymmetry is accidental — I built the UI command focused on the feature, not the safety posture. It's also somewhat inverted: the UI is what regular users click daily, and it's the *less* safe path.

### Why It Matters

Today's user workflow is "click Clean Stale, lose 17 files to cm undocheckout, trust that they were truly stale". If the SHA-256 comparison has a bug (e.g., reads the wrong file, handles EOL wrong, race between hash and revert), there's no recovery path. The MCP version has backups; the UI version does not.

### Proposed Approach

**Extract the safety infrastructure to a shared `src/core/destructiveOps.ts` module:**

```typescript
export interface DestructivePrecheck {
  files: string[];
  operation: 'undo' | 'clean_stale' | 'discard';
  bulkThreshold?: number;        // default BULK_OPERATION_THRESHOLD
  unityCriticalWarn?: boolean;   // default true
  backup?: BackupHooks;          // optional backup mechanism
  audit?: (entry: object) => void;
}

export interface DestructivePrecheckResult {
  proceed: boolean;
  criticalFiles: string[];
  bulkWarning: boolean;
  backupPath?: string;
}

export async function prepareDestructiveOp(
  opts: DestructivePrecheck,
): Promise<DestructivePrecheckResult>;
```

- **Backup layer** moves from `src/mcp/backup.ts` into the core module (or becomes an injectable strategy — the MCP server passes its stderr-logging backup, the extension passes a `globalStorage`-based backup via an adapter).
- **Audit logger** becomes an interface; the MCP server implements it with stderr JSON, the extension implements it with the logger's `log(...)`.
- **`cleanStale` UI command** invokes `prepareDestructiveOp` before calling `undoCheckout`. User gets Unity-critical warnings in the confirm dialog, backups are written automatically, audit log captures the action.
- **MCP `bpscm_clean_stale`** is refactored to use the same shared module, reducing duplication.
- **`branchSwitch "Discard"`** likewise gains backup + audit, since it's destructive too.

### Success Criteria

- Clicking "Clean Stale Changes" on a workspace with `.meta`/`.unity`/`.prefab` files shows the critical-file warning in the confirm dialog
- After a revert, a backup directory exists and can be inspected
- MCP `bpscm_clean_stale` and UI `cleanStale` share >80% of their destructive-op code (no duplication)
- Integration test (Gap 1) verifies the backup directory is created

### Dependencies

- Gap 1 (integration tests) should exist first to catch any regression during the extraction.

---

## Gap 3: Webview HTML as Inline String Concatenation (MAJ-15)

### Problem

`src/views/historyGraphPanel.ts` is 1176 lines. Much of it is hundreds of lines of inline HTML, CSS, and JavaScript concatenated as template literals inside TypeScript. Same pattern in `codeReviewPanel.ts` (298 lines) and `reviewSnippetPanel.ts` (188 lines). Adding a new column, tweaking a style, or fixing an XSS requires editing a template literal inside a `.ts` file with no syntax highlighting, no linting, no type checking on the DOM operations.

`src/views/webviewStyles.ts` (180 lines) exists and centralizes some shared CSS variables — that's good, and the foundation to build on. But the markup itself is still inline.

### Why It Matters

- Any contributor (or me, six months from now) who wants to change the graph view has to navigate 1176 lines of mixed language in a single file
- XSS protection is manual (each template interpolation has to remember to call `escapeHtml`)
- No way to unit test the rendering logic separately from the panel wiring
- `MAJ-15` from the March 20 audit is still open with this exact framing

### Proposed Approach

**Two-phase extraction:**

1. **Phase A — Separate files, same patterns**:
   - Move `historyGraphPanel.ts`'s HTML into `src/views/panels/historyGraph/template.html`
   - Move the inline `<script>` into `src/views/panels/historyGraph/client.ts` (bundled separately by esbuild)
   - Move the inline `<style>` into `src/views/panels/historyGraph/styles.css`
   - The panel provider loads these at runtime via `context.asAbsolutePath` and `vscode.Uri.joinPath`. Template is processed with a lightweight `{{placeholder}}` substitution that always calls `escapeHtml` on interpolated values.
   - Repeat for `codeReviewPanel` and `reviewSnippetPanel`.

2. **Phase B — Consistency layer**:
   - A tiny `BetterPanel` base class (or just a `mountPanel(...)` factory) encapsulating the common setup: CSP header, nonce generation, message dispatch, dispose tracking.
   - Every webview panel in the project uses it. Adding a new panel becomes "drop three files + call mountPanel".

### Success Criteria

- `historyGraphPanel.ts` drops from 1176 lines to ~300 lines (wiring + message handling only)
- HTML/CSS/JS each live in files with proper syntax highlighting
- Existing graph behavior unchanged (manual verification + any existing snapshot tests still pass)
- XSS protection is enforced by the template engine, not per-interpolation discipline
- Adding the next webview (e.g., a merge conflict viewer) takes 3 new files, not 1 mega-file

### Dependencies

- Isolated from core — can proceed in parallel with gaps 2 and 4.

---

## Gap 4: Module-Level Singletons Instead of Injected Context (MAJ-9)

### Problem

The core state lives in module-level `let` variables:

- `src/api/client.ts` — `cachedClient`, auth state, etc.
- `src/api/auth.ts` — credential cache, refresh promise
- `src/util/config.ts` — detected workspace config
- `src/core/cmCli.ts` — `cmPath`, `workspaceRoot`, `_activeChildren`
- `src/core/backend.ts` — `activeBackend` (the global backend singleton)

`setBackend(...)`, `setCmWorkspaceRoot(...)`, `getBackend()`, `getClient()` — these globals are the primary wiring mechanism. It works, but it means:

- No two workspaces in the same process (multi-root workspaces, or tests running in parallel)
- The MCP server has to manually re-initialize every singleton on startup
- Unit tests leak state between files unless they remember to reset every module
- The integration test scaffolding from Gap 1 will immediately hit this wall (a fixture workspace can't co-exist with whatever `setCmWorkspaceRoot` was called with last)

### Why It Matters

This is the structural reason future features will feel sticky. Every time you try to add parallelism, testing, or multi-workspace support, the singletons bite. It's also the single biggest reason Gap 1 (integration tests) is harder than it should be.

### Proposed Approach

**Introduce a `PlasticContext` class that owns all the previously-global state:**

```typescript
class PlasticContext {
  readonly workspaceRoot: string;
  readonly cmPath: string;
  readonly backend: PlasticBackend;
  readonly apiClient: ApiClient;
  readonly stagingStore: StagingStore;
  readonly logger: LogChannel;
  // ... etc
}
```

- Every function that currently reads a global becomes a method on `PlasticContext` or takes a `ctx: PlasticContext` parameter.
- `extension.ts` creates one `PlasticContext` per workspace folder and passes it into all command registration.
- `src/mcp/server.ts` creates its own `PlasticContext` independently.
- Tests create throwaway contexts per test.

**Migration strategy** (non-big-bang):
1. Create `PlasticContext` alongside the globals, with all fields wired from the current globals. This is zero-behavior-change.
2. Refactor one module at a time to accept `ctx` instead of reading globals. Start with the leaves (`cmCli.ts`) and work up.
3. Once every reader is migrated, remove the globals and the `set*`/`get*` functions.

### Success Criteria

- Zero `let` module-level state in `src/api/`, `src/util/`, `src/core/`
- `extension.ts` instantiates `PlasticContext` once, passes it to every `registerXxxCommands`
- `src/mcp/server.ts` builds its own context without calling any `set*` globals
- Integration tests can create multiple `PlasticContext` instances in parallel without interference
- `tsc --noEmit` clean, 412+ tests still pass

### Dependencies

- Gap 1 (integration tests) makes this safe by giving us the regression net for the massive structural churn this causes.

---

## Execution Order

Gap interactions:

```
Gap 1 (integration tests)
   │
   ├──> Gap 2 (destructive-ops layer) — validated by integration tests
   │
   └──> Gap 4 (PlasticContext) — refactor safe because integration tests catch regressions

Gap 3 (webview extraction) — isolated, can happen in parallel with any of the above
```

**Recommended order:**

1. **Gap 1 — Integration test tier** (foundational, unblocks everything else)
2. **Gap 2 — Destructive-ops shared layer** (small, safety win, validated by Gap 1)
3. **Gap 4 — PlasticContext** (big structural refactor, needs Gap 1 as safety net)
4. **Gap 3 — Webview extraction** (can run in parallel with any of the above; saved for last to avoid context switching)

Each gap gets its own implementation plan once the preceding one is done and shipping. This doc is the roadmap; the impl plans will be `docs/plans/2026-04-07-gapN-<topic>-impl.md`.

---

## Status Tracking

All four gaps are complete as of 2026-04-07. Shipped in v0.4.0.

| Gap | Status | Commit(s) |
|-----|--------|-----------|
| Gap 1 — Integration test tier | ✅ Complete | `fb091ec`, expanded in `118ab1b` |
| Gap 2 — Destructive-ops layer | ✅ Complete | `ed9810f`, hardened in `15443ab` |
| Gap 3 — Webview extraction | ✅ Complete | `a713ea5`, BetterPanel base class in `2b609b0` |
| Gap 4 — PlasticContext | ✅ Complete | Phase 1: `9413b6d`, Phase 2: `4ed2d8c` |

### What shipped vs what was planned

**Gap 1** — `test/integration/` with `vitest.integration.config.ts`, fixture
helpers, and 14 integration tests across 3 files (undoCheckout regression,
destructiveOps backup creation, cm lifecycle round-trips). The original
plan called for 7+ tests on day one; we delivered 14. The `-a` flag
regression is locked in by the first test.

**Gap 2** — `src/core/destructiveOps.ts` exports `classifyDestructiveFiles`
(pure) and `executeDestructiveRevert` (orchestrates backup + bulk guard +
Unity warning + audit). Both `cleanStale` (UI) and `bpscm_clean_stale` /
`bpscm_undo_checkout` (MCP) now go through it. The `branchSwitch "Discard"`
path is the one remaining caller that has not been migrated — its
existing inline backup logic is intentionally separate because shelve and
discard need different audit semantics; deferred to a later commit if it
ever needs the shared layer's posture.

**Gap 3** — Phase A (per-panel HTML/CSS/JS extraction) shipped in
`a713ea5`. Phase B (BetterPanel base class) shipped in `2b609b0` —
inheriting panels lost their boilerplate constructor + dispose +
listener wiring. Two panels migrated (`CodeReviewPanel`,
`ReviewSnippetPanel`); `historyGraphPanel` deliberately stays out of
scope because it uses `WebviewViewProvider` (sidebar) not
`WebviewPanel` (editor tab).

**Gap 4** — Phase 1 (`9413b6d`) introduced the `PlasticContext`
interface and made `CliBackend` accept it as an optional constructor
arg. Phase 2 (`4ed2d8c`) migrated all production callers — `extension.ts`
and `mcp/server.ts` both build their own context on startup and pass it
through. Module-level `setCmWorkspaceRoot` is now called by zero
production code paths; the symbol is retained only for unit-test mocks.

### Beyond the roadmap

Two improvements were uncovered during the work and shipped alongside:

- **WSL ↔ Windows path translation** in `stripWorkspaceRoot` (`fb091ec`)
  fixed a latent bug where `NormalizedChange.path` would return absolute
  Windows-form paths when the workspace root was stored in WSL form
  (from a Linux Node process). Caught while building the integration
  test fixture.
- **Backup directory traversal hardening** (`15443ab`) — pre-existing
  `sanitizeWorkspaceName` did not strip `..` and the `tool` parameter
  had no sanitization at all. Replaced with `sanitizePathComponent`
  that strips `..` and forces single-component names via
  `path.basename`. Not currently attacker-reachable but defense-in-depth.

### Audit discipline

Every commit went through a chunk-by-chunk audit before landing:

| Commit | Audit findings caught & fixed in-commit |
|---|---|
| `fb091ec` Gap 1 | None — clean first pass |
| `ed9810f` Gap 2 | None |
| `9413b6d` Gap 4 phase 1 | None |
| `a713ea5` Gap 3 phase A | None |
| `15443ab` (post-Clean-Stale) | 1 major (backup traversal) + 6 minors |
| `4ed2d8c` Gap 4 phase 2 | 4 minors (re-probe, dead imports, dead setCmWorkspaceRoot) |
| `118ab1b` Gap 1 expansion | 1 major (cleanup loop missed AD parent dir) |
| `2b609b0` BetterPanel | 2 majors (registry leak via direct dispose, vscode mock html accessor conflict) |

The `fix known issues, never defer` rule applied throughout: every audit
finding was resolved before its commit landed. No deferrals.
