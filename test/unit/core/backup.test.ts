import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
    resolveBackupDir,
    createBackup,
    listBackups,
    getBackupManifest,
    restoreBackup,
} from '../../../src/core/backup.js';

function makeTempDir(): string {
    return path.join(os.tmpdir(), `backup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

describe('backup module', () => {
    const tempDirs: string[] = [];

    function trackDir(dir: string): string {
        tempDirs.push(dir);
        return dir;
    }

    afterEach(async () => {
        for (const dir of tempDirs) {
            await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        }
        tempDirs.length = 0;
    });

    // ── resolveBackupDir ───────────────────────────────────────────

    describe('resolveBackupDir', () => {
        it('uses override dir when provided', () => {
            const result = resolveBackupDir('my-workspace', '/custom/backups');
            expect(result).toBe(path.join('/custom/backups', 'my-workspace'));
        });

        it('falls back to ~/.plastic-scm-backups', () => {
            const result = resolveBackupDir('my-workspace');
            expect(result).toBe(path.join(os.homedir(), '.plastic-scm-backups', 'my-workspace'));
        });

        it('sanitizes special characters in workspace name', () => {
            const result = resolveBackupDir('my workspace<>:test', '/base');
            expect(result).toBe(path.join('/base', 'my_workspace___test'));
        });

        it('rejects parent-directory traversal via ".." in workspace name', () => {
            // Without sanitization, `..` would resolve to the parent of /base.
            // The sanitizer must collapse the `..` into a safe literal.
            const result = resolveBackupDir('..', '/base');
            // path.basename + sanitize should produce a single-component name
            // that does NOT equal `..` or `.` or an empty string.
            const component = path.basename(result);
            expect(component).not.toBe('..');
            expect(component).not.toBe('.');
            expect(component.length).toBeGreaterThan(0);
            // The resolved dir must still be a child of /base
            expect(result.startsWith('/base' + path.sep) || result === '/base').toBe(true);
        });

        it('rejects slashes hiding inside workspace name', () => {
            // A workspace name like `../etc` has both `/` and `..`. Both must
            // be neutralized so the backup dir stays inside /base.
            const result = resolveBackupDir('../etc/passwd', '/base');
            const component = path.basename(result);
            expect(component).not.toContain('..');
            expect(component).not.toContain('/');
            expect(result.startsWith('/base' + path.sep) || result === '/base').toBe(true);
        });
    });

    // ── createBackup ───────────────────────────────────────────────

    describe('createBackup', () => {
        it('sanitizes tool name so ".." cannot escape the workspace backup dir', async () => {
            const backupBase = trackDir(makeTempDir());
            const wsRoot = trackDir(makeTempDir());
            await fs.mkdir(wsRoot, { recursive: true });
            await fs.writeFile(path.join(wsRoot, 'foo.txt'), 'hi');

            // Attempted path traversal via the tool parameter. The resulting
            // backup directory must remain a child of the workspace backup dir.
            const backupDir = await createBackup({
                tool: '../etc',
                workspace: 'ws',
                workspaceRoot: wsRoot,
                files: [{ path: 'foo.txt', changeType: 'changed' }],
                getBaseContent: async () => null,
                backupBaseDir: backupBase,
            });

            const expectedWsBackup = path.join(backupBase, 'ws');
            // The backup directory must be inside the workspace backup dir.
            expect(backupDir.startsWith(expectedWsBackup + path.sep)).toBe(true);
            // And the final path component must not contain ".." or "/".
            const component = path.basename(backupDir);
            expect(component).not.toContain('..');
            expect(component).not.toContain('/');
        });

        it('creates manifest.json with correct structure', async () => {
            const backupBase = trackDir(makeTempDir());
            const wsRoot = trackDir(makeTempDir());
            await fs.mkdir(wsRoot, { recursive: true });
            await fs.writeFile(path.join(wsRoot, 'foo.txt'), 'hello');

            const backupDir = await createBackup({
                tool: 'test-tool',
                workspace: 'ws1',
                workspaceRoot: wsRoot,
                files: [{ path: 'foo.txt', changeType: 'changed' }],
                getBaseContent: async () => Buffer.from('original'),
                backupBaseDir: backupBase,
            });

            const manifest = JSON.parse(
                await fs.readFile(path.join(backupDir, 'manifest.json'), 'utf-8'),
            );

            expect(manifest.version).toBe(1);
            expect(manifest.tool).toBe('test-tool');
            expect(manifest.workspace).toBe('ws1');
            expect(manifest.totalFiles).toBe(1);
            expect(manifest.files).toHaveLength(1);
            expect(manifest.files[0].path).toBe('foo.txt');
            expect(manifest.files[0].changeType).toBe('changed');
            expect(manifest.files[0].backupFile).toBe(path.join('files', 'foo.txt'));
            expect(manifest.files[0].baseFile).toBe(path.join('base', 'foo.txt'));
        });

        it('captures working copy in files/ and base version in base/', async () => {
            const backupBase = trackDir(makeTempDir());
            const wsRoot = trackDir(makeTempDir());
            await fs.mkdir(wsRoot, { recursive: true });
            await fs.writeFile(path.join(wsRoot, 'file.cs'), 'modified content');

            const backupDir = await createBackup({
                tool: 'checkin',
                workspace: 'ws',
                workspaceRoot: wsRoot,
                files: [{ path: 'file.cs', changeType: 'changed' }],
                getBaseContent: async () => Buffer.from('base content'),
                backupBaseDir: backupBase,
            });

            const workingCopy = await fs.readFile(path.join(backupDir, 'files', 'file.cs'), 'utf-8');
            expect(workingCopy).toBe('modified content');

            const base = await fs.readFile(path.join(backupDir, 'base', 'file.cs'), 'utf-8');
            expect(base).toBe('base content');
        });

        it('handles files with no base version (baseFile is null)', async () => {
            const backupBase = trackDir(makeTempDir());
            const wsRoot = trackDir(makeTempDir());
            await fs.mkdir(wsRoot, { recursive: true });
            await fs.writeFile(path.join(wsRoot, 'new.cs'), 'brand new');

            const backupDir = await createBackup({
                tool: 'checkin',
                workspace: 'ws',
                workspaceRoot: wsRoot,
                files: [{ path: 'new.cs', changeType: 'added' }],
                getBaseContent: async () => null,
                backupBaseDir: backupBase,
            });

            const manifest = JSON.parse(
                await fs.readFile(path.join(backupDir, 'manifest.json'), 'utf-8'),
            );
            expect(manifest.files[0].baseFile).toBeNull();
        });

        it('extracts GUID from .meta files', async () => {
            const backupBase = trackDir(makeTempDir());
            const wsRoot = trackDir(makeTempDir());
            await fs.mkdir(wsRoot, { recursive: true });
            const metaContent = 'fileFormatVersion: 2\nguid: abc123def456\nNativeFormatImporter:\n';
            await fs.writeFile(path.join(wsRoot, 'Foo.cs.meta'), metaContent);

            const backupDir = await createBackup({
                tool: 'checkin',
                workspace: 'ws',
                workspaceRoot: wsRoot,
                files: [{ path: 'Foo.cs.meta', changeType: 'changed' }],
                getBaseContent: async () => null,
                backupBaseDir: backupBase,
            });

            const manifest = JSON.parse(
                await fs.readFile(path.join(backupDir, 'manifest.json'), 'utf-8'),
            );
            expect(manifest.files[0].guid).toBe('abc123def456');
            expect(manifest.files[0].isUnityCritical).toBe(true);
        });

        it('counts Unity-critical files correctly', async () => {
            const backupBase = trackDir(makeTempDir());
            const wsRoot = trackDir(makeTempDir());
            await fs.mkdir(wsRoot, { recursive: true });
            await fs.writeFile(path.join(wsRoot, 'scene.unity'), 'scene data');
            await fs.writeFile(path.join(wsRoot, 'script.cs'), 'code');
            await fs.writeFile(path.join(wsRoot, 'prefab.prefab'), 'prefab data');

            const backupDir = await createBackup({
                tool: 'checkin',
                workspace: 'ws',
                workspaceRoot: wsRoot,
                files: [
                    { path: 'scene.unity', changeType: 'changed' },
                    { path: 'script.cs', changeType: 'changed' },
                    { path: 'prefab.prefab', changeType: 'changed' },
                ],
                getBaseContent: async () => null,
                backupBaseDir: backupBase,
            });

            const manifest = JSON.parse(
                await fs.readFile(path.join(backupDir, 'manifest.json'), 'utf-8'),
            );
            expect(manifest.unityCriticalFiles).toBe(2); // .unity + .prefab
            expect(manifest.totalFiles).toBe(3);
        });

        it('flattens nested paths with underscore', async () => {
            const backupBase = trackDir(makeTempDir());
            const wsRoot = trackDir(makeTempDir());
            await fs.mkdir(path.join(wsRoot, 'Assets', 'Scripts'), { recursive: true });
            await fs.writeFile(path.join(wsRoot, 'Assets', 'Scripts', 'Foo.cs'), 'code');

            const backupDir = await createBackup({
                tool: 'checkin',
                workspace: 'ws',
                workspaceRoot: wsRoot,
                files: [{ path: 'Assets/Scripts/Foo.cs', changeType: 'changed' }],
                getBaseContent: async () => null,
                backupBaseDir: backupBase,
            });

            const manifest = JSON.parse(
                await fs.readFile(path.join(backupDir, 'manifest.json'), 'utf-8'),
            );
            expect(manifest.files[0].backupFile).toBe(path.join('files', 'Assets_Scripts_Foo.cs'));

            // Verify the flattened file actually exists
            const exists = await fs.stat(path.join(backupDir, 'files', 'Assets_Scripts_Foo.cs')).then(() => true, () => false);
            expect(exists).toBe(true);
        });
    });

    // ── listBackups ────────────────────────────────────────────────

    describe('listBackups', () => {
        it('returns empty array when no backups exist', async () => {
            const backupBase = trackDir(makeTempDir());
            const result = await listBackups('nonexistent-ws', backupBase);
            expect(result).toEqual([]);
        });

        it('lists backups sorted newest-first', async () => {
            const backupBase = trackDir(makeTempDir());
            const wsRoot = trackDir(makeTempDir());
            await fs.mkdir(wsRoot, { recursive: true });
            await fs.writeFile(path.join(wsRoot, 'a.txt'), 'a');

            // Create first backup
            await createBackup({
                tool: 'tool-1',
                workspace: 'ws',
                workspaceRoot: wsRoot,
                files: [{ path: 'a.txt', changeType: 'changed' }],
                getBaseContent: async () => null,
                backupBaseDir: backupBase,
            });

            // Wait slightly so timestamp differs
            await new Promise(r => setTimeout(r, 1100));

            // Create second backup
            await createBackup({
                tool: 'tool-2',
                workspace: 'ws',
                workspaceRoot: wsRoot,
                files: [{ path: 'a.txt', changeType: 'changed' }],
                getBaseContent: async () => null,
                backupBaseDir: backupBase,
            });

            const backups = await listBackups('ws', backupBase);
            expect(backups).toHaveLength(2);
            // Newest first
            expect(backups[0].tool).toBe('tool-2');
            expect(backups[1].tool).toBe('tool-1');
            expect(backups[0].timestamp >= backups[1].timestamp).toBe(true);
        });
    });

    // ── getBackupManifest ──────────────────────────────────────────

    describe('getBackupManifest', () => {
        it('returns null for non-existent backup', async () => {
            const backupBase = trackDir(makeTempDir());
            const result = await getBackupManifest('ws', 'no-such-id', backupBase);
            expect(result).toBeNull();
        });

        it('returns parsed manifest for valid backup', async () => {
            const backupBase = trackDir(makeTempDir());
            const wsRoot = trackDir(makeTempDir());
            await fs.mkdir(wsRoot, { recursive: true });
            await fs.writeFile(path.join(wsRoot, 'x.txt'), 'data');

            const backupDir = await createBackup({
                tool: 'my-tool',
                workspace: 'ws',
                workspaceRoot: wsRoot,
                files: [{ path: 'x.txt', changeType: 'added' }],
                getBaseContent: async () => null,
                backupBaseDir: backupBase,
            });

            const backupId = path.basename(backupDir);
            const manifest = await getBackupManifest('ws', backupId, backupBase);

            expect(manifest).not.toBeNull();
            expect(manifest!.version).toBe(1);
            expect(manifest!.tool).toBe('my-tool');
            expect(manifest!.totalFiles).toBe(1);
        });
    });

    // ── restoreBackup ──────────────────────────────────────────────

    describe('restoreBackup', () => {
        it('restores files back to workspace paths', async () => {
            const backupBase = trackDir(makeTempDir());
            const wsRoot = trackDir(makeTempDir());
            await fs.mkdir(wsRoot, { recursive: true });
            await fs.writeFile(path.join(wsRoot, 'file.txt'), 'original');

            const backupDir = await createBackup({
                tool: 'checkin',
                workspace: 'ws',
                workspaceRoot: wsRoot,
                files: [{ path: 'file.txt', changeType: 'changed' }],
                getBaseContent: async () => null,
                backupBaseDir: backupBase,
            });

            // Simulate the file being changed/lost after backup
            await fs.writeFile(path.join(wsRoot, 'file.txt'), 'overwritten');

            const backupId = path.basename(backupDir);
            const restored = await restoreBackup('ws', wsRoot, backupId, undefined, backupBase);

            expect(restored).toEqual(['file.txt']);
            const content = await fs.readFile(path.join(wsRoot, 'file.txt'), 'utf-8');
            expect(content).toBe('original');
        });

        it('respects filterPaths (restores only specified files)', async () => {
            const backupBase = trackDir(makeTempDir());
            const wsRoot = trackDir(makeTempDir());
            await fs.mkdir(wsRoot, { recursive: true });
            await fs.writeFile(path.join(wsRoot, 'a.txt'), 'aaa');
            await fs.writeFile(path.join(wsRoot, 'b.txt'), 'bbb');

            const backupDir = await createBackup({
                tool: 'checkin',
                workspace: 'ws',
                workspaceRoot: wsRoot,
                files: [
                    { path: 'a.txt', changeType: 'changed' },
                    { path: 'b.txt', changeType: 'changed' },
                ],
                getBaseContent: async () => null,
                backupBaseDir: backupBase,
            });

            // Overwrite both
            await fs.writeFile(path.join(wsRoot, 'a.txt'), 'gone');
            await fs.writeFile(path.join(wsRoot, 'b.txt'), 'gone');

            const backupId = path.basename(backupDir);
            const restored = await restoreBackup('ws', wsRoot, backupId, ['a.txt'], backupBase);

            expect(restored).toEqual(['a.txt']);
            expect(await fs.readFile(path.join(wsRoot, 'a.txt'), 'utf-8')).toBe('aaa');
            // b.txt should NOT be restored
            expect(await fs.readFile(path.join(wsRoot, 'b.txt'), 'utf-8')).toBe('gone');
        });

        it('returns empty array for non-existent backup', async () => {
            const backupBase = trackDir(makeTempDir());
            const wsRoot = trackDir(makeTempDir());
            const restored = await restoreBackup('ws', wsRoot, 'no-such-id', undefined, backupBase);
            expect(restored).toEqual([]);
        });
    });
});
