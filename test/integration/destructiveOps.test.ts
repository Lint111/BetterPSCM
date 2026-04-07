/**
 * Integration test for the shared destructive-ops safety layer.
 *
 * Verifies that `executeDestructiveRevert` actually creates a backup directory
 * containing manifest + working-copy bytes + base bytes when run against a real
 * cm binary + real Plastic workspace. The unit tests in destructiveOps.test.ts
 * mock the backend — this file validates the end-to-end wiring.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { existsSync, readdirSync, readFileSync, rmSync } from 'fs';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { createIntegrationFixture, ensureFixturesRoot, IntegrationFixture } from './fixture';
import { executeDestructiveRevert } from '../../src/core/destructiveOps';
import type { BackupManifest } from '../../src/core/backup';

describe('executeDestructiveRevert (integration)', () => {
	let fx: IntegrationFixture;
	let backupBaseDir: string;
	const createdBackupDirs: string[] = [];

	beforeAll(async () => {
		await ensureFixturesRoot();
	});

	beforeEach(async () => {
		fx = await createIntegrationFixture();
		backupBaseDir = mkdtempSync(join(tmpdir(), 'bpscm-integration-backup-'));
		createdBackupDirs.push(backupBaseDir);
	});

	afterEach(async () => {
		if (fx) await fx.cleanup();
		for (const dir of createdBackupDirs) {
			try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
		createdBackupDirs.length = 0;
	});

	it('creates a backup directory with manifest + working-copy + base bytes', async () => {
		// 1. Modify the committed anchor so there's something to revert
		fx.modifyAnchor('modified working copy bytes\n');

		// 2. Run the destructive revert via the shared layer
		const result = await executeDestructiveRevert({
			tool: 'integration_test',
			files: [fx.anchorPath],
			backend: fx.backend,
			workspaceRoot: fx.workspaceRoot,
			workspaceName: 'integration-test-workspace',
			backupBaseDir,
		});

		// 3. Verify the revert actually ran
		expect(result.status).toBe('completed');
		expect(result.reverted).toContain(fx.anchorPath);

		// 4. Backup directory exists and has the expected layout
		expect(result.backupPath).toBeDefined();
		expect(existsSync(result.backupPath!)).toBe(true);

		const contents = readdirSync(result.backupPath!);
		expect(contents).toContain('manifest.json');
		expect(contents).toContain('files');
		expect(contents).toContain('base');

		// 5. Manifest records the file with the expected metadata
		const manifest = JSON.parse(
			readFileSync(join(result.backupPath!, 'manifest.json'), 'utf-8'),
		) as BackupManifest;
		expect(manifest.tool).toBe('integration_test');
		expect(manifest.workspace).toBe('integration-test-workspace');
		expect(manifest.totalFiles).toBe(1);
		expect(manifest.files[0].path).toBe(fx.anchorPath);
		expect(manifest.files[0].backupFile).toBeTruthy();

		// 6. The working-copy bytes we wrote are in the backup
		const backedUpWorkingCopy = readFileSync(
			join(result.backupPath!, manifest.files[0].backupFile),
			'utf-8',
		);
		expect(backedUpWorkingCopy).toBe('modified working copy bytes\n');

		// 7. The anchor file on disk is back to base content after the revert
		expect(fx.readAnchor().toString()).toBe(fx.anchorBaseContent);
	});

	it('classifies Unity-critical files when present', async () => {
		// Write a .unity file to the scratch dir (never committed — but the
		// classification step only looks at paths, not filesystem state).
		const scratchUnity = fx.writeScratch('Main.unity', 'scene bytes');

		// We can't actually revert an uncommitted file, so we pass skipBackup
		// and pre-empt the undoCheckout by stubbing the backend. Use the fixture
		// backend but swap undoCheckout — this is still an integration test in
		// the sense that classification + backup path handling run through the
		// real shared module.
		const originalUndoCheckout = fx.backend.undoCheckout.bind(fx.backend);
		(fx.backend as any).undoCheckout = async (paths: string[]) => paths;

		try {
			const result = await executeDestructiveRevert({
				tool: 'integration_classification',
				files: [scratchUnity],
				backend: fx.backend,
				workspaceRoot: fx.workspaceRoot,
				workspaceName: 'integration-test-workspace',
				skipBackup: true,
			});
			expect(result.status).toBe('completed');
			expect(result.classification.criticalFiles).toContain(scratchUnity);
			expect(result.unityReimportWarning).toBeDefined();
		} finally {
			(fx.backend as any).undoCheckout = originalUndoCheckout;
		}
	});

	it('returns blocked_bulk without invoking backend when enforceBulkGuard set', async () => {
		const bigFiles = Array.from({ length: 50 }, (_, i) => `scratch/file-${i}.txt`);
		let backendCalled = false;
		const originalUndoCheckout = fx.backend.undoCheckout.bind(fx.backend);
		(fx.backend as any).undoCheckout = async () => { backendCalled = true; return []; };

		try {
			const result = await executeDestructiveRevert({
				tool: 'integration_bulk',
				files: bigFiles,
				backend: fx.backend,
				workspaceRoot: fx.workspaceRoot,
				workspaceName: 'integration-test-workspace',
				enforceBulkGuard: true,
				skipBackup: true,
			});
			expect(result.status).toBe('blocked_bulk');
			expect(backendCalled).toBe(false);
		} finally {
			(fx.backend as any).undoCheckout = originalUndoCheckout;
		}
	});
});
