# BetterSCM — Plastic SCM Pro VS Code Extension

## What This Is
A feature-complete VS Code extension for Plastic SCM, replacing the limited official extension. Built on the Plastic SCM REST API (189 endpoints, 218 schemas).

## Implementation Plan
See `docs/implementation-plan.md` for the full phased plan with architecture details.

## Current Status: Phase 3b Complete
- **Phase 1** ✅ Auth (JWT + PAT + SSO), status polling, client-side staging, selective checkin
- **Phase 2** ✅ Click-to-diff, quick diff provider, branch change detection
- **Backend refactor** ✅ `PlasticBackend` interface with `CliBackend` (primary) + `RestBackend` (fallback)
- **Phase 3a** ✅ Branch tree view, create/switch/delete commands
- **Phase 3b** ✅ History graph webview panel with changeset visualization, click-to-diff per file
- **Tests** ✅ 176 unit tests (vitest)
- **Next**: Phase 4 (code reviews) or Phase 5 (labels, merges, history, locks)

### Recent Improvements (Phase 3b session)
- **Caching utilities** — Generic `LruCache` and `TtlCache` classes (`src/util/cache.ts`), used across diff cache, graph cache, branch cache, quick diff cache
- **Centralized CSS** — Shared design tokens and reusable classes (`src/views/webviewStyles.ts`) for consistent webview styling
- **Large file streaming** — `execCmToFile()` in `cmCli.ts` pipes `cm cat` output to temp files via `spawn`, avoiding Node.js maxBuffer crashes on `.unity`/`.prefab`/etc.
- **Diff collapse** — `diffEditor.hideUnchangedRegions.enabled` hides unchanged sections in diff views
- **Cross-hover** — Hovering graph SVG dots highlights commit rows and vice versa
- **Move path parsing** — Handles `M "old\path" "new\path"` format from `cm diff`
- **Parent revision resolution** — Fallback `changeset<=N ... order by desc limit 1` when exact match fails

### Known cm CLI Quirks (handled)
- Compound type codes: `cm status --machinereadable` emits `AD LD` for added-then-locally-deleted files
- Merge info field is `NO_MERGES` (plural), not `NO_MERGE`
- Absolute paths need workspace root stripping (case-insensitive on Windows)
- `cm cat --changeset` not supported in Plastic 11.0.16 — use `cm find revision` → `cm cat revid:N`
- `cm find revision` uses `item` field (not `path`), format `{id}` (not `{revid}` or `{revisionid}`)
- `cm find revision where changeset=N` only returns files modified IN that changeset — use `changeset<=N` for parent side

## Build Commands
```bash
npm install                  # Install dependencies
npm run codegen              # Regenerate types from OpenAPI spec
npm run build                # Full build (codegen + esbuild)
npm run build:ext            # Build without codegen (faster)
npm run watch                # Watch mode for development
```

## Development
- Press F5 in VS Code to launch Extension Development Host
- The extension activates when a folder containing `.plastic/plastic.workspace` is opened
- Output channel: "Plastic SCM" (View → Output → select "Plastic SCM")

## Architecture
```
Layer 7: MCP Server        → src/mcp/          (Phase 6)
Layer 6: Status Bar        → src/statusBar/    ✅
Layer 5: Commands          → src/commands/     ✅ (staging, checkin, auth, general, branch)
Layer 4: Tree Views        → src/views/        ✅ branches, history graph (Phase 4-5 remaining)
Layer 3: SCM Provider      → src/scm/          ✅
Layer 2: Core Services     → src/core/         ✅ (workspace, types, backend abstraction)
Layer 1: API Client        → src/api/          ✅
Utilities                  → src/util/         ✅ (cache, logger, config, detector)
```

## Key Files
- `openapi/api-1.json` — Source OpenAPI 3.0 spec (DO NOT EDIT)
- `src/api/generated/schema.d.ts` — Generated types (DO NOT EDIT, run `npm run codegen`)
- `src/scm/stagingManager.ts` — Client-side staging (the core innovation)
- `src/scm/plasticScmProvider.ts` — SourceControl with Staged/Changes groups
- `src/util/plasticDetector.ts` — Auto-detect workspace from .plastic folder

## Conventions
- Types: `UpperCamelCase`, Fields: `lowerCamelCase`
- Tabs for indentation
- No `vscode` imports in `src/core/` (domain logic must be framework-free)
- All auth tokens in SecretStorage, never in plaintext settings
