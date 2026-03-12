# Plastic SCM VS Code Extension — Feature-Complete SCM + Agent Toolset

## Context

The existing Plastic SCM VS Code extension is severely limited — no selective file staging, no interactive capacity comparable to Git's integration, limited command coverage. The user has a complete OpenAPI 3.0 spec (`api-1.json`) with **189 operations across 33 API categories and 218 data schemas**. The goal is to build a custom VS Code extension that provides a Git-quality SCM experience for Plastic SCM, usable by both humans and AI agents.

## API Surface Summary

| Category | Endpoints | Key Operations |
|----------|-----------|----------------|
| Workspaces | 20 | create, list, tree, status, checkin, checkout, update, content, save, delete, move |
| Branches | 9 | CRUD, hidden branches |
| Changesets | 5 | list, details, update |
| Diffs | 16 | branch/changeset/revision/text diffs |
| Code Reviews | 26 | full lifecycle with comments, reviewers |
| Labels | 9 | CRUD, apply |
| Repositories | 13 | CRUD, clone, permissions |
| Merges/Mergebots | 17 | merge-to, reports, automation |
| Locks | 5 | rules, status |
| Auth (Login/PAT/API Keys) | 22 | JWT login/refresh, PATs, API keys |
| Other (History, Items, Revisions, Users, Attributes, Triggers, Subscriptions, Permissions) | 47 | various |

**Auth**: JWT Bearer tokens via `/api/v1/.../login`, refresh token flow, also supports Personal Access Tokens.

## Architecture

```
Layer 7: MCP Server (AI agent tools via stdio)
Layer 6: Status Bar (branch + pending count)
Layer 5: Commands (stage, checkin, branch, merge, review...)
Layer 4: Tree Views (branches, changesets, code reviews, labels)
Layer 3: SCM Provider (SourceControl, resource groups, quick diff)
Layer 2: Core Services (domain logic, no VS Code imports)
Layer 1: API Client (openapi-fetch + generated types + auth interceptor)
```

**Key principle**: SCM Provider (Layer 3) owns canonical staging state. All other layers mutate through it.

## Project Structure

```
vscode-plastic-scm/
├── src/
│   ├── extension.ts                    # Entry point
│   ├── constants.ts                    # IDs, command names, setting keys
│   ├── api/
│   │   ├── generated/schema.d.ts       # openapi-typescript output (DO NOT EDIT)
│   │   ├── client.ts                   # openapi-fetch wrapper
│   │   ├── auth.ts                     # JWT lifecycle + SecretStorage
│   │   ├── interceptors.ts             # Auth header, error normalization
│   │   └── errors.ts                   # Typed error hierarchy
│   ├── core/                           # Domain logic (no vscode imports)
│   │   ├── workspace.ts                # Status polling, change tracking
│   │   ├── branches.ts                 # Branch operations
│   │   ├── changesets.ts               # Changeset queries
│   │   ├── codeReviews.ts              # Review CRUD + comments
│   │   ├── diffs.ts                    # All diff operations
│   │   ├── labels.ts                   # Label CRUD
│   │   ├── merges.ts                   # Merge-to + reports
│   │   ├── locks.ts                    # Lock rules/status
│   │   ├── history.ts                  # File/item history
│   │   ├── repositories.ts             # Repo operations
│   │   └── types.ts                    # Domain types extending generated schemas
│   ├── scm/
│   │   ├── plasticScmProvider.ts        # SourceControl + resource groups
│   │   ├── stagingManager.ts            # Client-side staging set (memento-persisted)
│   │   ├── resourceStateFactory.ts      # StatusChange → SourceControlResourceState
│   │   ├── quickDiffProvider.ts         # plastic: URI scheme + content provider
│   │   └── decorations.ts              # File status icons/colors
│   ├── views/
│   │   ├── branchesTreeProvider.ts
│   │   ├── changesetsTreeProvider.ts
│   │   ├── codeReviewsTreeProvider.ts
│   │   ├── labelsTreeProvider.ts
│   │   └── items/                       # TreeItem subclasses
│   ├── commands/
│   │   ├── staging.ts                   # stage, unstage, stageAll, unstageAll
│   │   ├── checkin.ts                   # checkin staged / checkin all
│   │   ├── checkout.ts                  # checkout files
│   │   ├── branch.ts                    # create, switch, delete
│   │   ├── merge.ts                     # merge-to
│   │   ├── diff.ts                      # open diff, compare branches
│   │   ├── codeReview.ts               # create, comment, status change
│   │   ├── label.ts                     # create, apply
│   │   ├── update.ts                    # update workspace (pull)
│   │   └── history.ts                   # file history, annotate/blame
│   ├── statusBar/plasticStatusBar.ts
│   ├── mcp/
│   │   ├── server.ts                    # MCP server (stdio transport)
│   │   ├── tools/                       # 14 MCP tools for agents
│   │   ├── resources/                   # Subscribable resources
│   │   └── prompts/                     # Commit message, review summary
│   └── util/
│       ├── config.ts                    # Settings reader
│       ├── disposable.ts               # DisposableStore
│       ├── logger.ts                    # OutputChannel logger
│       ├── polling.ts                   # Adaptive interval poller
│       ├── uri.ts                       # plastic: URI builder/parser
│       └── plasticDetector.ts           # Auto-detect workspace from .plastic folder
├── openapi/api-1.json                   # Source spec
├── package.json                         # Extension manifest
├── tsconfig.json
├── esbuild.config.mjs                   # Two bundles: extension + MCP server
└── test/
```

## Key Design Decisions

1. **Client-side staging** — Plastic API's `CheckInRequest.items[]` already supports selective checkin; the existing extension just never exposed it. A `StagingManager` with memento persistence gives Git-like stage/unstage UX.

2. **Two resource groups** — "Staged Changes" + "Changes", mirroring Git. Each file gets decorations (A/M/D/CO/P/MV) and inline context menu actions.

3. **openapi-typescript + openapi-fetch** — Zero-runtime type generation (not heavyweight class codegen). 218 schemas as pure TypeScript types, ~0 KB bundle impact.

4. **Polling with adaptive backoff** — 3s default, backs off to 10s after 30s of no changes. The subscriptions API is server-side webhooks, not suitable for real-time client push.

5. **Separate MCP server process** — Child process via stdio, communicates with extension host via IPC. Prevents blocking the extension host with long-running agent operations.

6. **Tokens in SecretStorage** — Never in plaintext settings. Supports both JWT (login/refresh) and PAT auth.

7. **Auto-detection from .plastic folder** — Reads workspace GUID, org, repo, branch, and cloud/local status from `.plastic/plastic.workspace` and `.plastic/plastic.selector`. Also reads client auth mode from `%LOCALAPPDATA%/plastic4/client.conf`. Settings are auto-populated as workspace-scoped config (never overrides explicit user settings).

## Implementation Phases

### Phase 1: Foundation — Auth + Status + Staging + Checkin ✅ COMPLETE
**Deliverable**: Sign in, see changes split into Staged/Changes groups, stage/unstage files, selective checkin.

1. ✅ Scaffold project: `package.json`, `tsconfig.json`, `esbuild.config.mjs`
2. ✅ Copy `api-1.json` → `openapi/`, run `openapi-typescript` → `schema.d.ts` (12,342 lines)
3. ✅ `src/api/client.ts` — openapi-fetch wrapper with base URL config
4. ✅ `src/api/auth.ts` — JWT login/refresh, SecretStorage, PAT support
5. ✅ `src/api/errors.ts` — PlasticApiError hierarchy (AuthExpired, NotFound, Conflict, Connection)
6. ✅ `src/core/workspace.ts` — status polling, checkin, file content fetch
7. ✅ `src/core/types.ts` — Normalized domain types from generated schemas
8. ✅ `src/scm/stagingManager.ts` — Set<string> staging with memento persist
9. ✅ `src/scm/resourceStateFactory.ts` — StatusChange → ResourceState with decorations
10. ✅ `src/scm/decorations.ts` — Change type → icon/color/letter mappings
11. ✅ `src/scm/plasticScmProvider.ts` — SourceControl + two groups + inputBox + polling
12. ✅ `src/scm/quickDiffProvider.ts` — plastic: URI scheme + content provider (stub for Phase 2)
13. ✅ `src/commands/staging.ts` — stage/unstage/stageAll/unstageAll
14. ✅ `src/commands/checkin.ts` — checkin via `POST /workspaces/{guid}/checkin`
15. ✅ `src/commands/general.ts` — refresh, openFile, openChange, revertChange
16. ✅ `src/commands/auth.ts` — login (3 methods), logout
17. ✅ `src/statusBar/plasticStatusBar.ts` — branch name + staged/pending count
18. ✅ `src/extension.ts` — activation, auto-detection, wiring, stub commands
19. ✅ `src/util/plasticDetector.ts` — Auto-detect workspace from .plastic folder + client.conf

**Build**: 58.6kb bundle, 0 type errors, compiles in 11ms.

### Phase 2: Diffs + Quick Diff
**Deliverable**: Click a file → see diff. Gutter decorations for inline changes.

1. `src/scm/quickDiffProvider.ts` — Complete implementation: map workspace file URIs to plastic: URIs using revision info from StatusResponse
2. `src/commands/diff.ts` — open side-by-side diff via `vscode.commands.executeCommand('vscode.diff', ...)`
3. Binary file detection (skip diff for non-text DataType)
4. Wire `openChange` command to actually open diff instead of just the file

### Phase 3: Branch + Changeset Trees
**Deliverable**: Activity bar panel with branch explorer and changeset history.

1. `src/core/branches.ts` — list, create, delete branches via v1+v2 endpoints
2. `src/views/branchesTreeProvider.ts` — tree with current branch indicator, code review badges
3. `src/commands/branch.ts` — create/switch/delete via QuickPick
4. `src/core/changesets.ts` — list changesets filtered by branch
5. `src/views/changesetsTreeProvider.ts` — expandable tree showing diff files per changeset
6. `src/commands/update.ts` — workspace update with conflict handling via `POST /workspaces/{guid}/update`

### Phase 4: Code Reviews
**Deliverable**: Full review lifecycle in VS Code.

1. `src/core/codeReviews.ts` — CRUD + comments + reviewers via v1+v2 endpoints
2. `src/views/codeReviewsTreeProvider.ts` — three sections: assigned to me, created by me, all pending
3. Code review webview panel (metadata, diffs, threaded comments, approve/request rework actions)
4. Badge count for assigned reviews on the tree view icon

### Phase 5: Labels, Merges, History, Locks
**Deliverable**: Feature parity with desktop client for daily operations.

1. `src/core/labels.ts` + `src/views/labelsTreeProvider.ts` — Labels tree + CRUD
2. `src/core/merges.ts` + `src/commands/merge.ts` — Merge-to command with QuickPick
3. `src/core/history.ts` + `src/commands/history.ts` — File history timeline + annotate/blame
4. `src/core/locks.ts` — Lock management UI

### Phase 6: MCP Server
**Deliverable**: AI agents can stage, commit, diff, branch, review via MCP.

14 tools: `plastic_status`, `plastic_stage`, `plastic_unstage`, `plastic_checkin`, `plastic_diff`, `plastic_file_diff`, `plastic_branches`, `plastic_create_branch`, `plastic_switch_branch`, `plastic_file_history`, `plastic_create_review`, `plastic_list_reviews`, `plastic_merge`, `plastic_annotate`

Resources: `plastic://workspace/status`, `plastic://workspace/branch`, `plastic://workspace/staged`, etc.

Prompts: `plastic_commit_message`, `plastic_review_summary`

### Phase 7: Polish
Locks UI, repo cloning, xlinks, keyboard shortcuts, incoming change notifications.

## Auto-Detection Details

The extension reads from the opened workspace's `.plastic` folder on activation:

| File | Extracts |
|------|----------|
| `.plastic/plastic.workspace` | Line 1: workspace name, Line 2: workspace GUID, Line 3: type |
| `.plastic/plastic.selector` | `repository "OrgName/RepoName@serverId@cloud"` → org, repo, server, branch |
| `%LOCALAPPDATA%/plastic4/client.conf` | Working mode (SSO/LDAP), user email |

For `@cloud` workspaces → `https://prd-azure-eastus-01-cloud.plasticscm.com:7178`
For local workspaces → `http://localhost:7178`

Settings are written as **workspace-scoped** config (never overrides explicit user values).

## Build Tooling

```jsonc
{
  "dependencies": {
    "openapi-fetch": "^0.13.0"
  },
  "devDependencies": {
    "@types/node": "^25.4.0",
    "@types/vscode": "^1.95.0",
    "@vscode/vsce": "^3.2.0",
    "esbuild": "^0.24.0",
    "openapi-typescript": "^7.4.0",
    "typescript": "^5.7.0"
  },
  "scripts": {
    "codegen": "openapi-typescript openapi/api-1.json -o src/api/generated/schema.d.ts",
    "build": "npm run codegen && node esbuild.config.mjs",
    "build:ext": "node esbuild.config.mjs",
    "watch": "node esbuild.config.mjs --watch",
    "package": "vsce package"
  }
}
```

## Verification

1. **Phase 1**: Sign in → status shows in SCM panel → stage files → checkin → verify on Plastic server
2. **Phase 2**: Click changed file → diff opens → gutter decorations visible
3. **Phase 3**: Open activity bar → browse branches → switch branch → view changesets
4. **Phase 4**: Create review → add comment → change status → verify on server
5. **Phase 6**: Configure MCP → agent calls `plastic_status` → stages files → commits

## Source Files
- `openapi/api-1.json` — OpenAPI 3.0 spec (189 ops, 218 schemas)
- https://docs.plasticscm.com/restapi/plastic-scm-server-rest-api-guide — REST API docs
