# Phase 2: Diffs + Branch Detection — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the SCM panel interactive — clicking files opens diffs or the file — and keep branch display in sync with the Plastic workspace.

**Architecture:** Pass full `NormalizedChange` through command arguments so `openChange` can dispatch by change type. Implement `provideOriginalResource()` for gutter quick-diff. Poll branch alongside status to detect external switches. Add "Go to File" button in diff editor title bar.

**Tech Stack:** VS Code SCM API (`vscode.diff`, `QuickDiffProvider`, `TextDocumentContentProvider`), Vitest, existing `PlasticBackend` interface.

**Run commands from WSL:**
- Tests: `/mnt/c/nvm4w/nodejs/node.exe C:/GitHub/BetterSCM/node_modules/vitest/vitest.mjs run --config C:/GitHub/BetterSCM/vitest.config.ts --root C:/GitHub/BetterSCM`
- Type-check: `/mnt/c/nvm4w/nodejs/node.exe C:/GitHub/BetterSCM/node_modules/typescript/bin/tsc --noEmit --project C:/GitHub/BetterSCM/tsconfig.json`

**VS Code mock location:** `test/mocks/vscode.ts` — provides `Uri`, `EventEmitter`, `window`, `workspace`, `scm`, `commands`, `Disposable`, etc.

---

### Task 1: Pass NormalizedChange through resource state command arguments

The `openChange` command currently receives only a `vscode.Uri`. It needs the full `NormalizedChange` to dispatch by change type. Update `resourceStateFactory.ts` to pass `[resourceUri, change]` as command arguments.

**Files:**
- Modify: `src/scm/resourceStateFactory.ts`
- Test: `test/unit/scm/resourceStateFactory.test.ts`

**Step 1: Update the test to verify change is passed in command arguments**

Add a test case to `test/unit/scm/resourceStateFactory.test.ts`:

```typescript
it('passes NormalizedChange as second command argument', () => {
	const change: NormalizedChange = {
		path: 'src/foo.ts',
		changeType: 'changed',
		dataType: 'File',
	};
	const state = createResourceState(change, root as any);
	expect(state.command?.arguments).toHaveLength(2);
	expect(state.command?.arguments?.[1]).toBe(change);
});
```

**Step 2: Run test to verify it fails**

Run: `<test command> -- test/unit/scm/resourceStateFactory.test.ts`
Expected: FAIL — `arguments` has length 1, not 2.

**Step 3: Update resourceStateFactory.ts**

In `src/scm/resourceStateFactory.ts`, change the command arguments from `[resourceUri]` to `[resourceUri, change]`:

```typescript
command: isDeleted
	? undefined
	: {
		title: 'Open Changes',
		command: COMMANDS.openChange,
		arguments: [resourceUri, change],
	},
```

**Step 4: Run test to verify it passes**

Run: `<test command> -- test/unit/scm/resourceStateFactory.test.ts`
Expected: PASS

**Step 5: Update existing tests that check command arguments**

The test `'has open-change command for non-deleted files'` checks `state.command?.command` — this still passes. No other tests depend on argument count.

---

### Task 2: Implement openChange command dispatch by change type

Replace the stub `openChange` handler with real dispatch logic: added/private → open file, modified → open diff.

**Files:**
- Modify: `src/commands/general.ts`
- Create: `test/unit/commands/general.test.ts`

**Context:**
- `vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title)` opens a side-by-side diff
- `buildPlasticUri(workspaceGuid, revisionGuid, filePath)` creates a `plastic:` URI for the original content
- `NormalizedChange` has optional `revisionGuid` field (populated by REST backend)
- For CLI backend, `revisionGuid` is `undefined` — use `serverpath:/{path}` as the revSpec instead
- `getWorkspaceGuid()` from `src/api/client.ts` returns the current workspace GUID
- The `openChange` handler receives `(uri: vscode.Uri, change?: NormalizedChange)` — the second arg comes from Task 1

**Step 1: Write the test file**

Create `test/unit/commands/general.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { window, commands, Uri } from '../../mocks/vscode';

vi.mock('../../../src/util/uri', () => ({
	buildPlasticUri: vi.fn((ws: string, rev: string, path: string) =>
		Uri.from({ scheme: 'plastic', authority: ws, path: `/${rev}/${path}` }),
	),
}));

vi.mock('../../../src/api/client', () => ({
	getWorkspaceGuid: vi.fn(() => 'ws-guid-123'),
}));

vi.mock('../../../src/core/backend', () => ({
	getBackend: vi.fn(() => ({ name: 'cm CLI' })),
}));

import { registerGeneralCommands } from '../../../src/commands/general';
import type { NormalizedChange } from '../../../src/core/types';
import { COMMANDS } from '../../../src/constants';

describe('openChange command', () => {
	let registeredHandlers: Record<string, Function>;

	beforeEach(() => {
		vi.clearAllMocks();
		registeredHandlers = {};

		commands.registerCommand.mockImplementation((cmd: string, handler: Function) => {
			registeredHandlers[cmd] = handler;
			return { dispose: vi.fn() };
		});

		const mockProvider = {
			refresh: vi.fn().mockResolvedValue(undefined),
		};

		registerGeneralCommands(
			{ subscriptions: { push: vi.fn() } } as any,
			mockProvider as any,
		);
	});

	it('opens file directly for added files', async () => {
		const uri = Uri.file('/workspace/newFile.ts');
		const change: NormalizedChange = {
			path: 'newFile.ts',
			changeType: 'added',
			dataType: 'File',
		};

		await registeredHandlers[COMMANDS.openChange](uri, change);
		expect(window.showTextDocument).toHaveBeenCalledWith(uri);
		expect(commands.executeCommand).not.toHaveBeenCalled();
	});

	it('opens file directly for private files', async () => {
		const uri = Uri.file('/workspace/untracked.ts');
		const change: NormalizedChange = {
			path: 'untracked.ts',
			changeType: 'private',
			dataType: 'File',
		};

		await registeredHandlers[COMMANDS.openChange](uri, change);
		expect(window.showTextDocument).toHaveBeenCalledWith(uri);
	});

	it('opens diff for changed files with revisionGuid', async () => {
		const uri = Uri.file('/workspace/src/modified.ts');
		const change: NormalizedChange = {
			path: 'src/modified.ts',
			changeType: 'changed',
			dataType: 'File',
			revisionGuid: 'rev-abc-123',
		};

		await registeredHandlers[COMMANDS.openChange](uri, change);
		expect(commands.executeCommand).toHaveBeenCalledWith(
			'vscode.diff',
			expect.objectContaining({ scheme: 'plastic' }),
			uri,
			expect.stringContaining('modified.ts'),
		);
	});

	it('opens diff for changed files without revisionGuid (CLI fallback)', async () => {
		const uri = Uri.file('/workspace/src/modified.ts');
		const change: NormalizedChange = {
			path: 'src/modified.ts',
			changeType: 'changed',
			dataType: 'File',
			// no revisionGuid — CLI backend
		};

		await registeredHandlers[COMMANDS.openChange](uri, change);
		// Should still open diff, using path-based revSpec
		expect(commands.executeCommand).toHaveBeenCalledWith(
			'vscode.diff',
			expect.objectContaining({ scheme: 'plastic' }),
			uri,
			expect.stringContaining('modified.ts'),
		);
	});

	it('opens diff for checkedOut files', async () => {
		const uri = Uri.file('/workspace/src/checkout.ts');
		const change: NormalizedChange = {
			path: 'src/checkout.ts',
			changeType: 'checkedOut',
			dataType: 'File',
		};

		await registeredHandlers[COMMANDS.openChange](uri, change);
		expect(commands.executeCommand).toHaveBeenCalledWith(
			'vscode.diff',
			expect.anything(),
			uri,
			expect.any(String),
		);
	});

	it('falls back to opening file when no change metadata', async () => {
		const uri = Uri.file('/workspace/src/file.ts');

		// Called with just URI (no NormalizedChange — legacy path)
		await registeredHandlers[COMMANDS.openChange](uri);
		expect(window.showTextDocument).toHaveBeenCalledWith(uri);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `<test command> -- test/unit/commands/general.test.ts`
Expected: FAIL — current `openChange` always calls `showTextDocument`, never `executeCommand('vscode.diff', ...)`.

**Step 3: Implement the openChange dispatch**

Replace the `openChange` handler in `src/commands/general.ts`:

```typescript
import * as vscode from 'vscode';
import type { PlasticScmProvider } from '../scm/plasticScmProvider';
import type { NormalizedChange } from '../core/types';
import { COMMANDS } from '../constants';
import { buildPlasticUri } from '../util/uri';
import { getWorkspaceGuid } from '../api/client';
import { getBackend } from '../core/backend';

/**
 * Change types that have a base revision and should open a diff.
 */
const DIFF_CHANGE_TYPES = new Set([
	'changed', 'checkedOut', 'replaced', 'moved', 'copied',
]);

export function registerGeneralCommands(
	context: vscode.ExtensionContext,
	provider: PlasticScmProvider,
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.refresh, async () => {
			await provider.refresh();
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.openFile, (uri: vscode.Uri) => {
			if (uri) {
				vscode.window.showTextDocument(uri);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			COMMANDS.openChange,
			async (uri: vscode.Uri, change?: NormalizedChange) => {
				if (!uri) return;

				// No change metadata or non-diffable type → just open the file
				if (!change || !DIFF_CHANGE_TYPES.has(change.changeType)) {
					vscode.window.showTextDocument(uri);
					return;
				}

				// Build the plastic: URI for the base revision
				const wsGuid = getWorkspaceGuid();
				const revSpec = change.revisionGuid ?? `serverpath:/${change.path}`;
				const originalUri = buildPlasticUri(wsGuid, revSpec, change.path);

				const fileName = change.path.split('/').pop() ?? change.path;
				const title = `${fileName} (Base ↔ Working)`;

				await vscode.commands.executeCommand('vscode.diff', originalUri, uri, title);
			},
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.revertChange, async (...resourceStates: vscode.SourceControlResourceState[]) => {
			const uris: vscode.Uri[] = [];
			for (const arg of resourceStates) {
				if (Array.isArray(arg)) {
					for (const item of arg) {
						if (item?.resourceUri) uris.push(item.resourceUri);
					}
				} else if (arg?.resourceUri) {
					uris.push(arg.resourceUri);
				}
			}

			if (uris.length === 0) return;

			const fileNames = uris.map(u => vscode.workspace.asRelativePath(u)).join(', ');
			const answer = await vscode.window.showWarningMessage(
				`Are you sure you want to revert ${uris.length} file(s)?\n${fileNames}`,
				{ modal: true },
				'Revert',
			);

			if (answer !== 'Revert') return;

			// Phase 3: implement actual revert via API
			vscode.window.showInformationMessage('Revert will be implemented in a future update.');
		}),
	);
}
```

**Step 4: Run test to verify it passes**

Run: `<test command> -- test/unit/commands/general.test.ts`
Expected: PASS

**Step 5: Run all tests**

Run: `<test command>`
Expected: All pass (existing tests unaffected).

---

### Task 3: Implement QuickDiffProvider with change map

The `PlasticQuickDiffProvider` needs to map workspace file URIs to `plastic:` URIs for inline gutter decorations. It requires a map of file paths → `NormalizedChange` maintained by the SCM provider.

**Files:**
- Modify: `src/scm/quickDiffProvider.ts`
- Create: `test/unit/scm/quickDiffProvider.test.ts`

**Context:**
- `provideOriginalResource(uri)` receives a workspace file URI and must return a `plastic:` URI
- The provider needs access to the current change map to look up revision info
- For added/private files, return `undefined` (no original)
- The change map is set by `PlasticScmProvider` after each poll

**Step 1: Write the test file**

Create `test/unit/scm/quickDiffProvider.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Uri } from '../../mocks/vscode';

vi.mock('../../../src/util/uri', () => ({
	buildPlasticUri: vi.fn((ws: string, rev: string, path: string) =>
		Uri.from({ scheme: 'plastic', authority: ws, path: `/${rev}/${path}` }),
	),
	parsePlasticUri: vi.fn((uri: any) => {
		if (uri.scheme !== 'plastic') return undefined;
		const parts = uri.path.split('/').filter(Boolean);
		return { workspaceGuid: uri.authority, revisionGuid: parts[0], filePath: parts.slice(1).join('/') };
	}),
}));

vi.mock('../../../src/core/workspace', () => ({
	fetchFileContent: vi.fn(),
}));

vi.mock('../../../src/util/logger', () => ({
	logError: vi.fn(),
}));

import { PlasticQuickDiffProvider } from '../../../src/scm/quickDiffProvider';
import type { NormalizedChange } from '../../../src/core/types';

describe('PlasticQuickDiffProvider', () => {
	let provider: PlasticQuickDiffProvider;

	beforeEach(() => {
		provider = new PlasticQuickDiffProvider('ws-guid-123');
	});

	it('returns undefined when no changes are set', () => {
		const uri = Uri.file('/workspace/src/foo.ts');
		expect(provider.provideOriginalResource(uri as any)).toBeUndefined();
	});

	it('returns undefined for added files', () => {
		provider.updateChanges([
			{ path: 'src/foo.ts', changeType: 'added', dataType: 'File' },
		], '/workspace');

		const uri = Uri.file('/workspace/src/foo.ts');
		expect(provider.provideOriginalResource(uri as any)).toBeUndefined();
	});

	it('returns undefined for private files', () => {
		provider.updateChanges([
			{ path: 'src/foo.ts', changeType: 'private', dataType: 'File' },
		], '/workspace');

		const uri = Uri.file('/workspace/src/foo.ts');
		expect(provider.provideOriginalResource(uri as any)).toBeUndefined();
	});

	it('returns plastic: URI for changed files with revisionGuid', () => {
		provider.updateChanges([
			{ path: 'src/foo.ts', changeType: 'changed', dataType: 'File', revisionGuid: 'rev-abc' },
		], '/workspace');

		const uri = Uri.file('/workspace/src/foo.ts');
		const result = provider.provideOriginalResource(uri as any);
		expect(result).toBeDefined();
		expect(result!.scheme).toBe('plastic');
	});

	it('returns plastic: URI for changed files without revisionGuid (CLI fallback)', () => {
		provider.updateChanges([
			{ path: 'src/foo.ts', changeType: 'changed', dataType: 'File' },
		], '/workspace');

		const uri = Uri.file('/workspace/src/foo.ts');
		const result = provider.provideOriginalResource(uri as any);
		expect(result).toBeDefined();
		expect(result!.scheme).toBe('plastic');
	});

	it('returns plastic: URI for checkedOut files', () => {
		provider.updateChanges([
			{ path: 'src/foo.ts', changeType: 'checkedOut', dataType: 'File' },
		], '/workspace');

		const uri = Uri.file('/workspace/src/foo.ts');
		const result = provider.provideOriginalResource(uri as any);
		expect(result).toBeDefined();
	});

	it('clears change map on empty update', () => {
		provider.updateChanges([
			{ path: 'src/foo.ts', changeType: 'changed', dataType: 'File' },
		], '/workspace');
		provider.updateChanges([], '/workspace');

		const uri = Uri.file('/workspace/src/foo.ts');
		expect(provider.provideOriginalResource(uri as any)).toBeUndefined();
	});
});
```

**Step 2: Run test to verify it fails**

Run: `<test command> -- test/unit/scm/quickDiffProvider.test.ts`
Expected: FAIL — `PlasticQuickDiffProvider` constructor doesn't accept `workspaceGuid`, no `updateChanges` method.

**Step 3: Implement the QuickDiffProvider**

Replace `src/scm/quickDiffProvider.ts`:

```typescript
import * as vscode from 'vscode';
import { PLASTIC_URI_SCHEME } from '../constants';
import { buildPlasticUri, parsePlasticUri } from '../util/uri';
import { fetchFileContent } from '../core/workspace';
import { logError } from '../util/logger';
import type { NormalizedChange } from '../core/types';

/**
 * Change types that have a base revision (diffable).
 */
const DIFF_CHANGE_TYPES = new Set([
	'changed', 'checkedOut', 'replaced', 'moved', 'copied',
]);

/**
 * QuickDiffProvider for Plastic SCM — supplies the original file URI for inline diffs.
 */
export class PlasticQuickDiffProvider implements vscode.QuickDiffProvider {
	private changeMap = new Map<string, NormalizedChange>();
	private workspaceRootPath = '';

	constructor(private readonly workspaceGuid: string) {}

	/**
	 * Update the internal change map after a status poll.
	 */
	updateChanges(changes: NormalizedChange[], workspaceRoot: string): void {
		this.workspaceRootPath = workspaceRoot;
		this.changeMap.clear();
		for (const change of changes) {
			this.changeMap.set(change.path, change);
		}
	}

	provideOriginalResource(uri: vscode.Uri): vscode.Uri | undefined {
		// Extract relative path from workspace URI
		const uriPath = uri.fsPath.replace(/\\/g, '/');
		const rootPath = this.workspaceRootPath.replace(/\\/g, '/');
		let relativePath = uriPath;
		if (rootPath && uriPath.startsWith(rootPath)) {
			relativePath = uriPath.substring(rootPath.length);
			if (relativePath.startsWith('/')) {
				relativePath = relativePath.substring(1);
			}
		}

		const change = this.changeMap.get(relativePath);
		if (!change || !DIFF_CHANGE_TYPES.has(change.changeType)) {
			return undefined;
		}

		const revSpec = change.revisionGuid ?? `serverpath:/${change.path}`;
		return buildPlasticUri(this.workspaceGuid, revSpec, change.path);
	}
}

/**
 * TextDocumentContentProvider for the plastic: URI scheme.
 * Fetches file content from the Plastic SCM server for diff views.
 */
export class PlasticContentProvider implements vscode.TextDocumentContentProvider {
	private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
	public readonly onDidChange = this.onDidChangeEmitter.event;

	async provideTextDocumentContent(uri: vscode.Uri): Promise<string | undefined> {
		const parsed = parsePlasticUri(uri);
		if (!parsed) return undefined;

		try {
			const content = await fetchFileContent(parsed.revisionGuid);
			if (!content) return '';

			const decoder = new TextDecoder('utf-8');
			return decoder.decode(content);
		} catch (err) {
			logError(`Failed to fetch content for ${uri.toString()}`, err);
			return '';
		}
	}

	dispose(): void {
		this.onDidChangeEmitter.dispose();
	}
}
```

**Step 4: Run test to verify it passes**

Run: `<test command> -- test/unit/scm/quickDiffProvider.test.ts`
Expected: PASS

---

### Task 4: Wire QuickDiffProvider into PlasticScmProvider

Update `PlasticScmProvider` to pass the `workspaceGuid` to `PlasticQuickDiffProvider` and call `updateChanges()` after each poll.

**Files:**
- Modify: `src/scm/plasticScmProvider.ts`
- Test: `test/unit/scm/plasticScmProvider.test.ts`

**Context:**
- `PlasticScmProvider` constructor creates `PlasticQuickDiffProvider` at line 59
- `pollStatus()` updates `this.currentChanges` at line 163
- The provider needs `workspaceGuid` from `getWorkspaceGuid()` in `src/api/client.ts`
- The `PlasticQuickDiffProvider` constructor now requires `workspaceGuid`

**Step 1: Add test for quickDiffProvider receiving changes**

Add to `test/unit/scm/plasticScmProvider.test.ts`:

```typescript
it('updates quickDiffProvider after refresh', async () => {
	mockFetchStatus.mockResolvedValue({
		changes: [
			{ path: '/src/a.ts', changeType: 'changed', dataType: 'File' },
		],
	});

	await provider.refresh();

	// The quickDiffProvider should have received the changes
	// We verify indirectly: the provider should not throw
	expect(provider.getAllChanges()).toHaveLength(1);
});
```

**Step 2: Update PlasticScmProvider**

In `src/scm/plasticScmProvider.ts`:

1. Import `getWorkspaceGuid`:
```typescript
import { getWorkspaceGuid } from '../api/client';
```

2. Update the QuickDiffProvider construction (around line 59):
```typescript
private readonly quickDiffProvider: PlasticQuickDiffProvider;

// In constructor:
this.quickDiffProvider = new PlasticQuickDiffProvider(getWorkspaceGuid());
this.sourceControl.quickDiffProvider = this.quickDiffProvider;
```

3. In `pollStatus()`, after setting `this.currentChanges` (after line 163), add:
```typescript
this.quickDiffProvider.updateChanges(this.currentChanges, this.workspaceRoot.fsPath);
```

**Step 3: Update test mocks**

Add to the mock setup in `test/unit/scm/plasticScmProvider.test.ts`:

```typescript
vi.mock('../../../src/api/client', () => ({
	getWorkspaceGuid: vi.fn(() => 'test-ws-guid'),
}));
```

**Step 4: Run tests**

Run: `<test command> -- test/unit/scm/plasticScmProvider.test.ts`
Expected: PASS

---

### Task 5: Branch polling in PlasticScmProvider

Add branch polling to `pollStatus()` so external branch switches are detected.

**Files:**
- Modify: `src/scm/plasticScmProvider.ts`
- Modify: `test/unit/scm/plasticScmProvider.test.ts`

**Context:**
- `getCurrentBranch()` from `src/core/workspace.ts` returns the current branch name
- `PlasticStatusBar` currently calls `getCurrentBranch()` once in its constructor
- We need a `onDidChangeBranch` event that fires when the branch changes
- `PlasticStatusBar` will subscribe to this event (Task 6)
- The provider should expose `getCurrentBranchName()` for initial reads

**Step 1: Add tests**

Add to `test/unit/scm/plasticScmProvider.test.ts`:

```typescript
vi.mock('../../../src/core/workspace', () => ({
	fetchWorkspaceStatus: vi.fn(),
	getCurrentBranch: vi.fn(),
}));

import { getCurrentBranch } from '../../../src/core/workspace';
const mockGetCurrentBranch = vi.mocked(getCurrentBranch);
```

Update the `beforeEach` to also mock the branch:
```typescript
mockGetCurrentBranch.mockResolvedValue('/main');
```

Add test cases:

```typescript
describe('branch polling', () => {
	it('fires onDidChangeBranch when branch changes', async () => {
		mockFetchStatus.mockResolvedValue({ changes: [] });
		mockGetCurrentBranch.mockResolvedValue('/main');

		const listener = vi.fn();
		provider.onDidChangeBranch(listener);

		await provider.refresh();
		expect(listener).not.toHaveBeenCalled(); // first poll sets baseline

		mockGetCurrentBranch.mockResolvedValue('/main/feature');
		await provider.refresh();
		expect(listener).toHaveBeenCalledWith('/main/feature');
	});

	it('does not fire onDidChangeBranch when branch stays the same', async () => {
		mockFetchStatus.mockResolvedValue({ changes: [] });
		mockGetCurrentBranch.mockResolvedValue('/main');

		const listener = vi.fn();
		provider.onDidChangeBranch(listener);

		await provider.refresh();
		await provider.refresh();
		expect(listener).not.toHaveBeenCalled();
	});

	it('exposes current branch name after refresh', async () => {
		mockFetchStatus.mockResolvedValue({ changes: [] });
		mockGetCurrentBranch.mockResolvedValue('/main/feature');

		await provider.refresh();
		expect(provider.getCurrentBranchName()).toBe('/main/feature');
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `<test command> -- test/unit/scm/plasticScmProvider.test.ts`
Expected: FAIL — `onDidChangeBranch` and `getCurrentBranchName()` don't exist.

**Step 3: Implement branch polling**

In `src/scm/plasticScmProvider.ts`:

1. Add branch tracking fields:
```typescript
private currentBranch: string | undefined;
private readonly onDidChangeBranchEmitter = new vscode.EventEmitter<string>();
public readonly onDidChangeBranch = this.onDidChangeBranchEmitter.event;
```

2. Add to constructor disposables:
```typescript
this.disposables.add(this.onDidChangeBranchEmitter);
```

3. Add public accessor:
```typescript
getCurrentBranchName(): string | undefined {
	return this.currentBranch;
}
```

4. In `pollStatus()`, after the successful status fetch, add branch check:
```typescript
// Poll branch
try {
	const branch = await getCurrentBranch();
	if (branch !== undefined && branch !== this.currentBranch) {
		const isFirstPoll = this.currentBranch === undefined;
		this.currentBranch = branch;
		if (!isFirstPoll) {
			this.onDidChangeBranchEmitter.fire(branch);
		}
	}
} catch {
	// Branch poll failure is non-critical, skip
}
```

5. Add import for `getCurrentBranch`:
```typescript
import { fetchWorkspaceStatus, getCurrentBranch } from '../core/workspace';
```

**Step 4: Run tests to verify they pass**

Run: `<test command> -- test/unit/scm/plasticScmProvider.test.ts`
Expected: PASS

---

### Task 6: Update PlasticStatusBar to subscribe to branch changes

Replace the one-shot branch update with subscription to `onDidChangeBranch` and poll-driven updates.

**Files:**
- Modify: `src/statusBar/plasticStatusBar.ts`
- Modify: `test/unit/statusBar/plasticStatusBar.test.ts`

**Context:**
- Currently `PlasticStatusBar.update()` calls `getCurrentBranch()` once
- After this change, it should:
  1. Still do the initial branch fetch in `update()`
  2. Subscribe to `provider.onDidChangeBranch` to update on external switches
  3. Also call `updateBranch()` on every `onDidChangeStatus` (piggyback on existing listener)

**Step 1: Add test**

Add to `test/unit/statusBar/plasticStatusBar.test.ts` (update the mock provider):

```typescript
function createMockProvider() {
	const statusEmitter = new EventEmitter<void>();
	const branchEmitter = new EventEmitter<string>();
	return {
		onDidChangeStatus: statusEmitter.event,
		onDidChangeBranch: branchEmitter.event,
		getPendingCount: vi.fn(() => 0),
		getStagedCount: vi.fn(() => 0),
		getCurrentBranchName: vi.fn(() => undefined as string | undefined),
		_fireStatusChange: () => statusEmitter.fire(),
		_fireBranchChange: (branch: string) => branchEmitter.fire(branch),
	};
}
```

Add test cases:

```typescript
it('updates branch on branch change event', () => {
	provider._fireBranchChange('/main/newBranch');

	const branchItem = window.createStatusBarItem.mock.results[0].value;
	expect(branchItem.text).toContain('/main/newBranch');
});

it('updates branch on status change event', async () => {
	provider.getCurrentBranchName.mockReturnValue('/main/updated');
	provider._fireStatusChange();

	const branchItem = window.createStatusBarItem.mock.results[0].value;
	expect(branchItem.text).toContain('/main/updated');
});
```

**Step 2: Run tests to verify they fail**

Run: `<test command> -- test/unit/statusBar/plasticStatusBar.test.ts`
Expected: FAIL — `onDidChangeBranch` not on mock provider.

**Step 3: Update PlasticStatusBar**

In `src/statusBar/plasticStatusBar.ts`:

```typescript
import * as vscode from 'vscode';
import type { PlasticScmProvider } from '../scm/plasticScmProvider';
import { getCurrentBranch } from '../core/workspace';
import { COMMANDS } from '../constants';
import { logError } from '../util/logger';

export class PlasticStatusBar implements vscode.Disposable {
	private readonly branchItem: vscode.StatusBarItem;
	private readonly changesItem: vscode.StatusBarItem;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly provider: PlasticScmProvider) {
		this.branchItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
		this.branchItem.command = COMMANDS.switchBranch;
		this.branchItem.tooltip = 'Plastic SCM: Current Branch (click to switch)';

		this.changesItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
		this.changesItem.command = COMMANDS.refresh;
		this.changesItem.tooltip = 'Plastic SCM: Pending Changes (click to refresh)';

		// Update changes and branch on status poll
		this.disposables.push(
			provider.onDidChangeStatus(() => {
				this.updateChanges();
				this.updateBranchFromProvider();
			}),
		);

		// Update branch on external branch switch
		this.disposables.push(
			provider.onDidChangeBranch((branch) => {
				this.setBranchText(branch);
			}),
		);

		this.branchItem.show();
		this.changesItem.show();

		// Initial update
		this.update();
	}

	async update(): Promise<void> {
		await this.updateBranch();
		this.updateChanges();
	}

	private async updateBranch(): Promise<void> {
		try {
			const branch = await getCurrentBranch();
			this.setBranchText(branch);
		} catch (err) {
			this.setBranchText(undefined);
			logError('Failed to get current branch', err);
		}
	}

	private updateBranchFromProvider(): void {
		const branch = this.provider.getCurrentBranchName();
		if (branch !== undefined) {
			this.setBranchText(branch);
		}
	}

	private setBranchText(branch: string | undefined): void {
		if (branch) {
			this.branchItem.text = `$(source-control) ${branch}`;
		} else {
			this.branchItem.text = '$(source-control) Plastic SCM';
		}
	}

	private updateChanges(): void {
		const total = this.provider.getPendingCount();
		const staged = this.provider.getStagedCount();

		if (total === 0) {
			this.changesItem.text = '$(check) No changes';
		} else if (staged > 0) {
			this.changesItem.text = `$(git-commit) ${staged}/${total} staged`;
		} else {
			this.changesItem.text = `$(edit) ${total} change${total !== 1 ? 's' : ''}`;
		}
	}

	dispose(): void {
		this.branchItem.dispose();
		this.changesItem.dispose();
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
```

**Step 4: Run tests**

Run: `<test command> -- test/unit/statusBar/plasticStatusBar.test.ts`
Expected: PASS

---

### Task 7: Add "Go to File" button in diff editor title bar

Add `plasticScm.openFile` to the `editor/title` menu in `package.json` so it appears in the diff editor toolbar.

**Files:**
- Modify: `package.json` (menus.editor/title section)

**Step 1: Update package.json**

In the `"editor/title"` section of `package.json`, add the `openFile` command:

```json
"editor/title": [
  {
    "command": "plasticScm.openFile",
    "when": "isInDiffEditor && resourceScheme == file && plasticScm.isActive",
    "group": "navigation"
  },
  {
    "command": "plasticScm.showFileHistory",
    "when": "plasticScm.isActive",
    "group": "navigation"
  },
  {
    "command": "plasticScm.annotateFile",
    "when": "plasticScm.isActive",
    "group": "navigation"
  }
]
```

The `when` clause `isInDiffEditor && resourceScheme == file` ensures the button only appears in diff views for workspace files (not for the `plastic:` side).

**Step 2: Verify type-check passes**

Run: `<type-check command>`
Expected: 0 errors

---

### Task 8: Full integration verification

Run the complete test suite and type-check to verify everything works together.

**Step 1: Run all tests**

Run: `<test command>`
Expected: All tests pass (120 existing + new tests from this phase).

**Step 2: Run type-check**

Run: `<type-check command>`
Expected: 0 errors

**Step 3: Manual verification checklist**
- [ ] Click an added file → opens the file
- [ ] Click a modified file → opens side-by-side diff
- [ ] "Go to File" button visible in diff editor title bar
- [ ] Branch changes in Plastic GUI reflected in VS Code status bar after next poll
- [ ] Private files → open file directly (no diff)
