/**
 * Integration test fixture — wires CliBackend to a real Plastic workspace.
 *
 * The workspace is read from BPSCM_INTEGRATION_WORKSPACE — there is deliberately
 * no hardcoded default, so nobody's machine is assumed.
 *
 * Design:
 * - A single committed "anchor" file lives at __bpscm_integration__/anchor.txt
 *   with a known base revision. Tests that need a CH/CO file modify the anchor,
 *   run the operation under test, and assert. `undoCheckout` restores the anchor
 *   to base in `afterEach` — deterministic, zero filesystem churn, no accumulating
 *   LD records in cm's history.
 *
 * - Tests that need private (PR) or scratch files write to a per-test subdirectory
 *   that is NEVER added to source control. cm status ignores these files when
 *   showPrivate=false, and teardown removes the subdirectory with `rmSync`.
 *
 * - The anchor file is created once on first run via `ensureFixturesRoot()`.
 *   Subsequent runs reuse it without incurring more commits.
 *
 * Setup: see test/integration/README.md.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { CliBackend } from '../../src/core/backendCli';
import { probeCmBinary, execCmWithContext } from '../../src/core/cmCli';
import { createPlasticContext, PlasticContext } from '../../src/core/context';

/** Env var holding the absolute path to a writable Plastic workspace. */
const WORKSPACE_ENV = 'BPSCM_INTEGRATION_WORKSPACE';

/** Top-level subdirectory inside the workspace reserved for integration fixtures. */
const FIXTURES_ROOT = '__bpscm_integration__';

/** Filename of the shared committed anchor file used by CH/CO tests. */
const ANCHOR_FILE = 'anchor.txt';

/** Base-revision content of the anchor file. Kept stable so regressions show up. */
const ANCHOR_BASE_CONTENT = 'bpscm-integration-anchor\n';

/** Scratch subdirectory pattern — each test gets its own, never committed. */
const SCRATCH_PREFIX = 'scratch-';

export interface IntegrationFixture {
	/** Absolute path to the workspace root. */
	readonly workspaceRoot: string;
	/** PlasticContext owned by this fixture — pass it into any code under test that accepts one. */
	readonly context: PlasticContext;
	/** Workspace-relative path of the committed anchor file (e.g. `__bpscm_integration__/anchor.txt`). */
	readonly anchorPath: string;
	/** Absolute path of the committed anchor file. */
	readonly anchorPathAbs: string;
	/** Base content the anchor is restored to on teardown. */
	readonly anchorBaseContent: string;
	/** Absolute path of the per-test scratch directory. */
	readonly scratchDirAbs: string;
	/** Workspace-relative path of the per-test scratch directory. */
	readonly scratchDir: string;
	/** Backend wired to the fixture context. */
	readonly backend: CliBackend;
	/** Overwrite the anchor file with new content (test simulates a CH modification). */
	modifyAnchor(content: string | Buffer): void;
	/** Read the current anchor file bytes. */
	readAnchor(): Buffer;
	/** Write a private (never-committed) file into the scratch directory. Returns workspace-relative path. */
	writeScratch(relName: string, content: string | Buffer): string;
	/** Run an arbitrary cm command against the workspace. */
	rawCm(args: string[]): Promise<import('../../src/core/cmCli').CmResult>;
	/** Restore the anchor file to base and remove the scratch directory. */
	cleanup(): Promise<void>;
}

/**
 * Resolve the workspace root from the BPSCM_INTEGRATION_WORKSPACE env var.
 * Throws a descriptive error if the var is unset or the path is not a
 * Plastic workspace. No hardcoded default — every developer and CI runner
 * provides their own throwaway workspace. See test/integration/README.md.
 */
function resolveWorkspaceRoot(): string {
	const raw = process.env[WORKSPACE_ENV]?.trim();
	if (!raw) {
		throw new Error(
			`${WORKSPACE_ENV} is not set. Integration tests require a throwaway Plastic workspace. ` +
			`See test/integration/README.md for the setup (it's a one-time ~2 minute thing: ` +
			`create a local repo, bind a workspace, export the env var).`,
		);
	}
	if (!existsSync(join(raw, '.plastic'))) {
		throw new Error(
			`${WORKSPACE_ENV}="${raw}" does not contain a .plastic folder. ` +
			`The path must point at a valid Plastic workspace root. ` +
			`See test/integration/README.md for setup.`,
		);
	}
	return raw;
}

/**
 * Build a PlasticContext for the integration test workspace. Probes the cm
 * binary once and freezes the result — this is how tests achieve workspace
 * isolation without touching module-level cmPath/workspaceRoot globals.
 */
async function buildIntegrationContext(): Promise<PlasticContext> {
	const workspaceRoot = resolveWorkspaceRoot();
	const cmPath = await probeCmBinary();
	if (!cmPath) {
		throw new Error(
			`cm binary not found. Install Plastic SCM or set PLASTIC_CM_PATH to the cm executable.`,
		);
	}
	return createPlasticContext({ workspaceRoot, cmPath });
}

/**
 * Ensure the fixtures root exists and the anchor file is committed at its known
 * base revision. Idempotent — safe to call from every `beforeAll`.
 *
 * On first run: creates `__bpscm_integration__/`, writes the anchor file,
 * `cm add`s it, `cm checkin`s with a fixed comment. Subsequent runs find the
 * anchor already in cm status as CI (unmodified) and return immediately.
 */
export async function ensureFixturesRoot(): Promise<void> {
	const ctx = await buildIntegrationContext();

	const fixturesAbs = join(ctx.workspaceRoot, FIXTURES_ROOT);
	const anchorAbs = join(fixturesAbs, ANCHOR_FILE);
	const anchorRel = `${FIXTURES_ROOT}/${ANCHOR_FILE}`;

	if (!existsSync(fixturesAbs)) {
		mkdirSync(fixturesAbs, { recursive: true });
	}

	const backend = new CliBackend(ctx);

	// If the anchor already exists on disk, make sure it's at base content and is
	// known to cm. If it's CH, restore it. If it's private, commit it.
	if (existsSync(anchorAbs)) {
		const status = await backend.getStatus(true);
		const entry = status.changes.find(c => c.path === anchorRel);
		if (entry?.changeType === 'changed' || entry?.changeType === 'checkedOut') {
			// Restore from previous run
			await backend.undoCheckout([anchorRel]).catch(() => { /* best-effort */ });
		} else if (entry?.changeType === 'private') {
			// Anchor exists on disk but was never committed — add + checkin now
			writeFileSync(anchorAbs, ANCHOR_BASE_CONTENT);
			await backend.addToSourceControl([anchorRel]);
			await backend.checkin([anchorRel], 'bpscm integration fixture: initialize anchor file');
		}
		// If already CI (no entry in status), nothing to do
		return;
	}

	// First-run path: create + add + checkin
	writeFileSync(anchorAbs, ANCHOR_BASE_CONTENT);
	await backend.addToSourceControl([anchorRel]);
	await backend.checkin([anchorRel], 'bpscm integration fixture: initialize anchor file');
}

/**
 * Create a fresh per-test fixture. Call in `beforeEach` and hold the result;
 * call `cleanup()` in `afterEach`.
 *
 * Each fixture builds its own PlasticContext and CliBackend instance — they
 * do not share state with other tests or with the module-level cmPath /
 * workspaceRoot globals.
 */
export async function createIntegrationFixture(): Promise<IntegrationFixture> {
	const ctx = await buildIntegrationContext();

	const anchorPath = `${FIXTURES_ROOT}/${ANCHOR_FILE}`;
	const anchorPathAbs = join(ctx.workspaceRoot, FIXTURES_ROOT, ANCHOR_FILE);

	const scratchName = `${SCRATCH_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const scratchDirAbs = join(ctx.workspaceRoot, FIXTURES_ROOT, scratchName);
	const scratchDir = `${FIXTURES_ROOT}/${scratchName}`;
	mkdirSync(scratchDirAbs, { recursive: true });

	const backend = new CliBackend(ctx);

	const fixture: IntegrationFixture = {
		workspaceRoot: ctx.workspaceRoot,
		context: ctx,
		anchorPath,
		anchorPathAbs,
		anchorBaseContent: ANCHOR_BASE_CONTENT,
		scratchDirAbs,
		scratchDir,
		backend,

		modifyAnchor(content): void {
			writeFileSync(anchorPathAbs, content);
		},

		readAnchor(): Buffer {
			return readFileSync(anchorPathAbs);
		},

		writeScratch(relName, content): string {
			const abs = join(scratchDirAbs, relName);
			const parentDir = relName.includes('/')
				? join(scratchDirAbs, relName.slice(0, relName.lastIndexOf('/')))
				: scratchDirAbs;
			if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });
			writeFileSync(abs, content);
			return `${scratchDir}/${relName}`;
		},

		rawCm(args): Promise<import('../../src/core/cmCli').CmResult> {
			return execCmWithContext(ctx, args);
		},

		async cleanup(): Promise<void> {
			// Restore the anchor to base content if the test modified it. Always
			// attempt this — undoCheckout's empty-paths guard handles the no-op
			// case, and the CH/CO check against cm status avoids unnecessary work.
			try {
				const status = await backend.getStatus(true);
				const toRevert: string[] = [];
				for (const c of status.changes) {
					// Revert the anchor if touched.
					if (c.path === anchorPath && (c.changeType === 'changed' || c.changeType === 'checkedOut')) {
						toRevert.push(c.path);
					}
					// Also revert any AD/CH/CO records inside this test's scratch dir.
					// Tests should use scratch for private files only, but guard anyway
					// so misbehaving tests can't leave committed state behind.
					if (c.path.startsWith(`${scratchDir}/`) && c.changeType !== 'private') {
						toRevert.push(c.path);
					}
				}
				if (toRevert.length > 0) {
					await backend.undoCheckout(toRevert).catch(() => { /* best-effort */ });
				}
			} catch {
				// ignore — we are cleaning up anyway
			}
			// Remove the scratch directory from disk. Since scratch files are never
			// committed, this cannot create LD records — cm doesn't know about them.
			try {
				rmSync(scratchDirAbs, { recursive: true, force: true });
			} catch {
				// ignore
			}
		},
	};

	return fixture;
}
