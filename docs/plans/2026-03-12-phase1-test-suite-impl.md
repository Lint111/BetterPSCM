# Phase 1 Test Suite — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a comprehensive test suite for all Phase 1 code — core backends, SCM provider, commands, status bar, and utilities.

**Architecture:** Vitest with manual VS Code mocks. Tests run in plain Node. `execCm` stubbed via `vi.mock`. REST client stubbed via mock `getClient`. VS Code API stubbed via module alias.

**Tech Stack:** Vitest, TypeScript, `vi.mock` / `vi.fn`

**Design doc:** `docs/plans/2026-03-12-phase1-test-suite-design.md`

**Run tests:** `cd /mnt/c/GitHub/BetterSCM && /mnt/c/nvm4w/nodejs/node.exe node_modules/vitest/vitest.mjs run 2>&1`

**Type-check:** `/mnt/c/nvm4w/nodejs/node.exe C:/GitHub/BetterSCM/node_modules/typescript/bin/tsc --noEmit --project C:/GitHub/BetterSCM/tsconfig.json 2>&1`

**Note:** This project is NOT a git repo. No commits. Just verify tests pass.

**Note:** We are writing tests for existing, working code. Not TDD — just write tests and verify they pass.

---

### Task 1: Test infrastructure setup

**Files:**
- Create: `vitest.config.ts`
- Create: `test/tsconfig.json`
- Create: `test/mocks/vscode.ts`
- Modify: `package.json` (add vitest devDependency)

**Step 1: Install vitest**

```bash
cd /mnt/c/GitHub/BetterSCM && /mnt/c/nvm4w/nodejs/npm.cmd install -D vitest 2>&1
```

**Step 2: Create `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';
import * as path from 'path';

export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
		globals: true,
	},
	resolve: {
		alias: {
			vscode: path.resolve(__dirname, 'test/mocks/vscode.ts'),
		},
	},
});
```

**Step 3: Create `test/tsconfig.json`**

```json
{
	"compilerOptions": {
		"target": "ES2022",
		"module": "Node16",
		"moduleResolution": "Node16",
		"lib": ["ES2022"],
		"strict": true,
		"esModuleInterop": true,
		"skipLibCheck": true,
		"noEmit": true,
		"types": ["vitest/globals"]
	},
	"include": ["**/*.ts", "../src/**/*.ts"],
	"exclude": ["node_modules"]
}
```

**Step 4: Create `test/mocks/vscode.ts`**

This is the VS Code API mock. Only stubs the APIs the extension actually uses.

```typescript
import { vi } from 'vitest';

// --- Uri ---

export class Uri {
	readonly scheme: string;
	readonly authority: string;
	readonly path: string;
	readonly fsPath: string;

	private constructor(scheme: string, authority: string, path: string) {
		this.scheme = scheme;
		this.authority = authority;
		this.path = path;
		this.fsPath = path;
	}

	static file(p: string): Uri {
		return new Uri('file', '', p);
	}

	static parse(value: string): Uri {
		const match = value.match(/^([^:]+):\/\/([^/]*)(\/.*)?$/);
		if (match) return new Uri(match[1], match[2] ?? '', match[3] ?? '');
		return new Uri('file', '', value);
	}

	static from(components: { scheme: string; authority?: string; path?: string }): Uri {
		return new Uri(components.scheme, components.authority ?? '', components.path ?? '');
	}

	static joinPath(base: Uri, ...segments: string[]): Uri {
		const joined = [base.path, ...segments].join('/').replace(/\/+/g, '/');
		return new Uri(base.scheme, base.authority, joined);
	}

	toString(): string {
		return `${this.scheme}://${this.authority}${this.path}`;
	}
}

// --- EventEmitter ---

export class EventEmitter<T> {
	private listeners: Array<(e: T) => void> = [];

	readonly event = (listener: (e: T) => void) => {
		this.listeners.push(listener);
		return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
	};

	fire(data: T): void {
		for (const l of this.listeners) l(data);
	}

	dispose(): void {
		this.listeners = [];
	}
}

// --- ThemeColor / ThemeIcon ---

export class ThemeColor {
	constructor(public readonly id: string) {}
}

export class ThemeIcon {
	constructor(public readonly id: string, public readonly color?: ThemeColor) {}
}

// --- Enums ---

export const StatusBarAlignment = { Left: 1, Right: 2 } as const;
export const ProgressLocation = { SourceControl: 1, Notification: 15, Window: 10 } as const;
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const;

// --- Memento (for StagingManager) ---

export function createMockMemento(initial: Record<string, unknown> = {}): any {
	const store = new Map<string, unknown>(Object.entries(initial));
	return {
		get: (key: string, defaultValue?: unknown) => store.has(key) ? store.get(key) : defaultValue,
		update: vi.fn((key: string, value: unknown) => { store.set(key, value); return Promise.resolve(); }),
		keys: () => [...store.keys()],
	};
}

// --- window ---

export const window = {
	showInformationMessage: vi.fn(),
	showWarningMessage: vi.fn(),
	showErrorMessage: vi.fn(),
	showInputBox: vi.fn(),
	withProgress: vi.fn(async (_opts: any, task: any) => task({ report: vi.fn() })),
	createOutputChannel: vi.fn(() => ({
		appendLine: vi.fn(),
		show: vi.fn(),
		dispose: vi.fn(),
	})),
	createStatusBarItem: vi.fn(() => ({
		text: '',
		tooltip: '',
		command: undefined as string | undefined,
		show: vi.fn(),
		hide: vi.fn(),
		dispose: vi.fn(),
	})),
};

// --- workspace ---

const defaultConfig: Record<string, unknown> = {};

export const workspace = {
	getConfiguration: vi.fn(() => ({
		get: (key: string, defaultValue?: unknown) => defaultConfig[key] ?? defaultValue,
	})),
	registerTextDocumentContentProvider: vi.fn(() => ({ dispose: vi.fn() })),
	onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
	workspaceFolders: undefined as any,
};

/**
 * Helper: set config values for tests that use getConfig().
 */
export function setMockConfig(values: Record<string, unknown>): void {
	Object.assign(defaultConfig, values);
}

// --- scm ---

export const scm = {
	createSourceControl: vi.fn((_id: string, _label: string, _rootUri?: Uri) => ({
		inputBox: { value: '', placeholder: '' },
		acceptInputCommand: undefined as any,
		quickDiffProvider: undefined as any,
		count: 0,
		createResourceGroup: vi.fn((_id: string, _label: string) => ({
			id: _id,
			label: _label,
			resourceStates: [] as any[],
			dispose: vi.fn(),
		})),
		dispose: vi.fn(),
	})),
};

// --- commands ---

export const commands = {
	registerCommand: vi.fn(),
	executeCommand: vi.fn(),
};

// --- Disposable ---

export class Disposable {
	constructor(private readonly callOnDispose: () => void) {}
	static from(...disposables: { dispose: () => void }[]): Disposable {
		return new Disposable(() => disposables.forEach(d => d.dispose()));
	}
	dispose(): void {
		this.callOnDispose();
	}
}
```

**Step 5: Verify infrastructure works**

Create a smoke test `test/unit/smoke.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

describe('smoke', () => {
	it('runs', () => {
		expect(1 + 1).toBe(2);
	});
});
```

Run: `cd /mnt/c/GitHub/BetterSCM && /mnt/c/nvm4w/nodejs/node.exe node_modules/vitest/vitest.mjs run 2>&1`

Expected: 1 test passed. Delete smoke test after verifying.

---

### Task 2: Core types + backend singleton tests

**Files:**
- Create: `test/unit/core/types.test.ts`
- Create: `test/unit/core/backend.test.ts`

**Step 1: Write `test/unit/core/types.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { normalizeChange, NotSupportedError } from '../../../src/core/types';
import type { StatusChange } from '../../../src/core/types';

describe('normalizeChange', () => {
	it('normalizes a valid change', () => {
		const raw: StatusChange = {
			path: '/src/foo.ts',
			changeType: 'changed',
			dataType: 'File',
		};
		const result = normalizeChange(raw);
		expect(result).toEqual({
			path: '/src/foo.ts',
			changeType: 'changed',
			dataType: 'File',
			sourcePath: undefined,
			revisionGuid: undefined,
			oldRevisionId: undefined,
		});
	});

	it('maps Dir to Directory', () => {
		const raw: StatusChange = {
			path: '/src',
			changeType: 'added',
			dataType: 'Dir',
		};
		const result = normalizeChange(raw);
		expect(result?.dataType).toBe('Directory');
	});

	it('returns undefined for missing path', () => {
		const raw = { changeType: 'changed' } as StatusChange;
		expect(normalizeChange(raw)).toBeUndefined();
	});

	it('returns undefined for missing changeType', () => {
		const raw = { path: '/foo' } as StatusChange;
		expect(normalizeChange(raw)).toBeUndefined();
	});
});

describe('NotSupportedError', () => {
	it('formats message with operation and backend', () => {
		const err = new NotSupportedError('getDiff', 'cm CLI');
		expect(err.message).toBe('"getDiff" is not supported by the cm CLI backend');
		expect(err.name).toBe('NotSupportedError');
		expect(err).toBeInstanceOf(Error);
	});
});
```

**Step 2: Write `test/unit/core/backend.test.ts`**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';

// We need to reset the module between tests to clear the singleton
// Use dynamic import to get a fresh module each time
describe('backend singleton', () => {
	let backend: typeof import('../../../src/core/backend');

	beforeEach(async () => {
		vi.resetModules();
		backend = await import('../../../src/core/backend');
	});

	it('throws when no backend is set', () => {
		expect(() => backend.getBackend()).toThrow('No Plastic SCM backend configured');
	});

	it('hasBackend returns false initially', () => {
		expect(backend.hasBackend()).toBe(false);
	});

	it('setBackend + getBackend round-trips', () => {
		const fake = { name: 'test' } as any;
		backend.setBackend(fake);
		expect(backend.getBackend()).toBe(fake);
		expect(backend.hasBackend()).toBe(true);
	});

	it('getBackend returns the last set backend', () => {
		const first = { name: 'first' } as any;
		const second = { name: 'second' } as any;
		backend.setBackend(first);
		backend.setBackend(second);
		expect(backend.getBackend().name).toBe('second');
	});
});
```

**Step 3: Run tests**

Run: `cd /mnt/c/GitHub/BetterSCM && /mnt/c/nvm4w/nodejs/node.exe node_modules/vitest/vitest.mjs run 2>&1`

Expected: All tests pass.

---

### Task 3: CliBackend tests

**Files:**
- Create: `test/unit/core/backendCli.test.ts`

**Step 1: Write the test file**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execCm } from '../../../src/core/cmCli';

vi.mock('../../../src/core/cmCli', () => ({
	execCm: vi.fn(),
}));

import { CliBackend } from '../../../src/core/backendCli';

const mockExecCm = vi.mocked(execCm);

describe('CliBackend', () => {
	let backend: CliBackend;

	beforeEach(() => {
		vi.clearAllMocks();
		backend = new CliBackend();
	});

	it('has name "cm CLI"', () => {
		expect(backend.name).toBe('cm CLI');
	});

	// --- getStatus ---

	describe('getStatus', () => {
		it('parses machine-readable status output', async () => {
			mockExecCm.mockResolvedValue({
				stdout: [
					'STATUS cs:42 rep:DAPrototype org@cloud',
					'CH /src/foo.ts False NO_MERGE',
					'AD /src/bar.ts False NO_MERGE',
					'PR /src/baz.ts False NO_MERGE',
				].join('\n'),
				stderr: '',
				exitCode: 0,
			});

			const result = await backend.getStatus(true);
			expect(result.changes).toHaveLength(3);
			expect(result.changes[0]).toEqual({
				path: '/src/foo.ts',
				changeType: 'changed',
				dataType: 'File',
			});
			expect(result.changes[1].changeType).toBe('added');
			expect(result.changes[2].changeType).toBe('private');
		});

		it('filters private files when showPrivate=false', async () => {
			mockExecCm.mockResolvedValue({
				stdout: 'CH /src/foo.ts False NO_MERGE\nPR /src/baz.ts False NO_MERGE\n',
				stderr: '',
				exitCode: 0,
			});

			const result = await backend.getStatus(false);
			expect(result.changes).toHaveLength(1);
			expect(result.changes[0].changeType).toBe('changed');
		});

		it('returns empty changes for empty workspace', async () => {
			mockExecCm.mockResolvedValue({
				stdout: 'STATUS cs:42 rep:DAPrototype org@cloud\n',
				stderr: '',
				exitCode: 0,
			});

			const result = await backend.getStatus(true);
			expect(result.changes).toHaveLength(0);
		});

		it('parses directory changes', async () => {
			mockExecCm.mockResolvedValue({
				stdout: 'AD /src/newdir True NO_MERGE\n',
				stderr: '',
				exitCode: 0,
			});

			const result = await backend.getStatus(true);
			expect(result.changes[0].dataType).toBe('Directory');
		});

		it('throws on non-zero exit code', async () => {
			mockExecCm.mockResolvedValue({
				stdout: '',
				stderr: 'Error: workspace not found',
				exitCode: 1,
			});

			await expect(backend.getStatus(true)).rejects.toThrow('cm status failed');
		});

		it('maps all known change type codes', async () => {
			const codes = ['CH', 'AD', 'CO', 'DE', 'LD', 'MV', 'RP', 'CP', 'IG', 'HD'];
			const expected = ['changed', 'added', 'checkedOut', 'deleted', 'locallyDeleted', 'moved', 'replaced', 'copied', 'ignored', 'changed'];

			for (let i = 0; i < codes.length; i++) {
				mockExecCm.mockResolvedValue({
					stdout: `${codes[i]} /file.ts False NO_MERGE\n`,
					stderr: '',
					exitCode: 0,
				});
				const result = await backend.getStatus(true);
				expect(result.changes[0].changeType).toBe(expected[i]);
			}
		});
	});

	// --- getCurrentBranch ---

	describe('getCurrentBranch', () => {
		it('parses branch from wi output', async () => {
			mockExecCm.mockResolvedValue({
				stdout: 'BR /main/Tech/Feature rep:DAPrototype@org@cloud\n',
				stderr: '',
				exitCode: 0,
			});

			const branch = await backend.getCurrentBranch();
			expect(branch).toBe('/main/Tech/Feature');
		});

		it('returns undefined when no branch match', async () => {
			mockExecCm.mockResolvedValue({
				stdout: 'UNEXPECTED OUTPUT',
				stderr: '',
				exitCode: 0,
			});

			const branch = await backend.getCurrentBranch();
			expect(branch).toBeUndefined();
		});

		it('throws on non-zero exit code', async () => {
			mockExecCm.mockResolvedValue({
				stdout: '',
				stderr: 'workspace error',
				exitCode: 1,
			});

			await expect(backend.getCurrentBranch()).rejects.toThrow('cm wi failed');
		});
	});

	// --- checkin ---

	describe('checkin', () => {
		it('parses changeset ID from output', async () => {
			mockExecCm.mockResolvedValue({
				stdout: 'cs:123 on br:/main/Feature',
				stderr: '',
				exitCode: 0,
			});

			const result = await backend.checkin(['/src/foo.ts'], 'fix bug');
			expect(result.changesetId).toBe(123);
			expect(result.branchName).toContain('main');
		});

		it('throws on non-zero exit code', async () => {
			mockExecCm.mockResolvedValue({
				stdout: '',
				stderr: 'nothing to checkin',
				exitCode: 1,
			});

			await expect(backend.checkin(['/foo'], 'msg')).rejects.toThrow('cm checkin failed');
		});

		it('throws when changeset ID not parseable', async () => {
			mockExecCm.mockResolvedValue({
				stdout: 'some unexpected output',
				stderr: '',
				exitCode: 0,
			});

			await expect(backend.checkin(['/foo'], 'msg')).rejects.toThrow('could not parse changeset ID');
		});

		it('passes comment and paths to execCm', async () => {
			mockExecCm.mockResolvedValue({
				stdout: 'cs:1',
				stderr: '',
				exitCode: 0,
			});

			await backend.checkin(['/a.ts', '/b.ts'], 'my comment');
			expect(mockExecCm).toHaveBeenCalledWith([
				'checkin', '-c=my comment', '--machinereadable', '/a.ts', '/b.ts',
			]);
		});
	});

	// --- getFileContent ---

	describe('getFileContent', () => {
		it('returns Uint8Array on success', async () => {
			mockExecCm.mockResolvedValue({
				stdout: 'file content here',
				stderr: '',
				exitCode: 0,
			});

			const result = await backend.getFileContent('revid:42');
			expect(result).toBeInstanceOf(Buffer);
			expect(result?.toString()).toBe('file content here');
		});

		it('returns undefined on non-zero exit (file not found)', async () => {
			mockExecCm.mockResolvedValue({
				stdout: '',
				stderr: 'object not found',
				exitCode: 1,
			});

			const result = await backend.getFileContent('revid:999');
			expect(result).toBeUndefined();
		});
	});
});
```

**Step 2: Run tests**

Expected: All CliBackend tests pass.

---

### Task 4: RestBackend tests

**Files:**
- Create: `test/unit/core/backendRest.test.ts`

**Step 1: Write the test file**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the API client module
vi.mock('../../../src/api/client', () => ({
	getClient: vi.fn(),
	getOrgName: vi.fn(() => 'test-org'),
	getWorkspaceGuid: vi.fn(() => 'test-guid'),
}));

import { getClient } from '../../../src/api/client';
import { RestBackend } from '../../../src/core/backendRest';

const mockGetClient = vi.mocked(getClient);

function setupClient(method: 'GET' | 'POST', response: { data?: any; error?: any }) {
	const clientMock = {
		GET: vi.fn().mockResolvedValue(method === 'GET' ? response : { data: null, error: null }),
		POST: vi.fn().mockResolvedValue(method === 'POST' ? response : { data: null, error: null }),
	};
	mockGetClient.mockReturnValue(clientMock as any);
	return clientMock;
}

describe('RestBackend', () => {
	let backend: RestBackend;

	beforeEach(() => {
		vi.clearAllMocks();
		backend = new RestBackend();
	});

	it('has name "REST API"', () => {
		expect(backend.name).toBe('REST API');
	});

	describe('getStatus', () => {
		it('maps changes through normalizeChange', async () => {
			const client = setupClient('GET', {
				data: {
					changes: [
						{ path: '/src/foo.ts', changeType: 'changed', dataType: 'File' },
						{ path: '/src/bar.ts', changeType: 'added', dataType: 'File' },
					],
				},
			});

			const result = await backend.getStatus(true);
			expect(result.changes).toHaveLength(2);
			expect(result.changes[0].path).toBe('/src/foo.ts');
			expect(client.GET).toHaveBeenCalledOnce();
		});

		it('filters private files when showPrivate=false', async () => {
			setupClient('GET', {
				data: {
					changes: [
						{ path: '/src/foo.ts', changeType: 'changed', dataType: 'File' },
						{ path: '/unversioned.txt', changeType: 'private', dataType: 'File' },
					],
				},
			});

			const result = await backend.getStatus(false);
			expect(result.changes).toHaveLength(1);
		});

		it('throws on error response', async () => {
			setupClient('GET', { error: new Error('network') });
			await expect(backend.getStatus(true)).rejects.toThrow();
		});

		it('returns empty changes when data has no changes array', async () => {
			setupClient('GET', { data: {} });
			const result = await backend.getStatus(true);
			expect(result.changes).toHaveLength(0);
		});
	});

	describe('getCurrentBranch', () => {
		it('extracts branch spec from workspace details', async () => {
			setupClient('GET', {
				data: {
					uvcsConnections: [{
						target: { type: 'Branch', spec: '/main/Feature' },
					}],
				},
			});

			const branch = await backend.getCurrentBranch();
			expect(branch).toBe('/main/Feature');
		});

		it('returns undefined when no connections', async () => {
			setupClient('GET', { data: {} });
			const branch = await backend.getCurrentBranch();
			expect(branch).toBeUndefined();
		});

		it('throws on error', async () => {
			setupClient('GET', { error: new Error('auth') });
			await expect(backend.getCurrentBranch()).rejects.toThrow();
		});
	});

	describe('checkin', () => {
		it('returns CheckinResult from response', async () => {
			const client = setupClient('POST', {
				data: { changesetId: 42, branchName: '/main' },
			});

			const result = await backend.checkin(['/foo.ts'], 'msg');
			expect(result.changesetId).toBe(42);
			expect(result.branchName).toBe('/main');
			expect(client.POST).toHaveBeenCalledOnce();
		});

		it('throws on error', async () => {
			setupClient('POST', { error: new Error('conflict') });
			await expect(backend.checkin(['/foo'], 'msg')).rejects.toThrow();
		});
	});

	describe('getFileContent', () => {
		it('returns Uint8Array from ArrayBuffer', async () => {
			const buf = new ArrayBuffer(4);
			new Uint8Array(buf).set([72, 105, 33, 10]); // "Hi!\n"
			setupClient('GET', { data: buf });

			const result = await backend.getFileContent('rev-guid');
			expect(result).toBeInstanceOf(Uint8Array);
			expect(result?.length).toBe(4);
		});

		it('returns undefined on error', async () => {
			setupClient('GET', { error: new Error('not found') });
			const result = await backend.getFileContent('rev-guid');
			expect(result).toBeUndefined();
		});
	});
});
```

**Step 2: Run tests**

Expected: All RestBackend tests pass.

---

### Task 5: workspace.ts facade tests

**Files:**
- Create: `test/unit/core/workspace.test.ts`

**Step 1: Write the test file**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/core/backend', () => ({
	getBackend: vi.fn(),
}));

import { getBackend } from '../../../src/core/backend';
import { fetchWorkspaceStatus, getCurrentBranch, checkinFiles, fetchFileContent } from '../../../src/core/workspace';

const mockGetBackend = vi.mocked(getBackend);

describe('workspace facade', () => {
	const fakeBackend = {
		name: 'fake',
		getStatus: vi.fn(),
		getCurrentBranch: vi.fn(),
		checkin: vi.fn(),
		getFileContent: vi.fn(),
	};

	beforeEach(() => {
		vi.clearAllMocks();
		mockGetBackend.mockReturnValue(fakeBackend as any);
	});

	it('fetchWorkspaceStatus delegates to getStatus', async () => {
		const expected = { changes: [] };
		fakeBackend.getStatus.mockResolvedValue(expected);

		const result = await fetchWorkspaceStatus(true);
		expect(result).toBe(expected);
		expect(fakeBackend.getStatus).toHaveBeenCalledWith(true);
	});

	it('getCurrentBranch delegates', async () => {
		fakeBackend.getCurrentBranch.mockResolvedValue('/main');
		const result = await getCurrentBranch();
		expect(result).toBe('/main');
	});

	it('checkinFiles delegates', async () => {
		const expected = { changesetId: 1, branchName: '/main' };
		fakeBackend.checkin.mockResolvedValue(expected);

		const result = await checkinFiles(['/foo'], 'msg');
		expect(result).toBe(expected);
		expect(fakeBackend.checkin).toHaveBeenCalledWith(['/foo'], 'msg');
	});

	it('fetchFileContent delegates', async () => {
		const bytes = new Uint8Array([1, 2, 3]);
		fakeBackend.getFileContent.mockResolvedValue(bytes);

		const result = await fetchFileContent('rev:1');
		expect(result).toBe(bytes);
		expect(fakeBackend.getFileContent).toHaveBeenCalledWith('rev:1');
	});
});
```

**Step 2: Run tests**

Expected: All pass.

---

### Task 6: Utility tests — uri.ts + config.ts

**Files:**
- Create: `test/unit/util/uri.test.ts`
- Create: `test/unit/util/config.test.ts`

**Step 1: Write `test/unit/util/uri.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { Uri } from '../../mocks/vscode';
import { buildPlasticUri, parsePlasticUri } from '../../../src/util/uri';

describe('buildPlasticUri', () => {
	it('builds a plastic: URI', () => {
		const uri = buildPlasticUri('ws-guid', 'rev-guid', 'src/foo.ts');
		expect(uri.scheme).toBe('plastic');
		expect(uri.authority).toBe('ws-guid');
		expect(uri.path).toBe('/rev-guid/src/foo.ts');
	});
});

describe('parsePlasticUri', () => {
	it('round-trips with buildPlasticUri', () => {
		const uri = buildPlasticUri('ws-guid', 'rev-guid', 'src/foo.ts');
		const parsed = parsePlasticUri(uri);
		expect(parsed).toEqual({
			workspaceGuid: 'ws-guid',
			revisionGuid: 'rev-guid',
			filePath: 'src/foo.ts',
		});
	});

	it('returns undefined for non-plastic scheme', () => {
		const uri = Uri.file('/some/path');
		expect(parsePlasticUri(uri as any)).toBeUndefined();
	});

	it('returns undefined for too-short path', () => {
		const uri = Uri.from({ scheme: 'plastic', authority: 'ws', path: '/only' });
		expect(parsePlasticUri(uri as any)).toBeUndefined();
	});

	it('handles nested file paths', () => {
		const uri = buildPlasticUri('ws', 'rev', 'src/deep/path/file.ts');
		const parsed = parsePlasticUri(uri);
		expect(parsed?.filePath).toBe('src/deep/path/file.ts');
	});
});
```

**Step 2: Write `test/unit/util/config.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { workspace } from '../../mocks/vscode';

vi.mock('../../../src/core/cmCli', () => ({
	isCmAvailable: vi.fn(() => false),
}));

import { isCmAvailable } from '../../../src/core/cmCli';
import { getConfig, isConfigured } from '../../../src/util/config';

const mockIsCmAvailable = vi.mocked(isCmAvailable);

describe('getConfig', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns config with defaults', () => {
		const cfg = getConfig();
		expect(cfg.pollInterval).toBe(3000);
		expect(cfg.showPrivateFiles).toBe(true);
		expect(cfg.mcpEnabled).toBe(false);
	});
});

describe('isConfigured', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockIsCmAvailable.mockReturnValue(false);
	});

	it('returns false when nothing is configured', () => {
		expect(isConfigured()).toBe(false);
	});

	it('returns true when cm CLI is available', () => {
		mockIsCmAvailable.mockReturnValue(true);
		expect(isConfigured()).toBe(true);
	});

	it('returns true when REST API settings are present', () => {
		workspace.getConfiguration.mockReturnValue({
			get: (key: string, def?: unknown) => {
				if (key === 'plasticScm.serverUrl') return 'https://example.com';
				if (key === 'plasticScm.organizationName') return 'my-org';
				return def;
			},
		} as any);

		expect(isConfigured()).toBe(true);
	});
});
```

**Step 3: Run tests**

Expected: All pass.

---

### Task 7: Polling tests

**Files:**
- Create: `test/unit/util/polling.test.ts`

**Step 1: Write the test file**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AdaptivePoller } from '../../../src/util/polling';

describe('AdaptivePoller', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('calls callback after base interval', async () => {
		const callback = vi.fn().mockResolvedValue(undefined);
		const poller = new AdaptivePoller(callback, 1000);

		poller.start();
		expect(callback).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1000);
		expect(callback).toHaveBeenCalledTimes(1);

		poller.dispose();
	});

	it('calls callback repeatedly', async () => {
		const callback = vi.fn().mockResolvedValue(undefined);
		const poller = new AdaptivePoller(callback, 500);

		poller.start();
		await vi.advanceTimersByTimeAsync(500);
		await vi.advanceTimersByTimeAsync(500);
		expect(callback).toHaveBeenCalledTimes(2);

		poller.dispose();
	});

	it('stops on dispose', async () => {
		const callback = vi.fn().mockResolvedValue(undefined);
		const poller = new AdaptivePoller(callback, 500);

		poller.start();
		poller.dispose();

		await vi.advanceTimersByTimeAsync(1000);
		expect(callback).not.toHaveBeenCalled();
	});

	it('stop prevents further callbacks', async () => {
		const callback = vi.fn().mockResolvedValue(undefined);
		const poller = new AdaptivePoller(callback, 500);

		poller.start();
		await vi.advanceTimersByTimeAsync(500);
		expect(callback).toHaveBeenCalledTimes(1);

		poller.stop();
		await vi.advanceTimersByTimeAsync(1000);
		expect(callback).toHaveBeenCalledTimes(1);

		poller.dispose();
	});

	it('backs off after idle threshold', async () => {
		const callback = vi.fn().mockResolvedValue(undefined);
		const poller = new AdaptivePoller(callback, 1000, 3000, 2000);

		poller.start();

		// First call at 1000ms (base interval)
		await vi.advanceTimersByTimeAsync(1000);
		expect(callback).toHaveBeenCalledTimes(1);

		// After 2000ms idle threshold, interval should switch to backoff (3000ms)
		await vi.advanceTimersByTimeAsync(3000);
		expect(callback).toHaveBeenCalledTimes(2);

		poller.dispose();
	});

	it('notifyChange resets to base interval', async () => {
		const callback = vi.fn().mockResolvedValue(undefined);
		const poller = new AdaptivePoller(callback, 1000, 5000, 500);

		poller.start();

		// Let it back off
		await vi.advanceTimersByTimeAsync(1000);
		expect(callback).toHaveBeenCalledTimes(1);

		// Now notify change — should reset interval
		poller.notifyChange();

		// Should fire again after base interval (1000), not backoff (5000)
		await vi.advanceTimersByTimeAsync(1000);
		expect(callback).toHaveBeenCalledTimes(2);

		poller.dispose();
	});

	it('swallows callback errors', async () => {
		const callback = vi.fn().mockRejectedValue(new Error('boom'));
		const poller = new AdaptivePoller(callback, 500);

		poller.start();
		// Should not throw
		await vi.advanceTimersByTimeAsync(500);
		expect(callback).toHaveBeenCalledTimes(1);

		// Should continue polling after error
		await vi.advanceTimersByTimeAsync(500);
		expect(callback).toHaveBeenCalledTimes(2);

		poller.dispose();
	});
});
```

**Step 2: Run tests**

Expected: All pass.

---

### Task 8: plasticDetector tests

**Files:**
- Create: `test/unit/util/plasticDetector.test.ts`

**Step 1: Write the test file**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';

vi.mock('fs');

import { detectWorkspace, hasPlasticWorkspace, detectCachedToken } from '../../../src/util/plasticDetector';

const mockFs = vi.mocked(fs);

describe('hasPlasticWorkspace', () => {
	it('returns true when plastic.workspace exists', () => {
		mockFs.existsSync.mockReturnValue(true);
		expect(hasPlasticWorkspace('/project')).toBe(true);
	});

	it('returns false when missing', () => {
		mockFs.existsSync.mockReturnValue(false);
		expect(hasPlasticWorkspace('/project')).toBe(false);
	});
});

describe('detectWorkspace', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns undefined when .plastic folder missing', () => {
		mockFs.existsSync.mockReturnValue(false);
		expect(detectWorkspace('/project')).toBeUndefined();
	});

	it('parses workspace info from .plastic files', () => {
		mockFs.existsSync.mockImplementation((p: any) => {
			const path = String(p);
			if (path.includes('.plastic')) return true;
			if (path.includes('unityorgs.conf')) return true;
			return false;
		});

		mockFs.readFileSync.mockImplementation((p: any) => {
			const path = String(p);
			if (path.includes('plastic.workspace')) {
				return 'MyWorkspace\n0208f971-645e-41ec-b635-303facd7df1d\nType';
			}
			if (path.includes('plastic.selector')) {
				return 'repository "MyOrg/MyRepo@20067454181069@cloud"\n  path "/"\n    smartbranch "/main/Feature"\n';
			}
			if (path.includes('unityorgs.conf')) {
				return '20067454181069:my-org-slug\n';
			}
			return '';
		});

		const result = detectWorkspace('/project');
		expect(result).toBeDefined();
		expect(result!.workspaceName).toBe('MyWorkspace');
		expect(result!.workspaceGuid).toBe('0208f971-645e-41ec-b635-303facd7df1d');
		expect(result!.repositoryName).toBe('MyRepo');
		expect(result!.currentBranch).toBe('/main/Feature');
		expect(result!.isCloud).toBe(true);
		expect(result!.organizationName).toBe('my-org-slug');
	});

	it('uses local server URL for non-cloud workspaces', () => {
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockImplementation((p: any) => {
			const path = String(p);
			if (path.includes('plastic.workspace')) return 'WS\nguid\nType';
			if (path.includes('plastic.selector')) return 'repository "Org/Repo@localhost:8087"\n  path "/"\n    branch "/main"\n';
			return '';
		});

		const result = detectWorkspace('/project');
		expect(result).toBeDefined();
		expect(result!.isCloud).toBe(false);
		expect(result!.serverUrl).toBe('http://localhost:7178');
	});
});

describe('detectCachedToken', () => {
	const origEnv = process.env.LOCALAPPDATA;

	beforeEach(() => {
		vi.clearAllMocks();
		process.env.LOCALAPPDATA = 'C:\\Users\\test\\AppData\\Local';
	});

	afterAll(() => {
		process.env.LOCALAPPDATA = origEnv;
	});

	it('returns undefined when LOCALAPPDATA not set', () => {
		delete process.env.LOCALAPPDATA;
		expect(detectCachedToken()).toBeUndefined();
	});

	it('returns undefined when tokens.conf missing', () => {
		mockFs.existsSync.mockReturnValue(false);
		expect(detectCachedToken()).toBeUndefined();
	});

	it('parses token from tokens.conf', () => {
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockReturnValue(
			'server=20067454181069@cloud user=test@example.com token=TOKENeyJhbGciOiJSUzI1NiJ9 seiddata=test@example.com\n'
		);

		const result = detectCachedToken();
		expect(result).toBeDefined();
		expect(result!.server).toBe('20067454181069@cloud');
		expect(result!.user).toBe('test@example.com');
		expect(result!.token).toBe('eyJhbGciOiJSUzI1NiJ9');
	});

	it('filters by server spec when provided', () => {
		mockFs.existsSync.mockReturnValue(true);
		mockFs.readFileSync.mockReturnValue(
			'server=other@cloud user=a@b.com token=TOKENabc seiddata=a@b.com\nserver=target@cloud user=x@y.com token=TOKENxyz seiddata=x@y.com\n'
		);

		const result = detectCachedToken('target@cloud');
		expect(result!.user).toBe('x@y.com');
		expect(result!.token).toBe('xyz');
	});
});
```

**Step 2: Run tests**

Expected: All pass.

---

### Task 9: Decoration + ResourceStateFactory tests

**Files:**
- Create: `test/unit/scm/decorations.test.ts`
- Create: `test/unit/scm/resourceStateFactory.test.ts`

**Step 1: Write `test/unit/scm/decorations.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { getChangeDecoration, getChangeLetter } from '../../../src/scm/decorations';

describe('getChangeDecoration', () => {
	it('returns strikeThrough for deleted', () => {
		const dec = getChangeDecoration('deleted');
		expect(dec.strikeThrough).toBe(true);
	});

	it('returns strikeThrough for locallyDeleted', () => {
		const dec = getChangeDecoration('locallyDeleted');
		expect(dec.strikeThrough).toBe(true);
	});

	it('does not strikeThrough for added', () => {
		const dec = getChangeDecoration('added');
		expect(dec.strikeThrough).toBe(false);
	});

	it('has tooltip for each change type', () => {
		const types = ['added', 'changed', 'deleted', 'checkedOut', 'moved', 'private'] as const;
		for (const t of types) {
			const dec = getChangeDecoration(t);
			expect(dec.tooltip).toBeTruthy();
		}
	});

	it('has iconPath for each change type', () => {
		const dec = getChangeDecoration('changed');
		expect(dec.iconPath).toBeDefined();
	});
});

describe('getChangeLetter', () => {
	it('returns A for added', () => {
		expect(getChangeLetter('added')).toBe('A');
	});

	it('returns M for changed', () => {
		expect(getChangeLetter('changed')).toBe('M');
	});

	it('returns D for deleted', () => {
		expect(getChangeLetter('deleted')).toBe('D');
	});

	it('returns CO for checkedOut', () => {
		expect(getChangeLetter('checkedOut')).toBe('CO');
	});

	it('returns MV for moved', () => {
		expect(getChangeLetter('moved')).toBe('MV');
	});

	it('returns ? for private', () => {
		expect(getChangeLetter('private')).toBe('?');
	});

	it('returns I for ignored', () => {
		expect(getChangeLetter('ignored')).toBe('I');
	});
});
```

**Step 2: Write `test/unit/scm/resourceStateFactory.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { Uri } from '../../mocks/vscode';
import { createResourceState } from '../../../src/scm/resourceStateFactory';
import type { NormalizedChange } from '../../../src/core/types';
import { COMMANDS } from '../../../src/constants';

describe('createResourceState', () => {
	const root = Uri.file('/workspace');

	it('creates resource state with correct URI', () => {
		const change: NormalizedChange = {
			path: 'src/foo.ts',
			changeType: 'changed',
			dataType: 'File',
		};
		const state = createResourceState(change, root as any);
		expect(state.resourceUri.path).toContain('src/foo.ts');
	});

	it('has open-change command for non-deleted files', () => {
		const change: NormalizedChange = {
			path: 'src/foo.ts',
			changeType: 'changed',
			dataType: 'File',
		};
		const state = createResourceState(change, root as any);
		expect(state.command?.command).toBe(COMMANDS.openChange);
	});

	it('has no command for deleted files', () => {
		const change: NormalizedChange = {
			path: 'src/foo.ts',
			changeType: 'deleted',
			dataType: 'File',
		};
		const state = createResourceState(change, root as any);
		expect(state.command).toBeUndefined();
	});

	it('has no command for locallyDeleted files', () => {
		const change: NormalizedChange = {
			path: 'src/foo.ts',
			changeType: 'locallyDeleted',
			dataType: 'File',
		};
		const state = createResourceState(change, root as any);
		expect(state.command).toBeUndefined();
	});

	it('sets contextValue to changeType', () => {
		const change: NormalizedChange = {
			path: 'src/foo.ts',
			changeType: 'added',
			dataType: 'File',
		};
		const state = createResourceState(change, root as any);
		expect(state.contextValue).toBe('added');
	});

	it('includes decorations', () => {
		const change: NormalizedChange = {
			path: 'src/foo.ts',
			changeType: 'changed',
			dataType: 'File',
		};
		const state = createResourceState(change, root as any);
		expect(state.decorations).toBeDefined();
		expect(state.decorations?.tooltip).toBeTruthy();
	});
});
```

**Step 3: Run tests**

Expected: All pass.

---

### Task 10: StagingManager tests

**Files:**
- Create: `test/unit/scm/stagingManager.test.ts`

**Step 1: Write the test file**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockMemento } from '../../mocks/vscode';
import { StagingManager } from '../../../src/scm/stagingManager';
import type { NormalizedChange } from '../../../src/core/types';

function makeChange(path: string): NormalizedChange {
	return { path, changeType: 'changed', dataType: 'File' };
}

describe('StagingManager', () => {
	let memento: ReturnType<typeof createMockMemento>;
	let manager: StagingManager;

	beforeEach(() => {
		memento = createMockMemento();
		manager = new StagingManager(memento);
	});

	it('starts with no staged paths', () => {
		expect(manager.getStagedPaths()).toEqual([]);
	});

	it('restores staged paths from memento', () => {
		const mem = createMockMemento({ 'plasticScm.stagedPaths': ['/a', '/b'] });
		const m = new StagingManager(mem);
		expect(m.getStagedPaths()).toEqual(['/a', '/b']);
	});

	describe('stage', () => {
		it('adds paths to staged set', () => {
			manager.stage(['/a', '/b']);
			expect(manager.isStaged('/a')).toBe(true);
			expect(manager.isStaged('/b')).toBe(true);
		});

		it('persists to memento', () => {
			manager.stage(['/a']);
			expect(memento.update).toHaveBeenCalled();
		});

		it('does not fire event for duplicate stage', () => {
			manager.stage(['/a']);
			vi.clearAllMocks();
			manager.stage(['/a']);
			expect(memento.update).not.toHaveBeenCalled();
		});
	});

	describe('unstage', () => {
		it('removes paths from staged set', () => {
			manager.stage(['/a', '/b']);
			manager.unstage(['/a']);
			expect(manager.isStaged('/a')).toBe(false);
			expect(manager.isStaged('/b')).toBe(true);
		});

		it('no-ops for unstaged paths', () => {
			vi.clearAllMocks();
			manager.unstage(['/nonexistent']);
			expect(memento.update).not.toHaveBeenCalled();
		});
	});

	describe('stageAll', () => {
		it('stages all change paths', () => {
			manager.stageAll([makeChange('/a'), makeChange('/b')]);
			expect(manager.getStagedPaths()).toEqual(['/a', '/b']);
		});
	});

	describe('unstageAll', () => {
		it('clears all staged paths', () => {
			manager.stage(['/a', '/b']);
			manager.unstageAll();
			expect(manager.getStagedPaths()).toEqual([]);
		});

		it('no-ops when already empty', () => {
			vi.clearAllMocks();
			manager.unstageAll();
			expect(memento.update).not.toHaveBeenCalled();
		});
	});

	describe('splitChanges', () => {
		it('partitions changes by staged status', () => {
			manager.stage(['/a']);
			const changes = [makeChange('/a'), makeChange('/b'), makeChange('/c')];
			const { staged, unstaged } = manager.splitChanges(changes);

			expect(staged.map(c => c.path)).toEqual(['/a']);
			expect(unstaged.map(c => c.path)).toEqual(['/b', '/c']);
		});
	});

	describe('pruneStale', () => {
		it('removes staged paths not in current changes', () => {
			manager.stage(['/a', '/b', '/c']);
			manager.pruneStale([makeChange('/b')]);

			expect(manager.isStaged('/a')).toBe(false);
			expect(manager.isStaged('/b')).toBe(true);
			expect(manager.isStaged('/c')).toBe(false);
		});

		it('no-ops when nothing to prune', () => {
			manager.stage(['/a']);
			vi.clearAllMocks();
			manager.pruneStale([makeChange('/a')]);
			expect(memento.update).not.toHaveBeenCalled();
		});
	});

	describe('onDidChange', () => {
		it('fires when staging changes', () => {
			const listener = vi.fn();
			manager.onDidChange(listener);
			manager.stage(['/a']);
			expect(listener).toHaveBeenCalledTimes(1);
		});

		it('fires when unstaging changes', () => {
			manager.stage(['/a']);
			const listener = vi.fn();
			manager.onDidChange(listener);
			manager.unstage(['/a']);
			expect(listener).toHaveBeenCalledTimes(1);
		});
	});

	describe('dispose', () => {
		it('does not throw', () => {
			expect(() => manager.dispose()).not.toThrow();
		});
	});
});
```

**Step 2: Run tests**

Expected: All pass.

---

### Task 11: PlasticScmProvider tests

**Files:**
- Create: `test/unit/scm/plasticScmProvider.test.ts`

**Step 1: Write the test file**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Uri, createMockMemento, scm } from '../../mocks/vscode';

vi.mock('../../../src/core/workspace', () => ({
	fetchWorkspaceStatus: vi.fn(),
}));

vi.mock('../../../src/util/config', () => ({
	getConfig: vi.fn(() => ({
		pollInterval: 3000,
		showPrivateFiles: true,
	})),
}));

vi.mock('../../../src/api/errors', () => ({
	AuthExpiredError: class extends Error { constructor() { super(); this.name = 'AuthExpiredError'; } },
	isPlasticApiError: () => false,
}));

import { fetchWorkspaceStatus } from '../../../src/core/workspace';
import { PlasticScmProvider } from '../../../src/scm/plasticScmProvider';

const mockFetchStatus = vi.mocked(fetchWorkspaceStatus);

describe('PlasticScmProvider', () => {
	let provider: PlasticScmProvider;
	const root = Uri.file('/workspace');
	let memento: ReturnType<typeof createMockMemento>;

	beforeEach(() => {
		vi.clearAllMocks();
		memento = createMockMemento();
		provider = new PlasticScmProvider(root as any, memento);
	});

	afterEach(() => {
		provider.dispose();
	});

	it('starts with no changes', () => {
		expect(provider.getAllChanges()).toEqual([]);
		expect(provider.getPendingCount()).toBe(0);
	});

	it('returns staging manager', () => {
		expect(provider.getStagingManager()).toBeDefined();
	});

	it('gets and clears input box value', () => {
		// Access the underlying source control via the mock
		const sc = scm.createSourceControl.mock.results[0]?.value;
		if (sc) {
			sc.inputBox.value = 'test message';
			expect(provider.getInputBoxValue()).toBe('test message');

			provider.clearInputBox();
			expect(sc.inputBox.value).toBe('');
		}
	});

	describe('refresh', () => {
		it('updates changes from fetchWorkspaceStatus', async () => {
			mockFetchStatus.mockResolvedValue({
				changes: [
					{ path: '/src/a.ts', changeType: 'changed', dataType: 'File' },
					{ path: '/src/b.ts', changeType: 'added', dataType: 'File' },
				],
			});

			await provider.refresh();

			expect(provider.getAllChanges()).toHaveLength(2);
			expect(provider.getPendingCount()).toBe(2);
		});

		it('fires onDidChangeStatus after successful poll', async () => {
			mockFetchStatus.mockResolvedValue({ changes: [] });

			const listener = vi.fn();
			provider.onDidChangeStatus(listener);

			await provider.refresh();
			expect(listener).toHaveBeenCalledTimes(1);
		});
	});

	describe('dispose', () => {
		it('does not throw', () => {
			expect(() => provider.dispose()).not.toThrow();
		});
	});
});
```

**Step 2: Run tests**

Expected: All pass.

---

### Task 12: Checkin command tests

**Files:**
- Create: `test/unit/commands/checkin.test.ts`

**Step 1: Write the test file**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { window } from '../../mocks/vscode';

vi.mock('../../../src/core/workspace', () => ({
	checkinFiles: vi.fn(),
}));

import { checkinFiles } from '../../../src/core/workspace';
import { registerCheckinCommands } from '../../../src/commands/checkin';
import { COMMANDS } from '../../../src/constants';

const mockCheckinFiles = vi.mocked(checkinFiles);

// Helper: create a mock provider
function createMockProvider(options: {
	changes?: Array<{ path: string; changeType: string; dataType: string }>;
	stagedPaths?: string[];
	inputBoxValue?: string;
} = {}) {
	const changes = options.changes ?? [];
	const stagedPaths = new Set(options.stagedPaths ?? []);

	return {
		getAllChanges: () => changes,
		getStagingManager: () => ({
			splitChanges: (c: any[]) => ({
				staged: c.filter((x: any) => stagedPaths.has(x.path)),
				unstaged: c.filter((x: any) => !stagedPaths.has(x.path)),
			}),
			unstageAll: vi.fn(),
		}),
		getInputBoxValue: () => options.inputBoxValue ?? '',
		clearInputBox: vi.fn(),
		refresh: vi.fn().mockResolvedValue(undefined),
	};
}

describe('checkin commands', () => {
	let registeredHandlers: Record<string, Function>;

	beforeEach(() => {
		vi.clearAllMocks();
		registeredHandlers = {};

		const context = {
			subscriptions: {
				push: (sub: any) => {
					// registerCommand returns a disposable
				},
			},
		};

		// Capture the command handlers via the mock
		const { commands } = require('../../mocks/vscode');
		commands.registerCommand.mockImplementation((cmd: string, handler: Function) => {
			registeredHandlers[cmd] = handler;
			return { dispose: vi.fn() };
		});

		const provider = createMockProvider({
			changes: [
				{ path: '/a.ts', changeType: 'changed', dataType: 'File' },
				{ path: '/b.ts', changeType: 'added', dataType: 'File' },
			],
			stagedPaths: ['/a.ts'],
			inputBoxValue: 'fix bug',
		});

		registerCheckinCommands(context as any, provider as any);
	});

	it('registers checkin and checkinAll commands', () => {
		expect(registeredHandlers[COMMANDS.checkin]).toBeDefined();
		expect(registeredHandlers[COMMANDS.checkinAll]).toBeDefined();
	});

	it('checkin uses staged files only', async () => {
		mockCheckinFiles.mockResolvedValue({ changesetId: 1, branchName: '/main' });

		await registeredHandlers[COMMANDS.checkin]();

		expect(mockCheckinFiles).toHaveBeenCalledWith(['/a.ts'], 'fix bug');
	});

	it('checkinAll uses all files', async () => {
		mockCheckinFiles.mockResolvedValue({ changesetId: 1, branchName: '/main' });

		await registeredHandlers[COMMANDS.checkinAll]();

		expect(mockCheckinFiles).toHaveBeenCalledWith(['/a.ts', '/b.ts'], 'fix bug');
	});

	it('shows warning when no staged files', async () => {
		const provider = createMockProvider({ changes: [{ path: '/a.ts', changeType: 'changed', dataType: 'File' }], stagedPaths: [] });
		const { commands } = require('../../mocks/vscode');
		registeredHandlers = {};
		commands.registerCommand.mockImplementation((cmd: string, handler: Function) => {
			registeredHandlers[cmd] = handler;
			return { dispose: vi.fn() };
		});
		registerCheckinCommands({ subscriptions: { push: vi.fn() } } as any, provider as any);

		await registeredHandlers[COMMANDS.checkin]();
		expect(window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('No staged'));
	});

	it('shows error on checkin failure', async () => {
		mockCheckinFiles.mockRejectedValue(new Error('cm checkin failed'));

		await registeredHandlers[COMMANDS.checkin]();
		expect(window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('Check-in failed'));
	});
});
```

**Step 2: Run tests**

Expected: All pass.

---

### Task 13: PlasticStatusBar tests

**Files:**
- Create: `test/unit/statusBar/plasticStatusBar.test.ts`

**Step 1: Write the test file**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { window, EventEmitter } from '../../mocks/vscode';

vi.mock('../../../src/core/workspace', () => ({
	getCurrentBranch: vi.fn(),
}));

import { getCurrentBranch } from '../../../src/core/workspace';
import { PlasticStatusBar } from '../../../src/statusBar/plasticStatusBar';

const mockGetCurrentBranch = vi.mocked(getCurrentBranch);

function createMockProvider() {
	const emitter = new EventEmitter<void>();
	return {
		onDidChangeStatus: emitter.event,
		getPendingCount: vi.fn(() => 0),
		getStagedCount: vi.fn(() => 0),
		_fireStatusChange: () => emitter.fire(),
	};
}

describe('PlasticStatusBar', () => {
	let statusBar: PlasticStatusBar;
	let provider: ReturnType<typeof createMockProvider>;

	beforeEach(() => {
		vi.clearAllMocks();
		mockGetCurrentBranch.mockResolvedValue('/main/Feature');
		provider = createMockProvider();
		statusBar = new PlasticStatusBar(provider as any);
	});

	afterEach(() => {
		statusBar.dispose();
	});

	it('creates two status bar items', () => {
		expect(window.createStatusBarItem).toHaveBeenCalledTimes(2);
	});

	it('shows branch name after update', async () => {
		await statusBar.update();

		const branchItem = window.createStatusBarItem.mock.results[0].value;
		expect(branchItem.text).toContain('/main/Feature');
	});

	it('shows fallback when branch is undefined', async () => {
		mockGetCurrentBranch.mockResolvedValue(undefined);
		await statusBar.update();

		const branchItem = window.createStatusBarItem.mock.results[0].value;
		expect(branchItem.text).toContain('Plastic SCM');
	});

	it('shows fallback on branch error', async () => {
		mockGetCurrentBranch.mockRejectedValue(new Error('fail'));
		await statusBar.update();

		const branchItem = window.createStatusBarItem.mock.results[0].value;
		expect(branchItem.text).toContain('Plastic SCM');
	});

	it('shows "No changes" when count is 0', async () => {
		provider.getPendingCount.mockReturnValue(0);
		await statusBar.update();

		const changesItem = window.createStatusBarItem.mock.results[1].value;
		expect(changesItem.text).toContain('No changes');
	});

	it('shows change count when changes exist', async () => {
		provider.getPendingCount.mockReturnValue(5);
		provider.getStagedCount.mockReturnValue(0);

		await statusBar.update();

		const changesItem = window.createStatusBarItem.mock.results[1].value;
		expect(changesItem.text).toContain('5');
	});

	it('shows staged/total when files are staged', async () => {
		provider.getPendingCount.mockReturnValue(5);
		provider.getStagedCount.mockReturnValue(2);

		await statusBar.update();

		const changesItem = window.createStatusBarItem.mock.results[1].value;
		expect(changesItem.text).toContain('2/5');
	});

	it('updates changes on status change event', () => {
		provider.getPendingCount.mockReturnValue(3);
		provider.getStagedCount.mockReturnValue(0);

		provider._fireStatusChange();

		const changesItem = window.createStatusBarItem.mock.results[1].value;
		expect(changesItem.text).toContain('3');
	});

	it('dispose does not throw', () => {
		expect(() => statusBar.dispose()).not.toThrow();
	});
});
```

**Step 2: Run tests**

Expected: All pass.

---

### Task 14: Final verification — run full suite

**Step 1: Run all tests**

```bash
cd /mnt/c/GitHub/BetterSCM && /mnt/c/nvm4w/nodejs/node.exe node_modules/vitest/vitest.mjs run 2>&1
```

Expected: All tests pass, 0 failures.

**Step 2: Type-check production code still compiles**

```bash
/mnt/c/nvm4w/nodejs/node.exe C:/GitHub/BetterSCM/node_modules/typescript/bin/tsc --noEmit --project C:/GitHub/BetterSCM/tsconfig.json 2>&1
```

Expected: 0 errors (test files excluded by tsconfig).

**Step 3: Build still works**

```bash
/mnt/c/nvm4w/nodejs/node.exe C:/GitHub/BetterSCM/node_modules/esbuild/bin/esbuild --bundle C:/GitHub/BetterSCM/src/extension.ts --outfile=C:/GitHub/BetterSCM/out/extension.js --format=cjs --platform=node --external:vscode --sourcemap 2>&1
```

Expected: Bundle succeeds at ~70kb.

---

## Summary

| Task | What | Test Count (approx) |
|------|------|---------------------|
| 1 | Infrastructure (vitest, config, vscode mock) | 1 smoke |
| 2 | types.ts + backend.ts singleton | ~9 |
| 3 | CliBackend (getStatus, getBranch, checkin, getFileContent) | ~15 |
| 4 | RestBackend | ~10 |
| 5 | workspace.ts facade | ~4 |
| 6 | uri.ts + config.ts | ~9 |
| 7 | AdaptivePoller | ~7 |
| 8 | plasticDetector.ts | ~8 |
| 9 | decorations.ts + resourceStateFactory.ts | ~13 |
| 10 | StagingManager | ~12 |
| 11 | PlasticScmProvider | ~5 |
| 12 | checkin commands | ~5 |
| 13 | PlasticStatusBar | ~8 |
| 14 | Full verification | 0 (verify run) |
| **Total** | | **~105** |
