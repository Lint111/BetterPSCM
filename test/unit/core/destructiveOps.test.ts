import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
	classifyDestructiveFiles,
	executeDestructiveRevert,
	noopAuditLogger,
	AuditLogger,
} from '../../../src/core/destructiveOps';
import { BULK_OPERATION_THRESHOLD } from '../../../src/core/safety';
import type { PlasticBackend } from '../../../src/core/backend';

// ── classifyDestructiveFiles ────────────────────────────────────────

describe('classifyDestructiveFiles', () => {
	it('flags Unity-critical files by extension', () => {
		const result = classifyDestructiveFiles([
			'Assets/Scenes/Main.unity',
			'Assets/Scripts/Foo.cs',
			'Assets/Prefabs/Player.prefab',
			'README.md',
			'Packages/manifest.json',
		]);
		expect(result.criticalFiles).toEqual([
			'Assets/Scenes/Main.unity',
			'Assets/Prefabs/Player.prefab',
		]);
	});

	it('flags all Unity-reimport triggering files', () => {
		const result = classifyDestructiveFiles([
			'Assets/Foo.cs',
			'Assets/Bar.shader',
			'Assets/Wind.compute',
			'Assets/Material.mat',
			'Assets/ScriptableObject.asset',
			'Assets/Scenes/Main.unity',
			'Assets/Data.json',   // not a reimport trigger
			'README.md',           // not a reimport trigger
		]);
		expect(result.reimportFiles).toHaveLength(6);
		expect(result.reimportFiles).toContain('Assets/Foo.cs');
		expect(result.reimportFiles).toContain('Assets/Scenes/Main.unity');
		expect(result.reimportFiles).not.toContain('Assets/Data.json');
	});

	it('is case-insensitive for extensions', () => {
		const result = classifyDestructiveFiles([
			'Foo.META',
			'Bar.Unity',
			'Baz.PREFAB',
		]);
		expect(result.criticalFiles).toHaveLength(3);
	});

	it('uses BULK_OPERATION_THRESHOLD by default', () => {
		const files = Array.from({ length: BULK_OPERATION_THRESHOLD + 1 }, (_, i) => `file-${i}.txt`);
		const result = classifyDestructiveFiles(files);
		expect(result.requiresBulkConfirmation).toBe(true);
		expect(result.bulkThreshold).toBe(BULK_OPERATION_THRESHOLD);
	});

	it('does not flag bulk at exactly the threshold', () => {
		const files = Array.from({ length: BULK_OPERATION_THRESHOLD }, (_, i) => `file-${i}.txt`);
		const result = classifyDestructiveFiles(files);
		expect(result.requiresBulkConfirmation).toBe(false);
	});

	it('accepts a custom bulk threshold', () => {
		const result = classifyDestructiveFiles(['a', 'b', 'c'], 2);
		expect(result.requiresBulkConfirmation).toBe(true);
		expect(result.bulkThreshold).toBe(2);
	});

	it('handles empty input', () => {
		const result = classifyDestructiveFiles([]);
		expect(result.totalFiles).toBe(0);
		expect(result.criticalFiles).toEqual([]);
		expect(result.reimportFiles).toEqual([]);
		expect(result.requiresBulkConfirmation).toBe(false);
	});
});

// ── executeDestructiveRevert ────────────────────────────────────────

describe('executeDestructiveRevert', () => {
	/** Builds a mock backend that records undoCheckout calls. */
	function mockBackend(overrides?: Partial<PlasticBackend>): PlasticBackend {
		const base = {
			name: 'mock',
			getStatus: vi.fn().mockResolvedValue({ changes: [] }),
			getCurrentBranch: vi.fn().mockResolvedValue('/main'),
			checkin: vi.fn(),
			undoCheckout: vi.fn().mockImplementation(async (paths: string[]) => paths),
			addToSourceControl: vi.fn(),
			removeFromSourceControl: vi.fn(),
			getBaseRevisionContent: vi.fn().mockResolvedValue(Buffer.from('base content')),
			getFileContent: vi.fn(),
			listBranches: vi.fn(),
			createBranch: vi.fn(),
			deleteBranch: vi.fn(),
			switchBranch: vi.fn(),
			updateWorkspace: vi.fn(),
			listChangesets: vi.fn(),
			getChangesetDiff: vi.fn(),
			getFileHistory: vi.fn(),
			getBlame: vi.fn(),
			checkMergeAllowed: vi.fn(),
			executeMerge: vi.fn(),
			createCodeReview: vi.fn(),
			listCodeReviews: vi.fn(),
			getCodeReview: vi.fn(),
			updateCodeReview: vi.fn(),
			listCodeReviewComments: vi.fn(),
			createCodeReviewComment: vi.fn(),
			updateCodeReviewComment: vi.fn(),
			deleteCodeReviewComment: vi.fn(),
			resolveRevisionPaths: vi.fn(),
			...overrides,
		};
		return base as unknown as PlasticBackend;
	}

	let tempDirs: string[] = [];

	function tempBackupDir(): string {
		const dir = mkdtempSync(join(tmpdir(), 'bpscm-destructive-test-'));
		tempDirs.push(dir);
		return dir;
	}

	/** Creates a temp workspace with one real file so createBackup can read it. */
	function tempWorkspaceWithFile(relName: string, content: string): { root: string; relPath: string } {
		const root = mkdtempSync(join(tmpdir(), 'bpscm-destructive-ws-'));
		tempDirs.push(root);
		const { writeFileSync, mkdirSync } = require('fs');
		const abs = join(root, relName);
		if (relName.includes('/')) {
			mkdirSync(join(root, relName.slice(0, relName.lastIndexOf('/'))), { recursive: true });
		}
		writeFileSync(abs, content);
		return { root, relPath: relName };
	}

	afterEach(() => {
		for (const d of tempDirs) {
			try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
		}
		tempDirs = [];
	});

	it('returns empty status for empty file list without invoking backend', async () => {
		const backend = mockBackend();
		const result = await executeDestructiveRevert({
			tool: 'test',
			files: [],
			backend,
			workspaceRoot: '/tmp',
			workspaceName: 'test',
			skipBackup: true,
		});
		expect(result.status).toBe('empty');
		expect(result.reverted).toEqual([]);
		expect(backend.undoCheckout).not.toHaveBeenCalled();
	});

	it('blocks bulk operations when enforceBulkGuard is set', async () => {
		const backend = mockBackend();
		const files = Array.from({ length: BULK_OPERATION_THRESHOLD + 1 }, (_, i) => `file-${i}.txt`);
		const result = await executeDestructiveRevert({
			tool: 'test',
			files,
			backend,
			workspaceRoot: '/tmp',
			workspaceName: 'test',
			enforceBulkGuard: true,
			skipBackup: true,
		});
		expect(result.status).toBe('blocked_bulk');
		expect(backend.undoCheckout).not.toHaveBeenCalled();
	});

	it('proceeds when enforceBulkGuard is false even above threshold', async () => {
		const backend = mockBackend();
		const files = Array.from({ length: BULK_OPERATION_THRESHOLD + 1 }, (_, i) => `file-${i}.txt`);
		const result = await executeDestructiveRevert({
			tool: 'test',
			files,
			backend,
			workspaceRoot: '/tmp',
			workspaceName: 'test',
			enforceBulkGuard: false,
			skipBackup: true,
		});
		expect(result.status).toBe('completed');
		expect(backend.undoCheckout).toHaveBeenCalledWith(files);
	});

	it('calls backend.undoCheckout with the file list on success', async () => {
		const backend = mockBackend();
		const result = await executeDestructiveRevert({
			tool: 'test',
			files: ['foo.txt', 'bar.txt'],
			backend,
			workspaceRoot: '/tmp',
			workspaceName: 'test',
			skipBackup: true,
		});
		expect(result.status).toBe('completed');
		expect(result.reverted).toEqual(['foo.txt', 'bar.txt']);
		expect(backend.undoCheckout).toHaveBeenCalledWith(['foo.txt', 'bar.txt']);
	});

	it('creates a backup directory containing a manifest and file copies', async () => {
		const { root, relPath } = tempWorkspaceWithFile('foo.txt', 'working-copy bytes');
		const backupBase = tempBackupDir();
		const backend = mockBackend({
			getBaseRevisionContent: vi.fn().mockResolvedValue(Buffer.from('base bytes')),
		});

		const result = await executeDestructiveRevert({
			tool: 'test_backup',
			files: [relPath],
			backend,
			workspaceRoot: root,
			workspaceName: 'my-workspace',
			backupBaseDir: backupBase,
		});

		expect(result.status).toBe('completed');
		expect(result.backupPath).toBeDefined();

		// Backup dir contains manifest.json + files/foo.txt + base/foo.txt
		const backupContents = readdirSync(result.backupPath!);
		expect(backupContents).toContain('manifest.json');
		expect(backupContents).toContain('files');
		expect(backupContents).toContain('base');

		const manifest = JSON.parse(readFileSync(join(result.backupPath!, 'manifest.json'), 'utf-8'));
		expect(manifest.tool).toBe('test_backup');
		expect(manifest.totalFiles).toBe(1);
		expect(manifest.files[0].path).toBe('foo.txt');
	});

	it('flags Unity-critical files in the classification result', async () => {
		const { root } = tempWorkspaceWithFile('Assets/Scene.unity', 'scene bytes');
		const backend = mockBackend();
		const result = await executeDestructiveRevert({
			tool: 'test',
			files: ['Assets/Scene.unity'],
			backend,
			workspaceRoot: root,
			workspaceName: 'test',
			skipBackup: true,
		});
		expect(result.classification.criticalFiles).toContain('Assets/Scene.unity');
	});

	it('emits a Unity reimport warning when .cs files are reverted', async () => {
		const backend = mockBackend();
		const result = await executeDestructiveRevert({
			tool: 'test',
			files: ['Assets/Foo.cs'],
			backend,
			workspaceRoot: '/tmp',
			workspaceName: 'test',
			skipBackup: true,
		});
		expect(result.unityReimportWarning).toBeDefined();
		expect(result.unityReimportWarning).toMatch(/reimport/i);
	});

	it('does not emit a Unity reimport warning when no reimport-triggering files', async () => {
		const backend = mockBackend();
		const result = await executeDestructiveRevert({
			tool: 'test',
			files: ['README.md', 'docs.html'],
			backend,
			workspaceRoot: '/tmp',
			workspaceName: 'test',
			skipBackup: true,
		});
		expect(result.unityReimportWarning).toBeUndefined();
	});

	it('records audit events in the expected order', async () => {
		const events: Array<{ action: string; details?: Record<string, unknown> }> = [];
		const auditLogger: AuditLogger = {
			log(action, details) { events.push({ action, details }); },
		};
		const backend = mockBackend();
		await executeDestructiveRevert({
			tool: 'test',
			files: ['foo.txt'],
			backend,
			workspaceRoot: '/tmp',
			workspaceName: 'test',
			skipBackup: true,
			audit: auditLogger,
		});
		const actions = events.map(e => e.action);
		expect(actions[0]).toBe('test:invoked');
		expect(actions[actions.length - 1]).toBe('test:completed');
	});

	it('records blocked_bulk audit event when the guard fires', async () => {
		const events: string[] = [];
		const auditLogger: AuditLogger = {
			log(action) { events.push(action); },
		};
		const files = Array.from({ length: BULK_OPERATION_THRESHOLD + 5 }, (_, i) => `f${i}.txt`);
		await executeDestructiveRevert({
			tool: 'test',
			files,
			backend: mockBackend(),
			workspaceRoot: '/tmp',
			workspaceName: 'test',
			enforceBulkGuard: true,
			skipBackup: true,
			audit: auditLogger,
		});
		expect(events).toContain('test:blocked_bulk');
		expect(events).not.toContain('test:completed');
	});

	it('propagates errors from backend.undoCheckout', async () => {
		const backend = mockBackend({
			undoCheckout: vi.fn().mockRejectedValue(new Error('cm undocheckout failed')),
		});
		await expect(executeDestructiveRevert({
			tool: 'test',
			files: ['foo.txt'],
			backend,
			workspaceRoot: '/tmp',
			workspaceName: 'test',
			skipBackup: true,
		})).rejects.toThrow('cm undocheckout failed');
	});

	it('logs backup_failed and continues when backup throws', async () => {
		const events: string[] = [];
		const auditLogger: AuditLogger = {
			log(action) { events.push(action); },
		};
		const backend = mockBackend({
			// getBaseRevisionContent succeeds but createBackup will fail because
			// we deliberately pass a bogus backup base dir that can't be created
			// (a file, not a directory, would also work but this is simpler).
			getBaseRevisionContent: vi.fn().mockRejectedValue(new Error('read failed')),
		});
		const { root, relPath } = tempWorkspaceWithFile('foo.txt', 'content');
		// Point backupBaseDir at a path that forces mkdir to fail — use a null char
		// which is illegal in POSIX paths.
		const result = await executeDestructiveRevert({
			tool: 'test',
			files: [relPath],
			backend,
			workspaceRoot: root,
			workspaceName: 'test',
			backupBaseDir: '/dev/null/cannot-create-here',
			audit: auditLogger,
		});
		// Operation still completes despite backup failure
		expect(result.status).toBe('completed');
		expect(events).toContain('test:backup_failed');
	});

	it('uses noopAuditLogger by default', async () => {
		// Shouldn't throw even without an audit logger.
		const backend = mockBackend();
		const result = await executeDestructiveRevert({
			tool: 'test',
			files: ['foo.txt'],
			backend,
			workspaceRoot: '/tmp',
			workspaceName: 'test',
			skipBackup: true,
		});
		expect(result.status).toBe('completed');
	});
});

describe('noopAuditLogger', () => {
	it('is a no-op', () => {
		expect(() => noopAuditLogger.log('test', { foo: 1 })).not.toThrow();
	});
});
