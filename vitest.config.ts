import { defineConfig } from 'vitest/config';
import * as path from 'path';

export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
		// Integration tests drive a real cm binary against a real workspace and
		// must be opted into via `npm run test:integration`.
		exclude: ['node_modules/**', 'test/integration/**'],
		globals: true,
	},
	resolve: {
		alias: {
			vscode: path.resolve(__dirname, 'test/mocks/vscode.ts'),
		},
	},
});
