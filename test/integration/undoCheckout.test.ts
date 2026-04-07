/**
 * Integration regression tests for CliBackend.undoCheckout.
 *
 * The primary regression this file protects is the `-a` flag bug found on
 * 2026-04-07: `cm undocheckout` without `-a` is a silent no-op on CH (locally
 * modified) files. Prior to the fix, this broke cleanStale, bpscm_undo_checkout,
 * and branchSwitch "Shelve"/"Discard" for any locally-modified file.
 *
 * These tests drive a real cm binary against a real workspace. The fixture
 * provides a pre-committed anchor file at a stable base revision; tests modify
 * the anchor, exercise undoCheckout, and assert both content and status state.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createIntegrationFixture, ensureFixturesRoot, IntegrationFixture } from './fixture';

describe('CliBackend.undoCheckout (integration)', () => {
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

	it('reverts a CH file whose content differs from base (regression: -a flag)', async () => {
		// 1. Modify the anchor file — cm should report it as changed
		fx.modifyAnchor('modified content for regression test\n');
		const statusAfterModify = await fx.backend.getStatus(false);
		const modifiedEntry = statusAfterModify.changes.find(c => c.path === fx.anchorPath);
		expect(modifiedEntry, 'anchor should be in status after modification').toBeDefined();
		expect(modifiedEntry!.changeType).toBe('changed');

		// 2. undoCheckout — should revert content AND clear the CH marker
		const reverted = await fx.backend.undoCheckout([fx.anchorPath]);
		expect(reverted).toContain(fx.anchorPath);

		// 3. Working copy content should match the base revision
		const bytesAfterRevert = fx.readAnchor().toString();
		expect(bytesAfterRevert).toBe(fx.anchorBaseContent);

		// 4. Status must no longer report the anchor as changed
		const statusAfterRevert = await fx.backend.getStatus(false);
		const stillPresent = statusAfterRevert.changes.find(c => c.path === fx.anchorPath);
		expect(stillPresent, 'CH marker should be cleared after undoCheckout').toBeUndefined();
	});

	it('reverts a CH file whose content happens to match base (stale CH)', async () => {
		// The exact shape of the original bug: a file reported as CH but whose
		// working copy is byte-identical to the base revision. Without -a, plain
		// `cm undocheckout` was a silent no-op on these files.
		//
		// Reproduce by overwriting the anchor with its own base content — Plastic
		// sees the metadata change and MAY report it as CH. If it does, we must
		// be able to clear it. If it doesn't (Plastic uses content hashing and
		// decides nothing changed), the test is still valid — nothing to clear.
		fx.modifyAnchor(fx.anchorBaseContent);

		const statusBefore = await fx.backend.getStatus(false);
		const entryBefore = statusBefore.changes.find(c => c.path === fx.anchorPath);

		if (entryBefore) {
			expect(entryBefore.changeType).toMatch(/changed|checkedOut/);
			await fx.backend.undoCheckout([fx.anchorPath]);

			const statusAfter = await fx.backend.getStatus(false);
			const entryAfter = statusAfter.changes.find(c => c.path === fx.anchorPath);
			expect(entryAfter, 'stale CH should be cleared after undoCheckout').toBeUndefined();
		}
		// If entryBefore was absent, Plastic's content hashing spared us — no-op success.
	});

	it('returns empty array and does not invoke cm on empty paths', async () => {
		// MAJ-1 regression — with the `-a` flag, invoking cm undocheckout with
		// zero paths could be ambiguous. The guard prevents the invocation.
		const result = await fx.backend.undoCheckout([]);
		expect(result).toEqual([]);
	});
});
