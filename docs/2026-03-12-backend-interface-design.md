# Backend Interface Design

## Problem

Phase 1 used ad-hoc `if (isCliBackend())` checks in `workspace.ts` to dispatch between REST API and cm CLI. This doesn't scale — Phase 2+ adds diffs, branches, history, code reviews, each needing dual implementations. We need a shared contract.

## Decision

**Interface + Two Classes** (Approach A). A `PlasticBackend` interface defines the contract. `CliBackend` and `RestBackend` implement it. A singleton accessor returns the active instance. CLI is the primary implementation; REST fills in when available.

## Interface

```typescript
interface PlasticBackend {
  // Phase 1
  getStatus(showPrivate: boolean): Promise<StatusResult>;
  getCurrentBranch(): Promise<string | undefined>;
  checkin(paths: string[], comment: string): Promise<CheckinResult>;
  getFileContent(revSpec: string): Promise<Uint8Array | undefined>;

  // Phase 2
  getDiff(path: string): Promise<DiffResult | undefined>;

  // Phase 3+
  listBranches(): Promise<BranchInfo[]>;
  createBranch(name: string, from?: string): Promise<BranchInfo>;
  switchBranch(name: string): Promise<void>;
  deleteBranch(name: string): Promise<void>;
  listChangesets(branch?: string, count?: number): Promise<ChangesetInfo[]>;
  getHistory(path: string): Promise<HistoryEntry[]>;
  annotate(path: string): Promise<AnnotateLine[]>;
}
```

Future phases (code reviews, labels, merges, locks) add methods as needed.

## Error Contract

- **Throw** on all failures: network, auth, parse errors, CLI exit code != 0.
- **Return `undefined`** only for legitimate absence (file doesn't exist at revision, no diff for path).
- **No optional fields on result types.** If a backend can't produce a field, that's a parse error — throw.

## Result Types

Defined in `src/core/types.ts`, backend-neutral. Decoupled from REST API schema and cm CLI output format.

```typescript
interface StatusResult {
  changes: NormalizedChange[];
}

interface CheckinResult {
  changesetId: number;
  branchName: string;
}

interface DiffEntry {
  path: string;
  status: StatusChangeType;
  srcPath?: string;  // only present for moves/copies
}

interface BranchInfo {
  name: string;
  isHead: boolean;
  changeset: number;
}

interface ChangesetInfo {
  id: number;
  branch: string;
  author: string;
  date: string;
  comment: string;
}

interface HistoryEntry {
  revisionId: number;
  changeset: number;
  author: string;
  date: string;
  comment: string;
}

interface AnnotateLine {
  lineNumber: number;
  changeset: number;
  author: string;
  content: string;
}
```

`NormalizedChange` and `StatusChangeType` already exist and are backend-neutral.

## File Layout

```
src/core/
  backend.ts          PlasticBackend interface + getBackend()/setBackend()
  backendCli.ts       class CliBackend implements PlasticBackend
  backendRest.ts      class RestBackend implements PlasticBackend
  cmCli.ts            Low-level cm exec helper (unchanged)
  types.ts            Backend-neutral result types
  workspace.ts        Thin facade delegating to getBackend()
```

Deleted: `workspaceCli.ts` (absorbed into `backendCli.ts`), old `BackendMode`/`isCliBackend` exports.

## Wiring

In `extension.ts` at startup:

```typescript
const cli = cmAvailable ? new CliBackend(wsRoot) : undefined;
const rest = restAuthOk ? new RestBackend() : undefined;
setBackend(rest ?? cli);  // REST preferred when available, CLI fallback
```

Consumers (`plasticScmProvider.ts`, `checkin.ts`, `plasticStatusBar.ts`) don't change — they still import from `workspace.ts`.

## Not-Implemented Operations

Both backends throw `NotSupportedError` for operations not yet implemented. The consumer layer catches this and shows: "This operation requires the [REST API / cm CLI] backend."

No automatic backend switching mid-session. User reloads to re-detect.

## Gradual Rollout

Each phase implements CLI first (primary), then REST if feasible. Phase 2+ methods start as `NotSupportedError` in both backends until implemented.
