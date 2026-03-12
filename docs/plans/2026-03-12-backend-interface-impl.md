# Backend Interface Refactor — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace ad-hoc `if (isCliBackend())` dispatch with a `PlasticBackend` interface implemented by `CliBackend` and `RestBackend` classes. CLI is the primary backend.

**Architecture:** A `PlasticBackend` interface defines all workspace operations. Two classes implement it. A singleton `getBackend()` returns the active instance. `workspace.ts` becomes a thin facade. Consumers don't change.

**Tech Stack:** TypeScript, VS Code Extension API, `child_process.execFile` (CLI), `openapi-fetch` (REST)

**Design doc:** `docs/2026-03-12-backend-interface-design.md`

**Build command (Windows):** `cmd.exe /c "cd /d C:\GitHub\BetterSCM && npm run build"`

**Type-check command:** `cd /mnt/c/GitHub/BetterSCM && npx tsc --noEmit`

**Note:** This project has NO test framework set up. No unit tests. Skip all TDD steps — just type-check and build after each task.

**Note:** This project is NOT a git repo. No commits. Just verify the build passes.

---

### Task 1: Add backend-neutral result types to `types.ts`

**Files:**
- Modify: `src/core/types.ts`

**Step 1: Add result types after the existing `NormalizedChange` interface**

Add these types at the bottom of the file, after the `normalizeChange` function:

```typescript
/**
 * Backend-neutral result types. Decoupled from REST API schema and cm CLI output.
 */

export interface StatusResult {
	changes: NormalizedChange[];
}

export interface CheckinResult {
	changesetId: number;
	branchName: string;
}

export class NotSupportedError extends Error {
	constructor(operation: string, backend: string) {
		super(`"${operation}" is not supported by the ${backend} backend`);
		this.name = 'NotSupportedError';
	}
}
```

**Step 2: Type-check**

Run: `cd /mnt/c/GitHub/BetterSCM && npx tsc --noEmit`
Expected: No errors

---

### Task 2: Define `PlasticBackend` interface and singleton in `backend.ts`

**Files:**
- Rewrite: `src/core/backend.ts`

**Step 1: Replace entire file contents**

```typescript
import { log } from '../util/logger';
import type { StatusResult, CheckinResult, NormalizedChange } from './types';
import { NotSupportedError } from './types';

/**
 * Contract for all workspace operations.
 * CLI and REST backends implement this interface.
 */
export interface PlasticBackend {
	readonly name: string;

	// Phase 1
	getStatus(showPrivate: boolean): Promise<StatusResult>;
	getCurrentBranch(): Promise<string | undefined>;
	checkin(paths: string[], comment: string): Promise<CheckinResult>;
	getFileContent(revSpec: string): Promise<Uint8Array | undefined>;
}

let activeBackend: PlasticBackend | undefined;

/**
 * Get the active backend. Throws if none configured.
 */
export function getBackend(): PlasticBackend {
	if (!activeBackend) {
		throw new Error('No Plastic SCM backend configured');
	}
	return activeBackend;
}

/**
 * Set the active backend instance.
 */
export function setBackend(backend: PlasticBackend): void {
	log(`Backend set to: ${backend.name}`);
	activeBackend = backend;
}

/**
 * Check if any backend is configured.
 */
export function hasBackend(): boolean {
	return !!activeBackend;
}

export { NotSupportedError };
```

**Step 2: Type-check**

Run: `cd /mnt/c/GitHub/BetterSCM && npx tsc --noEmit`
Expected: Errors in files that import old `backend.ts` exports (`isCliBackend`, `BackendMode`). That's expected — we fix those in the next tasks.

---

### Task 3: Create `CliBackend` class in `backendCli.ts`

**Files:**
- Create: `src/core/backendCli.ts`

**Step 1: Write the full CliBackend class**

Port all logic from `workspaceCli.ts` into the class, with strict error handling (throw on failures, no optional result fields):

```typescript
import { execCm } from './cmCli';
import { log, logError } from '../util/logger';
import type { PlasticBackend } from './backend';
import type {
	StatusResult,
	CheckinResult,
	NormalizedChange,
	StatusChangeType,
} from './types';

const CM_CHANGE_TYPE_MAP: Record<string, StatusChangeType> = {
	PR: 'private',
	AD: 'added',
	CO: 'checkedOut',
	CH: 'changed',
	DE: 'deleted',
	LD: 'locallyDeleted',
	MV: 'moved',
	RP: 'replaced',
	CP: 'copied',
	IG: 'ignored',
	HD: 'changed',
};

export class CliBackend implements PlasticBackend {
	readonly name = 'cm CLI';

	async getStatus(showPrivate: boolean): Promise<StatusResult> {
		const result = await execCm(['status', '--machinereadable', '--all']);
		if (result.exitCode !== 0) {
			throw new Error(`cm status failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
		}

		const lines = result.stdout.split(/\r?\n/).filter(l => l.length > 0);
		const changes: NormalizedChange[] = [];

		for (const line of lines) {
			if (line.startsWith('STATUS ')) continue;
			const parsed = parseStatusLine(line);
			if (!parsed) continue;
			if (!showPrivate && parsed.changeType === 'private') continue;
			changes.push(parsed);
		}

		return { changes };
	}

	async getCurrentBranch(): Promise<string | undefined> {
		const result = await execCm(['wi', '--machinereadable']);
		if (result.exitCode !== 0) {
			throw new Error(`cm wi failed (exit ${result.exitCode}): ${result.stderr}`);
		}

		const line = result.stdout.trim();
		const match = line.match(/^BR\s+(\S+)/);
		return match?.[1] ?? undefined;
	}

	async checkin(paths: string[], comment: string): Promise<CheckinResult> {
		const args = ['checkin', `-c=${comment}`, '--machinereadable', ...paths];
		const result = await execCm(args);

		if (result.exitCode !== 0) {
			throw new Error(`cm checkin failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
		}

		const csMatch = result.stdout.match(/cs:(\d+)/);
		const branchMatch = result.stdout.match(/(?:^|\s)br:([^\s]+)/m)
			|| result.stdout.match(/branch\s+"?([^"\n]+)/);

		if (!csMatch) {
			throw new Error(`cm checkin succeeded but could not parse changeset ID from: ${result.stdout}`);
		}

		log(`Checked in ${paths.length} file(s): "${comment}"`);

		return {
			changesetId: parseInt(csMatch[1], 10),
			branchName: branchMatch?.[1] ?? 'unknown',
		};
	}

	async getFileContent(revSpec: string): Promise<Uint8Array | undefined> {
		const result = await execCm(['cat', revSpec, '--raw']);
		if (result.exitCode !== 0) {
			// Exit code != 0 for "file not found at revision" is legitimate absence
			return undefined;
		}
		return Buffer.from(result.stdout, 'binary');
	}
}

function parseStatusLine(line: string): NormalizedChange | undefined {
	const typeCode = line.substring(0, 2).trim();
	const changeType = CM_CHANGE_TYPE_MAP[typeCode];
	if (!changeType) return undefined;

	const rest = line.substring(3);
	const lastSpace = rest.lastIndexOf(' ');
	if (lastSpace < 0) return undefined;

	const beforeMerge = rest.substring(0, lastSpace);
	const secondLastSpace = beforeMerge.lastIndexOf(' ');
	if (secondLastSpace < 0) return undefined;

	const isDirStr = beforeMerge.substring(secondLastSpace + 1);
	const filePath = beforeMerge.substring(0, secondLastSpace);
	if (!filePath) return undefined;

	return {
		path: filePath,
		changeType,
		dataType: isDirStr === 'True' ? 'Directory' : 'File',
	};
}
```

**Step 2: Type-check**

Run: `cd /mnt/c/GitHub/BetterSCM && npx tsc --noEmit`
Expected: Still has errors from old imports in other files. `backendCli.ts` itself should be clean.

---

### Task 4: Create `RestBackend` class in `backendRest.ts`

**Files:**
- Create: `src/core/backendRest.ts`

**Step 1: Write the full RestBackend class**

Extract REST logic from `workspace.ts`:

```typescript
import { getClient, getOrgName, getWorkspaceGuid } from '../api/client';
import { log, logError } from '../util/logger';
import type { PlasticBackend } from './backend';
import type { StatusResult, CheckinResult, NormalizedChange } from './types';
import type { CheckInRequest } from './types';
import { normalizeChange } from './types';

export class RestBackend implements PlasticBackend {
	readonly name = 'REST API';

	async getStatus(showPrivate: boolean): Promise<StatusResult> {
		const client = getClient();
		const orgName = getOrgName();
		const workspaceGuid = getWorkspaceGuid();

		const { data, error } = await client.GET(
			'/api/v1/organizations/{organizationName}/workspaces/{workspaceGuid}/status',
			{ params: { path: { organizationName: orgName, workspaceGuid } } },
		);

		if (error) throw error;

		const rawChanges = data?.changes ?? [];
		let changes = rawChanges
			.map(normalizeChange)
			.filter((c): c is NormalizedChange => c !== undefined);

		if (!showPrivate) {
			changes = changes.filter(c => c.changeType !== 'private');
		}

		return { changes };
	}

	async getCurrentBranch(): Promise<string | undefined> {
		const client = getClient();
		const orgName = getOrgName();
		const workspaceGuid = getWorkspaceGuid();

		const { data, error } = await client.GET(
			'/api/v1/organizations/{organizationName}/workspaces/{workspaceGuid}',
			{ params: { path: { organizationName: orgName, workspaceGuid } } },
		);

		if (error) throw error;

		const conn = (data as any)?.uvcsConnections?.[0];
		if (conn?.target?.type === 'Branch') {
			return conn.target.spec ?? conn.target.repositoryName ?? undefined;
		}
		return conn?.target?.spec ?? undefined;
	}

	async checkin(paths: string[], comment: string): Promise<CheckinResult> {
		const client = getClient();
		const orgName = getOrgName();
		const workspaceGuid = getWorkspaceGuid();

		const body: CheckInRequest = { items: paths, comment, statusIgnoreCase: false };

		const { data, error } = await client.POST(
			'/api/v1/organizations/{organizationName}/workspaces/{workspaceGuid}/checkin',
			{
				params: { path: { organizationName: orgName, workspaceGuid } },
				body: body as any,
			},
		);

		if (error) throw error;

		const result = data as any;
		log(`Checked in ${paths.length} file(s): "${comment}"`);

		return {
			changesetId: result?.changesetId ?? 0,
			branchName: result?.branchName ?? 'unknown',
		};
	}

	async getFileContent(revSpec: string): Promise<Uint8Array | undefined> {
		const client = getClient();
		const orgName = getOrgName();
		const workspaceGuid = getWorkspaceGuid();

		const { data, error } = await client.GET(
			'/api/v1/organizations/{organizationName}/workspaces/{workspaceGuid}/content/{revisionGuid}',
			{
				params: { path: { organizationName: orgName, workspaceGuid, revisionGuid: revSpec } },
				parseAs: 'arrayBuffer',
			},
		);

		if (error) return undefined;

		return data ? new Uint8Array(data as ArrayBuffer) : undefined;
	}
}
```

**Step 2: Type-check**

Run: `cd /mnt/c/GitHub/BetterSCM && npx tsc --noEmit`
Expected: Errors still from old imports in `workspace.ts`, `config.ts`, `extension.ts`. Both backend files should be clean.

---

### Task 5: Rewrite `workspace.ts` as thin facade

**Files:**
- Rewrite: `src/core/workspace.ts`

**Step 1: Replace entire file contents**

```typescript
import { getBackend } from './backend';
import type { StatusResult, CheckinResult } from './types';

// Re-export for consumers that import from workspace.ts
export type { StatusResult as WorkspaceStatusResult } from './types';

/**
 * Fetch the current workspace status (pending changes).
 */
export async function fetchWorkspaceStatus(showPrivateFiles: boolean): Promise<StatusResult> {
	return getBackend().getStatus(showPrivateFiles);
}

/**
 * Get the current branch name.
 */
export async function getCurrentBranch(): Promise<string | undefined> {
	return getBackend().getCurrentBranch();
}

/**
 * Check in specified files to the workspace.
 */
export async function checkinFiles(
	paths: string[],
	comment: string,
): Promise<CheckinResult> {
	return getBackend().checkin(paths, comment);
}

/**
 * Fetch file content for a specific revision (for diffs).
 */
export async function fetchFileContent(revSpec: string): Promise<Uint8Array | undefined> {
	return getBackend().getFileContent(revSpec);
}
```

**Step 2: Type-check**

Run: `cd /mnt/c/GitHub/BetterSCM && npx tsc --noEmit`
Expected: Errors in consumers that imported old types (`WorkspaceResponse`, `CheckinResponseModel` from workspace). We fix those next.

---

### Task 6: Update consumers to use new types

**Files:**
- Modify: `src/commands/checkin.ts`
- Modify: `src/scm/plasticScmProvider.ts`
- Modify: `src/statusBar/plasticStatusBar.ts`
- Modify: `src/scm/quickDiffProvider.ts`
- Modify: `src/util/config.ts`

**Step 1: Fix `checkin.ts`**

The `checkinFiles` return type changed from `CheckinResponseModel | undefined` to `CheckinResult`. Update the result usage at line ~71-76:

```typescript
// Old:
const csId = result.changesetId ?? 'unknown';
// New (result is now always defined, changesetId is always a number):
const csId = result.changesetId;
```

Also remove the `if (result)` guard — `checkinFiles` now always returns a `CheckinResult` or throws.

Change:
```typescript
const result = await checkinFiles(paths, comment);
if (result) {
    const csId = result.changesetId ?? 'unknown';
    vscode.window.showInformationMessage(
        `Checked in ${paths.length} file(s) as changeset ${csId}`,
    );
    log(`Checkin result: changeset ${csId} on branch ${result.branchName}`);
}
```

To:
```typescript
const result = await checkinFiles(paths, comment);
vscode.window.showInformationMessage(
    `Checked in ${paths.length} file(s) as changeset ${result.changesetId}`,
);
log(`Checkin result: changeset ${result.changesetId} on branch ${result.branchName}`);
```

Also update the import — remove `checkinFiles` from `'../core/workspace'` if it's imported from there (it should still work since workspace.ts re-exports it).

**Step 2: Fix `plasticScmProvider.ts`**

The `fetchWorkspaceStatus` return type is now `StatusResult` (which has `changes` but no `version`). Check that `pollStatus` only uses `result.changes` — it already does, so no code change needed. But verify the import works:

Import should remain: `import { fetchWorkspaceStatus } from '../core/workspace';`

**Step 3: Fix `quickDiffProvider.ts`**

The `fetchFileContent` now returns `Uint8Array | undefined` instead of `ArrayBuffer | undefined`. The `TextDecoder.decode()` accepts both, so the code at line 34-36 works without change. Verify the import.

**Step 4: Fix `config.ts`**

Replace the `isCmAvailable` import with `hasBackend`:

```typescript
import { hasBackend } from '../core/backend';

export function isConfigured(): boolean {
	const cfg = getConfig();
	return !!(cfg.serverUrl && cfg.organizationName) || hasBackend();
}
```

Wait — `hasBackend()` returns false at the time `isConfigured()` is first called (before `setupProvider` sets the backend). The current code uses `isCmAvailable()` which is set by `detectCm()` before `isConfigured()` runs. Keep using `isCmAvailable`:

```typescript
import { isCmAvailable } from '../core/cmCli';
```

This is already correct. No change needed.

**Step 5: Type-check**

Run: `cd /mnt/c/GitHub/BetterSCM && npx tsc --noEmit`
Expected: Errors in `extension.ts` from old `backend.ts` imports. Fixed in next task.

---

### Task 7: Update `extension.ts` wiring

**Files:**
- Modify: `src/extension.ts`

**Step 1: Update imports**

Replace:
```typescript
import { detectCm, setCmWorkspaceRoot, isCmAvailable } from './core/cmCli';
import { setBackend } from './core/backend';
```

With:
```typescript
import { detectCm, setCmWorkspaceRoot, isCmAvailable } from './core/cmCli';
import { setBackend } from './core/backend';
import { CliBackend } from './core/backendCli';
import { RestBackend } from './core/backendRest';
```

**Step 2: Update `setupProvider` backend wiring**

Replace the old backend switching block (lines ~175-179):
```typescript
// If REST API auth failed but cm CLI is available, switch to CLI backend
if (!hasCreds && cmAvailable) {
    log('REST API auth failed — switching to cm CLI backend');
    setBackend('cli');
}
```

With:
```typescript
// Set the active backend: REST if authenticated, CLI as fallback
if (hasCreds) {
    setBackend(new RestBackend());
} else if (cmAvailable) {
    log('REST API auth failed — using cm CLI backend');
    setBackend(new CliBackend());
} else {
    log('No backend available — neither REST API nor cm CLI');
}
```

**Step 3: Remove the `fetchWorkspaceDetails` import**

The `validateCredentials` function uses `fetchWorkspaceDetails` which no longer exists in `workspace.ts`. Replace it with a direct REST API call:

```typescript
import { fetchWorkspaceDetails } from './core/workspace';
```

Remove that import. Replace `validateCredentials`:

```typescript
async function validateCredentials(): Promise<boolean> {
    try {
        const client = getClient();
        const orgName = getOrgName();
        const workspaceGuid = getWorkspaceGuid();
        await client.GET(
            '/api/v1/organizations/{organizationName}/workspaces/{workspaceGuid}',
            { params: { path: { organizationName: orgName, workspaceGuid } } },
        );
        return true;
    } catch {
        return false;
    }
}
```

Add the missing imports at the top:
```typescript
import { getClient, getOrgName, getWorkspaceGuid, resetClient } from './api/client';
```

And remove the duplicate `resetClient` from the existing import line if present.

**Step 4: Type-check**

Run: `cd /mnt/c/GitHub/BetterSCM && npx tsc --noEmit`
Expected: No errors

---

### Task 8: Delete dead files

**Files:**
- Delete: `src/core/workspaceCli.ts`

This file's logic is now in `backendCli.ts`. Delete it entirely.

**Step 1: Delete the file**

```bash
rm /mnt/c/GitHub/BetterSCM/src/core/workspaceCli.ts
```

**Step 2: Verify no remaining imports**

Search for `workspaceCli` in all `.ts` files. There should be none (workspace.ts was rewritten in Task 5 and no longer imports it).

**Step 3: Build**

Run: `cmd.exe /c "cd /d C:\GitHub\BetterSCM && npm run build"`
Expected: Build succeeds, bundle size ~68-70kb

---

### Task 9: Verify end-to-end

**Step 1: Reload extension in VS Code**

Press Ctrl+Shift+P → "Developer: Reload Window"

**Step 2: Check output log**

Open Output → "Plastic SCM". Verify:
- `Found cm CLI at "C:\Program Files\PlasticSCM5\client\cm.exe": 11.x.x`
- `Backend set to: cm CLI`
- `SCM provider started`
- No errors in the log

**Step 3: Check SCM panel**

Verify changes appear in the Source Control panel with correct decorations (same as before the refactor).

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | Add result types | `types.ts` |
| 2 | Define interface + singleton | `backend.ts` (rewrite) |
| 3 | Create CliBackend | `backendCli.ts` (new) |
| 4 | Create RestBackend | `backendRest.ts` (new) |
| 5 | Rewrite workspace facade | `workspace.ts` (rewrite) |
| 6 | Update consumers | `checkin.ts`, `config.ts` |
| 7 | Wire extension startup | `extension.ts` |
| 8 | Delete dead code | `workspaceCli.ts` (delete) |
| 9 | Verify end-to-end | Manual test |
