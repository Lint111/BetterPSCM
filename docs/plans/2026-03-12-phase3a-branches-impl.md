# Phase 3a: Branch Tree + Operations — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Activity bar panel showing branches with current branch indicator, plus create/switch/delete branch commands.

**Architecture:** Extend `PlasticBackend` interface with branch operations, implement in both REST and CLI backends, create a `TreeDataProvider` for the branches view, and register branch commands. Uses V1 REST endpoints (simple, sufficient for CRUD).

**Tech Stack:** VS Code Tree View API, Vitest, existing `PlasticBackend` dual-backend pattern.

**Run commands from WSL:**
- Tests: `/mnt/c/nvm4w/nodejs/node.exe C:/GitHub/BetterSCM/node_modules/vitest/vitest.mjs run --config C:/GitHub/BetterSCM/vitest.config.ts --root C:/GitHub/BetterSCM`
- Type-check: `/mnt/c/nvm4w/nodejs/node.exe C:/GitHub/BetterSCM/node_modules/typescript/bin/tsc --noEmit --project C:/GitHub/BetterSCM/tsconfig.json`

**VS Code mock location:** `test/mocks/vscode.ts`

---

### Task 1: Add BranchInfo type and backend interface methods

Add the `BranchInfo` result type and 4 branch methods to the `PlasticBackend` interface.

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/backend.ts`
- Modify: `test/unit/core/backend.test.ts`

**Step 1: Add BranchInfo to types.ts**

Add after `CheckinResult` (around line 63):

```typescript
export interface BranchInfo {
	id: number;
	name: string;
	owner: string;
	date: string;
	comment?: string;
	isMain: boolean;
	headChangeset?: number;
	changesetsCount?: number;
}
```

**Step 2: Add branch methods to PlasticBackend interface**

In `src/core/backend.ts`, add to the `PlasticBackend` interface:

```typescript
// Phase 3a: Branch operations
listBranches(): Promise<BranchInfo[]>;
createBranch(name: string, comment?: string): Promise<BranchInfo>;
deleteBranch(branchId: number): Promise<void>;
switchBranch(branchName: string): Promise<void>;
```

Import `BranchInfo` from `./types`.

**Step 3: Update backend.test.ts**

The backend singleton tests use a mock object — add stub methods to the mock so it satisfies the interface:

```typescript
const mockBackend = {
	name: 'mock',
	getStatus: vi.fn(),
	getCurrentBranch: vi.fn(),
	checkin: vi.fn(),
	getFileContent: vi.fn(),
	listBranches: vi.fn(),
	createBranch: vi.fn(),
	deleteBranch: vi.fn(),
	switchBranch: vi.fn(),
};
```

**Step 4: Run tests to verify**

Run: `<test command>`
Expected: All pass. The test just needs the mock to have the right shape.

---

### Task 2: Implement RestBackend branch operations

Add the 4 branch methods to `RestBackend`.

**Files:**
- Modify: `src/core/backendRest.ts`
- Modify: `test/unit/core/backendRest.test.ts`

**Context:**

API endpoints used:
- `GET /api/v1/organizations/{orgName}/repos/{repoName}/branches` → `BranchModel[]`
- `POST /api/v1/organizations/{orgName}/repos/{repoName}/branches` with `{ name, changeset, comment? }` → `BranchModel`
- `DELETE /api/v2/organizations/{orgName}/repositories/{repoName}/branches/{branchId}` → 204
- `POST /api/v1/organizations/{organizationName}/workspaces/{workspaceGuid}/update` → 200

Client helpers: `getClient()`, `getOrgName()`, `getRepoName()`, `getWorkspaceGuid()` — all from `../api/client`.

**BranchModel schema** (from generated types):
```typescript
{
	id?: number;
	name?: string;
	owner?: string;
	date?: string;         // ISO 8601
	comment?: string | null;
	isMain?: boolean;
	headChangeset?: number;
	changesetsCount?: number;
	// ... more fields we don't need
}
```

**Step 1: Write tests**

Add to `test/unit/core/backendRest.test.ts`:

```typescript
describe('listBranches', () => {
	it('returns mapped branch list', async () => {
		mockClient.GET.mockResolvedValue({
			data: [
				{ id: 1, name: '/main', owner: 'user@test.com', date: '2026-01-01T00:00:00Z', isMain: true, headChangeset: 10, changesetsCount: 5 },
				{ id: 2, name: '/main/feature', owner: 'dev@test.com', date: '2026-03-01T00:00:00Z', isMain: false },
			],
			error: undefined,
		});

		const branches = await backend.listBranches();
		expect(branches).toHaveLength(2);
		expect(branches[0].name).toBe('/main');
		expect(branches[0].isMain).toBe(true);
		expect(branches[1].name).toBe('/main/feature');
	});

	it('throws on API error', async () => {
		mockClient.GET.mockResolvedValue({ data: undefined, error: { message: 'fail' } });
		await expect(backend.listBranches()).rejects.toThrow();
	});
});

describe('createBranch', () => {
	it('creates branch and returns info', async () => {
		// First call: GET main-branch to get head changeset
		mockClient.GET.mockResolvedValueOnce({
			data: { id: 1, name: '/main', headChangeset: 42 },
			error: undefined,
		});
		// Second call: POST create branch
		mockClient.POST.mockResolvedValueOnce({
			data: { id: 3, name: '/main/newBranch', owner: 'user@test.com', date: '2026-03-12T00:00:00Z', isMain: false },
			error: undefined,
		});

		const branch = await backend.createBranch('/main/newBranch', 'my comment');
		expect(branch.name).toBe('/main/newBranch');
		expect(mockClient.POST).toHaveBeenCalled();
	});
});

describe('deleteBranch', () => {
	it('calls DELETE endpoint', async () => {
		mockClient.DELETE.mockResolvedValue({ error: undefined });

		await backend.deleteBranch(5);
		expect(mockClient.DELETE).toHaveBeenCalled();
	});

	it('throws on error', async () => {
		mockClient.DELETE.mockResolvedValue({ error: { message: 'not found' } });
		await expect(backend.deleteBranch(99)).rejects.toThrow();
	});
});

describe('switchBranch', () => {
	it('calls POST update endpoint', async () => {
		mockClient.POST.mockResolvedValue({ error: undefined });

		await backend.switchBranch('/main/feature');
		expect(mockClient.POST).toHaveBeenCalled();
	});
});
```

Note: The mock client in the existing test file needs `DELETE` added. Check how the mock is set up and add `DELETE: vi.fn()` alongside `GET` and `POST`.

**Step 2: Implement RestBackend methods**

```typescript
import { getClient, getOrgName, getRepoName, getWorkspaceGuid } from '../api/client';
import type { BranchInfo } from './types';

// Add to RestBackend class:

async listBranches(): Promise<BranchInfo[]> {
	const client = getClient();
	const orgName = getOrgName();
	const repoName = getRepoName();

	const { data, error } = await client.GET(
		'/api/v1/organizations/{orgName}/repos/{repoName}/branches',
		{ params: { path: { orgName: orgName, repoName } } },
	);

	if (error) throw error;

	return (data ?? []).map(b => ({
		id: b.id ?? 0,
		name: b.name ?? '',
		owner: b.owner ?? '',
		date: b.date ?? '',
		comment: b.comment ?? undefined,
		isMain: b.isMain ?? false,
		headChangeset: b.headChangeset ?? undefined,
		changesetsCount: b.changesetsCount ?? undefined,
	}));
}

async createBranch(name: string, comment?: string): Promise<BranchInfo> {
	const client = getClient();
	const orgName = getOrgName();
	const repoName = getRepoName();

	// Get head changeset of main branch to create from
	const { data: mainBranch, error: mainErr } = await client.GET(
		'/api/v1/organizations/{orgName}/repos/{repoName}/main-branch',
		{ params: { path: { orgName: orgName, repoName } } },
	);

	if (mainErr) throw mainErr;
	const changeset = mainBranch?.headChangeset ?? 0;

	const { data, error } = await client.POST(
		'/api/v1/organizations/{orgName}/repos/{repoName}/branches',
		{
			params: { path: { orgName: orgName, repoName } },
			body: { name, changeset, comment: comment ?? null } as any,
		},
	);

	if (error) throw error;

	return {
		id: (data as any)?.id ?? 0,
		name: (data as any)?.name ?? name,
		owner: (data as any)?.owner ?? '',
		date: (data as any)?.date ?? new Date().toISOString(),
		comment: comment ?? undefined,
		isMain: false,
	};
}

async deleteBranch(branchId: number): Promise<void> {
	const client = getClient();
	const orgName = getOrgName();
	const repoName = getRepoName();

	const { error } = await client.DELETE(
		'/api/v2/organizations/{orgName}/repositories/{repoName}/branches/{branchId}',
		{ params: { path: { orgName: orgName, repoName, branchId } } },
	);

	if (error) throw error;
}

async switchBranch(branchName: string): Promise<void> {
	const client = getClient();
	const orgName = getOrgName();
	const workspaceGuid = getWorkspaceGuid();

	const { error } = await client.POST(
		'/api/v1/organizations/{organizationName}/workspaces/{workspaceGuid}/update',
		{
			params: { path: { organizationName: orgName, workspaceGuid } },
		},
	);

	if (error) throw error;
}
```

**Step 3: Run tests**

Run: `<test command>`
Expected: All pass.

---

### Task 3: Implement CliBackend branch operations

Add the 4 branch methods to `CliBackend`.

**Files:**
- Modify: `src/core/backendCli.ts`
- Modify: `test/unit/core/backendCli.test.ts`

**Context:**

CLI commands:
- `cm find branch --format={name}#{id}#{owner}#{date}#{comment}#{ismainbranch}` — list branches
- `cm branch create /main/newBranch` — create branch (from current changeset)
- `cm branch delete /main/oldBranch` — delete branch
- `cm switch br:/main/feature` — switch workspace to branch

The existing test file mocks `execCm` via `vi.mock('../../../src/core/cmCli', ...)`.

**Step 1: Write tests**

Add to `test/unit/core/backendCli.test.ts`:

```typescript
describe('listBranches', () => {
	it('parses branch list', async () => {
		mockExecCm.mockResolvedValue({
			exitCode: 0,
			stdout: '/main#1#user@test.com#2026-01-01T00:00:00#Initial branch#True\n/main/feature#2#dev@test.com#2026-03-01T00:00:00##False\n',
			stderr: '',
		});

		const branches = await backend.listBranches();
		expect(branches).toHaveLength(2);
		expect(branches[0].name).toBe('/main');
		expect(branches[0].isMain).toBe(true);
		expect(branches[1].name).toBe('/main/feature');
		expect(branches[1].isMain).toBe(false);
	});

	it('throws on error', async () => {
		mockExecCm.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'error' });
		await expect(backend.listBranches()).rejects.toThrow();
	});
});

describe('createBranch', () => {
	it('creates branch', async () => {
		mockExecCm.mockResolvedValue({
			exitCode: 0,
			stdout: 'Branch /main/newBranch created.',
			stderr: '',
		});

		const branch = await backend.createBranch('/main/newBranch');
		expect(branch.name).toBe('/main/newBranch');
		expect(mockExecCm).toHaveBeenCalledWith(expect.arrayContaining(['branch', 'create', '/main/newBranch']));
	});
});

describe('deleteBranch', () => {
	it('deletes branch', async () => {
		// First list to resolve name from ID
		mockExecCm.mockResolvedValue({
			exitCode: 0,
			stdout: '',
			stderr: '',
		});

		await backend.deleteBranch(5);
		expect(mockExecCm).toHaveBeenCalled();
	});
});

describe('switchBranch', () => {
	it('switches branch', async () => {
		mockExecCm.mockResolvedValue({
			exitCode: 0,
			stdout: 'Switched to branch /main/feature',
			stderr: '',
		});

		await backend.switchBranch('/main/feature');
		expect(mockExecCm).toHaveBeenCalledWith(expect.arrayContaining(['switch', 'br:/main/feature']));
	});

	it('throws on error', async () => {
		mockExecCm.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'merge needed' });
		await expect(backend.switchBranch('/main/conflict')).rejects.toThrow();
	});
});
```

**Step 2: Implement CliBackend methods**

```typescript
import type { BranchInfo } from './types';

// Add to CliBackend class:

async listBranches(): Promise<BranchInfo[]> {
	const result = await execCm([
		'find', 'branch',
		'--format={name}#{id}#{owner}#{date}#{comment}#{ismainbranch}',
		'--nototal',
	]);
	if (result.exitCode !== 0) {
		throw new Error(`cm find branch failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
	}

	const lines = result.stdout.split(/\r?\n/).filter(l => l.length > 0);
	return lines.map(parseBranchLine).filter((b): b is BranchInfo => b !== null);
}

async createBranch(name: string, comment?: string): Promise<BranchInfo> {
	const args = ['branch', 'create', name];
	if (comment) args.push(`-c=${comment}`);

	const result = await execCm(args);
	if (result.exitCode !== 0) {
		throw new Error(`cm branch create failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
	}

	return {
		id: 0,
		name,
		owner: '',
		date: new Date().toISOString(),
		isMain: false,
	};
}

async deleteBranch(branchId: number): Promise<void> {
	// CLI uses branch name, not ID. We pass the ID as a string — cm accepts it.
	const result = await execCm(['branch', 'delete', String(branchId)]);
	if (result.exitCode !== 0) {
		throw new Error(`cm branch delete failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
	}
}

async switchBranch(branchName: string): Promise<void> {
	const result = await execCm(['switch', `br:${branchName}`]);
	if (result.exitCode !== 0) {
		throw new Error(`cm switch failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
	}
}
```

Add parser function:

```typescript
function parseBranchLine(line: string): BranchInfo | null {
	const parts = line.split('#');
	if (parts.length < 6) return null;

	return {
		name: parts[0],
		id: parseInt(parts[1], 10) || 0,
		owner: parts[2],
		date: parts[3],
		comment: parts[4] || undefined,
		isMain: parts[5].toLowerCase() === 'true',
	};
}
```

**Step 3: Run tests**

Run: `<test command>`
Expected: All pass.

---

### Task 4: Add workspace facade functions for branch ops

Add thin facade functions in `workspace.ts` matching the pattern of existing functions.

**Files:**
- Modify: `src/core/workspace.ts`
- Modify: `test/unit/core/workspace.test.ts`

**Step 1: Add facade functions**

```typescript
import type { StatusResult, CheckinResult, BranchInfo } from './types';

export async function listBranches(): Promise<BranchInfo[]> {
	return getBackend().listBranches();
}

export async function createBranch(name: string, comment?: string): Promise<BranchInfo> {
	return getBackend().createBranch(name, comment);
}

export async function deleteBranch(branchId: number): Promise<void> {
	return getBackend().deleteBranch(branchId);
}

export async function switchBranch(branchName: string): Promise<void> {
	return getBackend().switchBranch(branchName);
}
```

**Step 2: Add tests**

Add to `test/unit/core/workspace.test.ts`:

```typescript
import { listBranches, createBranch, deleteBranch, switchBranch } from '../../../src/core/workspace';

it('listBranches delegates to backend', async () => {
	mockBackend.listBranches.mockResolvedValue([{ id: 1, name: '/main', owner: '', date: '', isMain: true }]);
	const result = await listBranches();
	expect(result).toHaveLength(1);
});

it('switchBranch delegates to backend', async () => {
	mockBackend.switchBranch.mockResolvedValue(undefined);
	await switchBranch('/main/feature');
	expect(mockBackend.switchBranch).toHaveBeenCalledWith('/main/feature');
});
```

Note: The workspace test mocks the backend — add `listBranches`, `createBranch`, `deleteBranch`, `switchBranch` to the mock.

**Step 3: Run tests**

Run: `<test command>`
Expected: All pass.

---

### Task 5: Create BranchesTreeProvider

Create the tree data provider for the branches activity bar view.

**Files:**
- Create: `src/views/branchesTreeProvider.ts`
- Create: `test/unit/views/branchesTreeProvider.test.ts`

**Context:**

- `vscode.TreeDataProvider<BranchTreeItem>` interface: `getTreeItem(element)`, `getChildren(element?)`, `onDidChangeTreeData`
- `vscode.TreeItem` constructor takes `(label, collapsibleState)`
- Each branch item is a leaf (no children) — `TreeItemCollapsibleState.None`
- Current branch gets `$(check)` icon prefix and sorts first
- Tree provider needs access to `listBranches()` and `getCurrentBranch()` from workspace

**Step 1: Write tests**

Create `test/unit/views/branchesTreeProvider.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/core/workspace', () => ({
	listBranches: vi.fn(),
	getCurrentBranch: vi.fn(),
}));

import { BranchesTreeProvider } from '../../../src/views/branchesTreeProvider';
import { listBranches, getCurrentBranch } from '../../../src/core/workspace';
import type { BranchInfo } from '../../../src/core/types';

const mockListBranches = vi.mocked(listBranches);
const mockGetCurrentBranch = vi.mocked(getCurrentBranch);

describe('BranchesTreeProvider', () => {
	let provider: BranchesTreeProvider;

	beforeEach(() => {
		vi.clearAllMocks();
		provider = new BranchesTreeProvider();
	});

	it('returns branch items as children', async () => {
		mockListBranches.mockResolvedValue([
			{ id: 1, name: '/main', owner: 'user', date: '2026-01-01', isMain: true },
			{ id: 2, name: '/main/feature', owner: 'dev', date: '2026-03-01', isMain: false },
		]);
		mockGetCurrentBranch.mockResolvedValue('/main');

		const children = await provider.getChildren();
		expect(children).toHaveLength(2);
	});

	it('sorts current branch first', async () => {
		mockListBranches.mockResolvedValue([
			{ id: 2, name: '/main/feature', owner: 'dev', date: '2026-03-01', isMain: false },
			{ id: 1, name: '/main', owner: 'user', date: '2026-01-01', isMain: true },
		]);
		mockGetCurrentBranch.mockResolvedValue('/main');

		const children = await provider.getChildren();
		expect(children![0].branch.name).toBe('/main');
	});

	it('marks current branch with checkmark description', async () => {
		mockListBranches.mockResolvedValue([
			{ id: 1, name: '/main', owner: 'user', date: '2026-01-01', isMain: true },
		]);
		mockGetCurrentBranch.mockResolvedValue('/main');

		const children = await provider.getChildren();
		const item = provider.getTreeItem(children![0]);
		expect(item.description).toContain('current');
	});

	it('returns empty array on error', async () => {
		mockListBranches.mockRejectedValue(new Error('fail'));
		mockGetCurrentBranch.mockResolvedValue(undefined);

		const children = await provider.getChildren();
		expect(children).toEqual([]);
	});

	it('fires onDidChangeTreeData on refresh', () => {
		const listener = vi.fn();
		provider.onDidChangeTreeData(listener);
		provider.refresh();
		expect(listener).toHaveBeenCalled();
	});
});
```

**Step 2: Implement BranchesTreeProvider**

Create `src/views/branchesTreeProvider.ts`:

```typescript
import * as vscode from 'vscode';
import { listBranches, getCurrentBranch } from '../core/workspace';
import type { BranchInfo } from '../core/types';

export class BranchTreeItem {
	constructor(public readonly branch: BranchInfo) {}
}

export class BranchesTreeProvider implements vscode.TreeDataProvider<BranchTreeItem> {
	private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>();
	public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

	refresh(): void {
		this.onDidChangeTreeDataEmitter.fire();
	}

	getTreeItem(element: BranchTreeItem): vscode.TreeItem {
		const item = new vscode.TreeItem(element.branch.name, vscode.TreeItemCollapsibleState.None);
		item.description = element.branch.isCurrent
			? `${element.branch.owner} · current`
			: element.branch.owner;
		item.tooltip = [
			element.branch.name,
			`Owner: ${element.branch.owner}`,
			`Date: ${element.branch.date}`,
			element.branch.comment ? `Comment: ${element.branch.comment}` : '',
		].filter(Boolean).join('\n');
		item.contextValue = element.branch.isCurrent ? 'branch:current' : 'branch';
		item.iconPath = element.branch.isCurrent
			? new vscode.ThemeIcon('check')
			: new vscode.ThemeIcon('git-branch');
		return item;
	}

	async getChildren(element?: BranchTreeItem): Promise<BranchTreeItem[]> {
		if (element) return []; // Flat list, no nesting

		try {
			const [branches, currentBranch] = await Promise.all([
				listBranches(),
				getCurrentBranch(),
			]);

			// Sort: current branch first, then main, then alphabetical
			const sorted = branches.map(b => ({
				...b,
				isCurrent: b.name === currentBranch,
			})).sort((a, b) => {
				if (a.isCurrent && !b.isCurrent) return -1;
				if (!a.isCurrent && b.isCurrent) return 1;
				if (a.isMain && !b.isMain) return -1;
				if (!a.isMain && b.isMain) return 1;
				return a.name.localeCompare(b.name);
			});

			return sorted.map(b => new BranchTreeItem(b));
		} catch {
			return [];
		}
	}

	dispose(): void {
		this.onDidChangeTreeDataEmitter.dispose();
	}
}
```

Note: The `BranchTreeItem.branch` object gets an added `isCurrent` property at runtime. Update the type usage accordingly — either extend `BranchInfo` in the tree item or use `branch & { isCurrent: boolean }`.

**Step 3: Run tests**

Run: `<test command>`
Expected: All pass.

---

### Task 6: Create branch commands

Create `src/commands/branch.ts` with switch, create, and delete commands.

**Files:**
- Create: `src/commands/branch.ts`
- Create: `test/unit/commands/branch.test.ts`

**Context:**

- Commands are already registered as stubs in `extension.ts` (`registerStubCommands`)
- Command IDs: `COMMANDS.switchBranch`, `COMMANDS.createBranch`, `COMMANDS.deleteBranch`
- After switch: need to refresh the SCM provider, status bar, and branch tree
- `switchBranch` shows QuickPick with branch names
- `createBranch` shows InputBox for name
- `deleteBranch` shows confirm dialog; can't delete current branch

The function signature:
```typescript
export function registerBranchCommands(
	context: vscode.ExtensionContext,
	provider: PlasticScmProvider,
	branchTree: BranchesTreeProvider,
): void
```

**Step 1: Write tests**

Create `test/unit/commands/branch.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { window, commands } from '../../mocks/vscode';

vi.mock('../../../src/core/workspace', () => ({
	listBranches: vi.fn(),
	createBranch: vi.fn(),
	deleteBranch: vi.fn(),
	switchBranch: vi.fn(),
	getCurrentBranch: vi.fn(),
}));

import { registerBranchCommands } from '../../../src/commands/branch';
import { listBranches, createBranch, deleteBranch, switchBranch } from '../../../src/core/workspace';
import { COMMANDS } from '../../../src/constants';

const mockListBranches = vi.mocked(listBranches);
const mockCreateBranch = vi.mocked(createBranch);
const mockDeleteBranch = vi.mocked(deleteBranch);
const mockSwitchBranch = vi.mocked(switchBranch);

describe('branch commands', () => {
	let registeredHandlers: Record<string, Function>;
	let mockProvider: any;
	let mockBranchTree: any;

	beforeEach(() => {
		vi.clearAllMocks();
		registeredHandlers = {};

		commands.registerCommand.mockImplementation((cmd: string, handler: Function) => {
			registeredHandlers[cmd] = handler;
			return { dispose: vi.fn() };
		});

		mockProvider = {
			refresh: vi.fn().mockResolvedValue(undefined),
		};

		mockBranchTree = {
			refresh: vi.fn(),
		};

		registerBranchCommands(
			{ subscriptions: { push: vi.fn() } } as any,
			mockProvider as any,
			mockBranchTree as any,
		);
	});

	it('registers all three branch commands', () => {
		expect(registeredHandlers[COMMANDS.switchBranch]).toBeDefined();
		expect(registeredHandlers[COMMANDS.createBranch]).toBeDefined();
		expect(registeredHandlers[COMMANDS.deleteBranch]).toBeDefined();
	});

	describe('switchBranch', () => {
		it('shows QuickPick and switches', async () => {
			mockListBranches.mockResolvedValue([
				{ id: 1, name: '/main', owner: 'user', date: '', isMain: true },
				{ id: 2, name: '/main/feature', owner: 'dev', date: '', isMain: false },
			]);
			window.showQuickPick.mockResolvedValue({ label: '/main/feature' });

			await registeredHandlers[COMMANDS.switchBranch]();

			expect(mockSwitchBranch).toHaveBeenCalledWith('/main/feature');
			expect(mockProvider.refresh).toHaveBeenCalled();
			expect(mockBranchTree.refresh).toHaveBeenCalled();
		});

		it('does nothing when user cancels QuickPick', async () => {
			mockListBranches.mockResolvedValue([]);
			window.showQuickPick.mockResolvedValue(undefined);

			await registeredHandlers[COMMANDS.switchBranch]();
			expect(mockSwitchBranch).not.toHaveBeenCalled();
		});
	});

	describe('createBranch', () => {
		it('creates branch from input', async () => {
			window.showInputBox.mockResolvedValue('/main/newBranch');
			mockCreateBranch.mockResolvedValue({
				id: 3, name: '/main/newBranch', owner: '', date: '', isMain: false,
			});

			await registeredHandlers[COMMANDS.createBranch]();

			expect(mockCreateBranch).toHaveBeenCalledWith('/main/newBranch');
			expect(mockBranchTree.refresh).toHaveBeenCalled();
		});

		it('does nothing when user cancels input', async () => {
			window.showInputBox.mockResolvedValue(undefined);

			await registeredHandlers[COMMANDS.createBranch]();
			expect(mockCreateBranch).not.toHaveBeenCalled();
		});
	});

	describe('deleteBranch', () => {
		it('deletes branch after confirmation', async () => {
			window.showWarningMessage.mockResolvedValue('Delete');

			await registeredHandlers[COMMANDS.deleteBranch]({
				branch: { id: 5, name: '/main/old', isCurrent: false },
			});

			expect(mockDeleteBranch).toHaveBeenCalledWith(5);
			expect(mockBranchTree.refresh).toHaveBeenCalled();
		});

		it('does not delete current branch', async () => {
			await registeredHandlers[COMMANDS.deleteBranch]({
				branch: { id: 1, name: '/main', isCurrent: true },
			});

			expect(mockDeleteBranch).not.toHaveBeenCalled();
			expect(window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('Cannot delete'));
		});

		it('does nothing when user cancels', async () => {
			window.showWarningMessage.mockResolvedValue(undefined);

			await registeredHandlers[COMMANDS.deleteBranch]({
				branch: { id: 5, name: '/main/old', isCurrent: false },
			});

			expect(mockDeleteBranch).not.toHaveBeenCalled();
		});
	});
});
```

**Step 2: Implement branch commands**

Create `src/commands/branch.ts`:

```typescript
import * as vscode from 'vscode';
import type { PlasticScmProvider } from '../scm/plasticScmProvider';
import type { BranchesTreeProvider, BranchTreeItem } from '../views/branchesTreeProvider';
import { listBranches, createBranch, deleteBranch, switchBranch } from '../core/workspace';
import { COMMANDS } from '../constants';
import { logError } from '../util/logger';

export function registerBranchCommands(
	context: vscode.ExtensionContext,
	provider: PlasticScmProvider,
	branchTree: BranchesTreeProvider,
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.switchBranch, async () => {
			try {
				const branches = await listBranches();
				const items = branches.map(b => ({
					label: b.name,
					description: b.isMain ? 'main' : b.owner,
				}));

				const picked = await vscode.window.showQuickPick(items, {
					placeHolder: 'Select branch to switch to',
				});

				if (!picked) return;

				await switchBranch(picked.label);
				await provider.refresh();
				branchTree.refresh();

				vscode.window.showInformationMessage(`Switched to ${picked.label}`);
			} catch (err) {
				logError('Switch branch failed', err);
				vscode.window.showErrorMessage(
					`Failed to switch branch: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.createBranch, async () => {
			try {
				const name = await vscode.window.showInputBox({
					prompt: 'Enter new branch name',
					placeHolder: '/main/my-feature',
				});

				if (!name) return;

				await createBranch(name);
				branchTree.refresh();

				vscode.window.showInformationMessage(`Branch ${name} created`);
			} catch (err) {
				logError('Create branch failed', err);
				vscode.window.showErrorMessage(
					`Failed to create branch: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(COMMANDS.deleteBranch, async (item?: BranchTreeItem) => {
			if (!item?.branch) return;

			if (item.branch.isCurrent) {
				vscode.window.showWarningMessage('Cannot delete the current branch.');
				return;
			}

			const answer = await vscode.window.showWarningMessage(
				`Delete branch "${item.branch.name}"?`,
				{ modal: true },
				'Delete',
			);

			if (answer !== 'Delete') return;

			try {
				await deleteBranch(item.branch.id);
				branchTree.refresh();

				vscode.window.showInformationMessage(`Branch ${item.branch.name} deleted`);
			} catch (err) {
				logError('Delete branch failed', err);
				vscode.window.showErrorMessage(
					`Failed to delete branch: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}),
	);
}
```

**Step 3: Add QuickPick mock**

The VS Code mock at `test/mocks/vscode.ts` needs `window.showQuickPick` if not present. Check — it should already be there or can be added as `vi.fn()` in the test's `beforeEach`.

**Step 4: Run tests**

Run: `<test command>`
Expected: All pass.

---

### Task 7: Wire branch tree and commands into extension.ts

Update `extension.ts` to create the branch tree provider, register it, and register branch commands. Remove branch stubs from `registerStubCommands`.

**Files:**
- Modify: `src/extension.ts`

**Step 1: Update imports**

```typescript
import { BranchesTreeProvider } from './views/branchesTreeProvider';
import { registerBranchCommands } from './commands/branch';
```

**Step 2: In setupProvider(), after creating the SCM provider:**

```typescript
// Create branch tree view
const branchTree = disposables.add(new BranchesTreeProvider());
vscode.window.registerTreeDataProvider('plasticScm.branchesView', branchTree);

// Register branch commands
registerBranchCommands(context, provider, branchTree);
```

**Step 3: Remove branch stubs from registerStubCommands**

Remove `COMMANDS.switchBranch`, `COMMANDS.createBranch`, `COMMANDS.deleteBranch` from the `stubCommands` array (they're now real commands).

**Step 4: Add context menu for branch tree**

In `package.json`, add a `view/item/context` menu section for branch operations:

```json
"view/item/context": [
  {
    "command": "plasticScm.switchBranch",
    "when": "view == plasticScm.branchesView && viewItem == branch",
    "group": "navigation"
  },
  {
    "command": "plasticScm.deleteBranch",
    "when": "view == plasticScm.branchesView && viewItem == branch",
    "group": "2_modification"
  }
]
```

Also add a `view/title` entry for the branch view refresh and create:

```json
"view/title": [
  {
    "command": "plasticScm.createBranch",
    "when": "view == plasticScm.branchesView",
    "group": "navigation"
  },
  {
    "command": "plasticScm.refresh",
    "when": "view == plasticScm.branchesView",
    "group": "navigation"
  }
]
```

**Step 5: Run type-check**

Run: `<type-check command>`
Expected: 0 errors.

---

### Task 8: Full integration verification

**Step 1: Run all tests**

Run: `<test command>`
Expected: All tests pass.

**Step 2: Run type-check**

Run: `<type-check command>`
Expected: 0 errors.

**Step 3: Manual verification checklist**
- [ ] Activity bar shows "Plastic SCM" with branches view
- [ ] Branches view lists all repository branches
- [ ] Current branch shows checkmark icon and sorts first
- [ ] Right-click branch → "Switch to Branch" works
- [ ] Right-click branch → "Delete Branch" works (with confirmation)
- [ ] "+" button in branch view title → creates new branch
- [ ] After switch, SCM status bar and branch tree update
