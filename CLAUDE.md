# BetterSCM — Plastic SCM Pro VS Code Extension

## What This Is
A feature-complete VS Code extension for Plastic SCM, replacing the limited official extension. Built on the Plastic SCM REST API (189 endpoints, 218 schemas).

## Implementation Plan
See `docs/implementation-plan.md` for the full phased plan with architecture details.

## Current Status: Phase 3a Complete
- **Phase 1** ✅ Auth (JWT + PAT + SSO), status polling, client-side staging, selective checkin
- **Phase 2** ✅ Click-to-diff, quick diff provider, branch change detection
- **Backend refactor** ✅ `PlasticBackend` interface with `CliBackend` (primary) + `RestBackend` (fallback)
- **Phase 3a** ✅ Branch tree view, create/switch/delete commands
- **Tests** ✅ 176 unit tests (vitest)
- **Next**: Phase 3b (changeset history tree) or Phase 4 (code reviews)

### Known cm CLI Quirks (handled)
- Compound type codes: `cm status --machinereadable` emits `AD LD` for added-then-locally-deleted files
- Merge info field is `NO_MERGES` (plural), not `NO_MERGE`
- Absolute paths need workspace root stripping (case-insensitive on Windows)

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
Layer 4: Tree Views        → src/views/        ✅ branches (Phase 3b-5 remaining)
Layer 3: SCM Provider      → src/scm/          ✅
Layer 2: Core Services     → src/core/         ✅ (workspace, types, backend abstraction)
Layer 1: API Client        → src/api/          ✅
Utilities                  → src/util/         ✅
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
