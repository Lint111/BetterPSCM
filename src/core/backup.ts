import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { UNITY_CRITICAL_EXTENSIONS } from './safety';

// ── Types ──────────────────────────────────────────────────────────────

export interface BackupFileEntry {
    path: string;
    changeType: string;
    backupFile: string;
    baseFile: string | null;
    sizeBytes: number;
    isUnityCritical: boolean;
    guid: string | null;
}

export interface BackupManifest {
    version: 1;
    timestamp: string;
    tool: string;
    workspace: string;
    totalFiles: number;
    unityCriticalFiles: number;
    files: BackupFileEntry[];
}

export interface CreateBackupOptions {
    tool: string;
    workspace: string;
    workspaceRoot: string;
    files: Array<{ path: string; changeType: string }>;
    getBaseContent: (path: string) => Promise<Buffer | null>;
    backupBaseDir?: string;
}

// ── Constants ──────────────────────────────────────────────────────────

const UNITY_CRITICAL_SET = new Set(UNITY_CRITICAL_EXTENSIONS);

/** Characters that would let a path component escape its parent directory or
 *  cause filesystem errors on Windows. Applied as a first pass. */
const SANITIZE_RE = /[<>:"/\\|?* ]/g;

/** Parent-directory sequences that must never appear in a sanitized name.
 *  Handled separately from SANITIZE_RE because `.` is legal inside a filename
 *  (e.g. `v1.2.3`) — only the `..` sequence is dangerous. */
const PARENT_DIR_RE = /\.\.+/g;

const GUID_RE = /^guid:\s*([0-9a-f]+)/m;

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Sanitize an arbitrary string for use as a single path component in a backup
 * directory name. Strips forbidden characters, collapses `..` sequences, and
 * forces the result through `path.basename` so any residual path separators
 * cannot escape the parent directory.
 *
 * This is defense-in-depth — the current callers all pass hardcoded tool names
 * and branch names read from cm, but a single-component guarantee removes an
 * entire class of path-traversal footguns.
 */
function sanitizePathComponent(name: string): string {
    const base = name
        .replace(SANITIZE_RE, '_')
        .replace(PARENT_DIR_RE, '_');
    // Defensive: path.basename strips any residual directory separators that
    // might have been introduced by a pathological input. Empty result falls
    // back to a placeholder so we never construct `path.join(base, '')`.
    const single = path.basename(base);
    return single.length > 0 ? single : 'unnamed';
}

function flattenPath(filePath: string): string {
    return filePath.replace(/[\\/]/g, '_');
}

function formatTimestamp(date: Date): string {
    const y = date.getFullYear();
    const mo = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const h = String(date.getHours()).padStart(2, '0');
    const mi = String(date.getMinutes()).padStart(2, '0');
    const s = String(date.getSeconds()).padStart(2, '0');
    return `${y}${mo}${d}-${h}${mi}${s}`;
}

function isUnityCritical(filePath: string): boolean {
    return UNITY_CRITICAL_SET.has(path.extname(filePath).toLowerCase());
}

function extractGuid(content: Buffer): string | null {
    const text = content.toString('utf-8');
    const match = GUID_RE.exec(text);
    return match ? match[1] : null;
}

// ── Public API ─────────────────────────────────────────────────────────

export function resolveBackupDir(workspace: string, overrideDir?: string): string {
    const base = overrideDir ?? process.env.PLASTIC_BACKUP_DIR ?? path.join(os.homedir(), '.plastic-scm-backups');
    return path.join(base, sanitizePathComponent(workspace));
}

export async function createBackup(options: CreateBackupOptions): Promise<string> {
    const {
        tool,
        workspace,
        workspaceRoot,
        files,
        getBaseContent,
        backupBaseDir,
    } = options;

    const timestamp = formatTimestamp(new Date());
    const wsBackupDir = resolveBackupDir(workspace, backupBaseDir);
    // Sanitize the tool name so callers cannot inject `..` or path separators
    // into the backup directory path, even transitively via template strings.
    const safeTool = sanitizePathComponent(tool);
    const backupDir = path.join(wsBackupDir, `${timestamp}_${safeTool}`);
    const filesDir = path.join(backupDir, 'files');
    const baseDir = path.join(backupDir, 'base');

    await fs.mkdir(filesDir, { recursive: true });
    await fs.mkdir(baseDir, { recursive: true });

    const entries: BackupFileEntry[] = [];

    for (const file of files) {
        const flatName = flattenPath(file.path);
        const backupFile = path.join('files', flatName);
        const srcPath = path.join(workspaceRoot, file.path);

        // Copy working-copy file
        let content: Buffer;
        try {
            content = await fs.readFile(srcPath);
        } catch {
            // File may have been deleted; skip
            continue;
        }

        await fs.writeFile(path.join(backupDir, backupFile), content);

        // Attempt to capture base version
        let baseFile: string | null = null;
        try {
            const baseContent = await getBaseContent(file.path);
            if (baseContent !== null) {
                const baseRelPath = path.join('base', flatName);
                await fs.writeFile(path.join(backupDir, baseRelPath), baseContent);
                baseFile = baseRelPath;
            }
        } catch {
            // Base not available (e.g. private/added file) — leave null
        }

        const guid = file.path.endsWith('.meta') ? extractGuid(content) : null;

        entries.push({
            path: file.path,
            changeType: file.changeType,
            backupFile,
            baseFile,
            sizeBytes: content.length,
            isUnityCritical: isUnityCritical(file.path),
            guid,
        });
    }

    const unityCriticalCount = entries.filter(e => e.isUnityCritical).length;

    const manifest: BackupManifest = {
        version: 1,
        timestamp,
        tool,
        workspace,
        totalFiles: entries.length,
        unityCriticalFiles: unityCriticalCount,
        files: entries,
    };

    await fs.writeFile(
        path.join(backupDir, 'manifest.json'),
        JSON.stringify(manifest, null, 2),
    );

    return backupDir;
}

export async function listBackups(
    workspace: string,
    backupBaseDir?: string,
): Promise<Array<{ id: string; timestamp: string; tool: string; totalFiles: number; unityCriticalFiles: number; path: string }>> {
    const wsDir = resolveBackupDir(workspace, backupBaseDir);

    let entries: string[];
    try {
        entries = await fs.readdir(wsDir);
    } catch {
        return [];
    }

    const results: Array<{ id: string; timestamp: string; tool: string; totalFiles: number; unityCriticalFiles: number; path: string }> = [];

    for (const entry of entries) {
        const manifestPath = path.join(wsDir, entry, 'manifest.json');
        try {
            const raw = await fs.readFile(manifestPath, 'utf-8');
            const manifest = JSON.parse(raw) as BackupManifest;
            results.push({
                id: entry,
                timestamp: manifest.timestamp,
                tool: manifest.tool,
                totalFiles: manifest.totalFiles,
                unityCriticalFiles: manifest.unityCriticalFiles,
                path: path.join(wsDir, entry),
            });
        } catch {
            // Skip dirs without valid manifest
        }
    }

    // Sort newest-first (timestamp strings are lexicographically sortable)
    results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return results;
}

export async function getBackupManifest(
    workspace: string,
    backupId: string,
    backupBaseDir?: string,
): Promise<BackupManifest | null> {
    const wsDir = resolveBackupDir(workspace, backupBaseDir);
    const manifestPath = path.join(wsDir, backupId, 'manifest.json');

    try {
        const raw = await fs.readFile(manifestPath, 'utf-8');
        return JSON.parse(raw) as BackupManifest;
    } catch {
        return null;
    }
}

export async function restoreBackup(
    workspace: string,
    workspaceRoot: string,
    backupId: string,
    filterPaths?: string[],
    backupBaseDir?: string,
): Promise<string[]> {
    const wsDir = resolveBackupDir(workspace, backupBaseDir);
    const backupDir = path.join(wsDir, backupId);

    const manifestPath = path.join(backupDir, 'manifest.json');
    let manifest: BackupManifest;
    try {
        const raw = await fs.readFile(manifestPath, 'utf-8');
        manifest = JSON.parse(raw) as BackupManifest;
    } catch {
        return [];
    }

    const filesToRestore = filterPaths
        ? manifest.files.filter(f => filterPaths.includes(f.path))
        : manifest.files;

    const restored: string[] = [];

    for (const entry of filesToRestore) {
        const src = path.join(backupDir, entry.backupFile);
        const dest = path.join(workspaceRoot, entry.path);

        try {
            await fs.mkdir(path.dirname(dest), { recursive: true });
            await fs.copyFile(src, dest);
            restored.push(entry.path);
        } catch {
            // Skip files that can't be restored
        }
    }

    return restored;
}
