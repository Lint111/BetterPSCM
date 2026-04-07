/**
 * Integration tests for the cm checkin / add / status round-trip.
 *
 * These cover the bread-and-butter SCM lifecycle that the unit tests can
 * only mock: write a private file, add it to source control, check it in,
 * verify it lands in cm status correctly, then revert / clean up. Each
 * step is a separate sub-call so failures pinpoint which transition broke.
 *
 * The fixture's anchor file is reused for revert-after-modify scenarios so
 * we don't accumulate per-test commits in the workspace history.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createIntegrationFixture, ensureFixturesRoot, IntegrationFixture } from './fixture';

describe('cm lifecycle (integration)', () => {
	let fx: IntegrationFixture;

	beforeAll(async () => {
		await ensureFixturesRoot();
	});

	beforeEach(async () => {
		fx = await createIntegrationFixture();
	});

	afterEach(async () => {
		if (fx) await fx.cleanup();
	});

	// ── addToSourceControl ──────────────────────────────────────────────

	describe('addToSourceControl', () => {
		it('promotes a private file to AD state', async () => {
			// Write a private file in the scratch dir (cm sees it as PR until added).
			const relPath = fx.writeScratch('to-add.txt', 'new content\n');

			// Sanity: cm status should report it as private
			const statusBefore = await fx.backend.getStatus(true);
			const beforeEntry = statusBefore.changes.find(c => c.path === relPath);
			expect(beforeEntry, 'private file should appear in status with showPrivate=true').toBeDefined();
			expect(beforeEntry!.changeType).toBe('private');

			// Promote to AD
			const added = await fx.backend.addToSourceControl([relPath]);
			expect(added).toContain(relPath);

			// After add, it must be in AD state
			const statusAfter = await fx.backend.getStatus(false);
			const afterEntry = statusAfter.changes.find(c => c.path === relPath);
			expect(afterEntry, 'file should be in status as added').toBeDefined();
			expect(afterEntry!.changeType).toBe('added');
		});

		it('returns empty array on empty input without invoking cm', async () => {
			const result = await fx.backend.addToSourceControl([]);
			expect(result).toEqual([]);
		});
	});

	// ── undoCheckout on AD files ───────────────────────────────────────

	describe('undoCheckout on AD files', () => {
		it('reverts an AD file back to private state', async () => {
			// Add a private file to make it AD
			const relPath = fx.writeScratch('ad-revert.txt', 'will be reverted\n');
			await fx.backend.addToSourceControl([relPath]);

			// Confirm AD state
			const statusBefore = await fx.backend.getStatus(false);
			const beforeEntry = statusBefore.changes.find(c => c.path === relPath);
			expect(beforeEntry?.changeType).toBe('added');

			// undoCheckout -a on an AD file removes the AD record. The file may
			// or may not stay on disk depending on Plastic's behavior — what we
			// care about is that the cm status entry is gone.
			await fx.backend.undoCheckout([relPath]);

			const statusAfter = await fx.backend.getStatus(false);
			const afterEntry = statusAfter.changes.find(c => c.path === relPath);
			expect(afterEntry, 'AD record should be cleared after undoCheckout -a').toBeUndefined();
		});
	});

	// ── getStatus path format round-trip ───────────────────────────────

	describe('getStatus path format', () => {
		it('returns workspace-relative paths with forward-slash separators', async () => {
			// Modify the anchor — should produce a CH entry with a workspace-
			// relative forward-slash path regardless of cm.exe's native format.
			fx.modifyAnchor('round-trip test\n');
			const status = await fx.backend.getStatus(false);
			const entry = status.changes.find(c => c.path === fx.anchorPath);
			expect(entry, 'anchor must be present in status').toBeDefined();
			// Path should not contain backslashes (Windows-form) or absolute drive letters
			expect(entry!.path).not.toMatch(/\\/);
			expect(entry!.path).not.toMatch(/^[a-zA-Z]:/);
			// Path should equal the workspace-relative anchor we wrote
			expect(entry!.path).toBe(fx.anchorPath);
		});

		it('round-trips a path through cm and matches workspace-relative form', async () => {
			// Write a private file in the scratch dir, look it up in status,
			// and verify the returned path is the exact workspace-relative
			// form we'd compute ourselves.
			const relPath = fx.writeScratch('roundtrip.txt', 'data\n');
			const status = await fx.backend.getStatus(true);
			const entry = status.changes.find(c => c.path === relPath);
			expect(entry, 'private file must round-trip via getStatus').toBeDefined();
			expect(entry!.path).toBe(relPath);
		});

		it('reports dataType=File for regular files', async () => {
			const relPath = fx.writeScratch('regular.txt', 'just a file\n');
			const status = await fx.backend.getStatus(true);
			const entry = status.changes.find(c => c.path === relPath);
			expect(entry?.dataType).toBe('File');
		});
	});

	// ── checkin (round-trip via the anchor) ────────────────────────────

	describe('checkin', () => {
		// Note: cm history is append-only — every checkin creates a new revision
		// that cannot be cleanly undone. To avoid accumulating commits in the
		// test workspace on every run, the checkin tests EXERCISE the checkin
		// code path against the existing anchor file (modify → checkin →
		// verify the new revision → revert) rather than creating fresh files
		// with new commits.

		it('checks in a modification to the anchor and returns a changeset id', async () => {
			// Modify the committed anchor with a unique payload so cm sees it
			// as truly changed (otherwise the checkin would no-op-fail).
			const uniquePayload = `integration test payload ${Date.now()}-${Math.random().toString(36).slice(2, 8)}\n`;
			fx.modifyAnchor(uniquePayload);

			// Sanity: cm reports the anchor as changed
			const statusBefore = await fx.backend.getStatus(false);
			const beforeEntry = statusBefore.changes.find(c => c.path === fx.anchorPath);
			expect(beforeEntry?.changeType).toBe('changed');

			// Run the checkin via the backend wrapper. Should return a positive
			// changeset id and a non-empty branch name.
			const result = await fx.backend.checkin([fx.anchorPath], 'integration: anchor checkin round-trip');
			expect(result.changesetId).toBeGreaterThan(0);
			expect(result.branchName).toBeTruthy();

			// After checkin the anchor is no longer in pending status — it's
			// the new CI state with the unique payload baked into history.
			const statusAfterCheckin = await fx.backend.getStatus(false);
			const afterCheckin = statusAfterCheckin.changes.find(c => c.path === fx.anchorPath);
			expect(afterCheckin, 'anchor should NOT appear in pending status after checkin').toBeUndefined();

			// Restore the anchor's base content so the next test starts clean.
			// The fixture's afterEach also covers this, but doing it here makes
			// the next assertion explicit and immediate. We modify back to the
			// known base content and check it in again.
			fx.modifyAnchor(fx.anchorBaseContent);
			const restoreResult = await fx.backend.checkin(
				[fx.anchorPath],
				'integration: restore anchor base content',
			);
			expect(restoreResult.changesetId).toBeGreaterThan(result.changesetId);
		});

		it('throws when checking in a path that has no changes', async () => {
			// Trying to check in the anchor when it's at base content should
			// fail — Plastic exits non-zero with "nothing to checkin" and the
			// backend wrapper rethrows.
			await expect(fx.backend.checkin([fx.anchorPath], 'no-op test'))
				.rejects.toThrow(/checkin/i);
		});
	});
});
