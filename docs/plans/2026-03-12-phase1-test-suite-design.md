# Phase 1 Test Suite Design

## Problem

Phase 1 has zero tests. The backend interface refactor introduced `CliBackend`, `RestBackend`, and a facade layer — all untested. Before Phase 2 adds diffs and branches, we need a green test baseline to catch regressions.

## Decision

**Vitest + manual VS Code mocks.** Vitest is already referenced in `package.json`. Tests run in plain Node (no extension host). A hand-written `vscode` mock module covers the small subset of VS Code APIs the extension uses.

## Infrastructure

**Framework:** Vitest (`npm install -D vitest`)

**Config:** `vitest.config.ts` at project root:
- Alias `vscode` → `test/mocks/vscode.ts`
- Include `test/**/*.test.ts`

**Test tsconfig:** `test/tsconfig.json` extending root, adding `test/` to includes, relaxing `rootDir`.

**Directory structure:**
```
test/
  mocks/
    vscode.ts
  unit/
    core/
      backendCli.test.ts
      backendRest.test.ts
      backend.test.ts
      types.test.ts
      workspace.test.ts
    scm/
      stagingManager.test.ts
      plasticScmProvider.test.ts
      decorations.test.ts
      resourceStateFactory.test.ts
    commands/
      checkin.test.ts
    statusBar/
      plasticStatusBar.test.ts
    util/
      config.test.ts
      plasticDetector.test.ts
      uri.test.ts
      polling.test.ts
```

## Mocking Strategy

### cm CLI (`CliBackend` tests)

Stub `execCm` via `vi.mock`. Each test sets `vi.mocked(execCm).mockResolvedValue({ stdout, stderr, exitCode })`. Tests exercise the parsing and error-handling logic in `CliBackend` without spawning processes.

### REST API (`RestBackend` tests)

Mock `getClient()` from `api/client` to return a fake with `.GET()` / `.POST()` returning canned `{ data, error }`. Tests verify response mapping to `StatusResult`/`CheckinResult`.

### VS Code API

`test/mocks/vscode.ts` exports stubs for the specific APIs used:

- `Uri.file(path)` / `Uri.parse(str)` — Plain objects with `fsPath`, `scheme`, `path`
- `EventEmitter` — Real class with `event`, `fire()`, `dispose()`
- `workspace.getConfiguration()` — `get(key, default)` backed by plain object
- `scm.createSourceControl()` — Object with `inputBox`, `createResourceGroup()`, `dispose()`
- `window.showInformationMessage` / `showWarningMessage` / `showErrorMessage` / `showInputBox` / `withProgress` — `vi.fn()` spies
- `commands.registerCommand` — `vi.fn()` spy
- `ProgressLocation.SourceControl`, `ConfigurationTarget.Workspace` — Enum constants

## Test Coverage

### Core layer (no VS Code mocks)

**`backendCli.test.ts`** — Largest file:
- `getStatus`: parses machine-readable output, filters private files, handles empty workspace, throws on non-zero exit
- `getCurrentBranch`: parses `BR <branch>` format, returns undefined for missing, throws on failure
- `checkin`: parses `cs:N`, throws when unparseable, throws on non-zero exit
- `getFileContent`: returns Uint8Array on success, undefined on non-zero exit

**`backendRest.test.ts`** — Tests REST delegation and response mapping. Lighter coverage (REST backend not currently usable due to org provisioning).

**`backend.test.ts`** — Singleton: setBackend/getBackend/hasBackend, throws when no backend.

**`types.test.ts`** — `normalizeChange` mapping, `NotSupportedError` message format.

**`workspace.test.ts`** — Facade delegates to `getBackend()`.

### SCM layer (VS Code mocks)

**`stagingManager.test.ts`** — Stage/unstage paths, `splitChanges` partitioning, `unstageAll`, persistence via `workspaceState`.

**`plasticScmProvider.test.ts`** — Resource groups from status, polling refresh, input box.

**`decorations.test.ts`** — Change type to decoration mapping (color, letter).

**`resourceStateFactory.test.ts`** — `NormalizedChange` to `SourceControlResourceState` mapping.

### Commands/StatusBar (VS Code mocks)

**`checkin.test.ts`** — Happy path, empty paths warning, no comment cancels, error message.

**`plasticStatusBar.test.ts`** — Shows branch name, updates on refresh.

### Util (mixed)

**`config.test.ts`** — `getConfig` reads settings, `isConfigured` with/without REST/CLI.

**`plasticDetector.test.ts`** — `detectWorkspace` parses `.plastic/plastic.selector`, `resolveOrgSlug` from `unityorgs.conf`. Filesystem stubs.

**`uri.test.ts`** — `parsePlasticUri` round-trips.

**`polling.test.ts`** — Timer fires at interval, stops on dispose.
