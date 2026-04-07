import { defineConfig } from 'vitest/config';
import * as path from 'path';

/**
 * Integration test config — runs the suite under test/integration/ which drives
 * a real `cm` binary against a real Plastic workspace.
 *
 * These tests are opt-in and require:
 *   - `cm` on PATH, or PLASTIC_CM_PATH pointing at the binary
 *   - BPSCM_INTEGRATION_WORKSPACE pointing at a local Plastic workspace
 *     (see test/integration/README.md for setup)
 *
 * Tests run serially (single worker, single fork) because they share one
 * workspace and mutate cm state. Timeout is generous since cm operations
 * can take several seconds.
 */
export default defineConfig({
	test: {
		include: ['test/integration/**/*.test.ts'],
		globals: true,
		// Serial execution — tests share one workspace and must not race.
		// Vitest 4 moved pool config to top-level flags.
		pool: 'forks',
		fileParallelism: false,
		// cm operations can be slow (tens of seconds for checkin, minutes in
		// pathological cases). Keep per-test timeout generous but bounded so
		// a hung cm process fails the test instead of hanging CI forever.
		testTimeout: 60_000,
		hookTimeout: 120_000,
	},
	resolve: {
		alias: {
			// Logger uses require('vscode') with a stderr fallback — alias to the
			// same mock the unit tests use so the logger resolves cleanly.
			vscode: path.resolve(__dirname, 'test/mocks/vscode.ts'),
		},
	},
});
