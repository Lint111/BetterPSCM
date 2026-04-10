/**
 * Integration tests for file history and blame (annotate).
 *
 * These exercise the `cm history` and `cm annotate` code paths against a real
 * Plastic workspace. They were added after discovering that `cm history` and
 * `cm annotate` do NOT support the `--dateformat` flag (only `cm find` does),
 * which caused both commands to fail with "Unexpected option --dateformat".
 *
 * The anchor file created by `ensureFixturesRoot()` has at least one committed
 * revision, so both history and blame should return non-empty results.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createIntegrationFixture, ensureFixturesRoot, IntegrationFixture } from './fixture';

describe('file history and blame (integration)', () => {
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

	// ── getFileHistory ─────────────────────────────────────────────────

	describe('getFileHistory', () => {
		it('returns at least one history entry for a committed file', async () => {
			const history = await fx.backend.getFileHistory(fx.anchorPath);
			expect(history.length).toBeGreaterThanOrEqual(1);

			// Each entry must have the required fields populated
			const entry = history[0];
			expect(entry.changesetId).toBeGreaterThan(0);
			expect(entry.branch).toBeTruthy();
			expect(entry.owner).toBeTruthy();
			expect(entry.date).toBeTruthy();
		});

		it('populates the type field for history entries', async () => {
			const history = await fx.backend.getFileHistory(fx.anchorPath);
			for (const entry of history) {
				expect(['added', 'changed', 'deleted', 'moved']).toContain(entry.type);
			}
		});
	});

	// ── getBlame ───────────────────────────────────────────────────────

	describe('getBlame', () => {
		it('returns at least one blame line for a committed file', async () => {
			const blame = await fx.backend.getBlame(fx.anchorPath);
			expect(blame.length).toBeGreaterThanOrEqual(1);

			// Each blame line must have the required fields populated
			const line = blame[0];
			expect(line.lineNumber).toBeGreaterThanOrEqual(1);
			expect(line.changesetId).toBeGreaterThan(0);
			expect(line.author).toBeTruthy();
			expect(line.date).toBeTruthy();
			expect(typeof line.content).toBe('string');
		});

		it('blame content matches the anchor file text', async () => {
			const blame = await fx.backend.getBlame(fx.anchorPath);
			// The anchor's base content is a single line — blame should reflect it.
			// Join all blame lines to reconstruct the file content.
			const reconstructed = blame.map(l => l.content).join('\n');
			expect(reconstructed).toContain('bpscm-integration-anchor');
		});
	});
});
