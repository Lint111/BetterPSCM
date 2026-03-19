import * as esbuild from 'esbuild';

const isWatch = process.argv.includes('--watch');
const isProd = process.env.NODE_ENV === 'production';

/** @type {esbuild.BuildOptions} */
const sharedConfig = {
	bundle: true,
	format: 'cjs',
	platform: 'node',
	target: 'node18',
	sourcemap: !isProd,
	minify: isProd,
	logLevel: 'info',
};

/** Extension host bundle */
const extensionConfig = {
	...sharedConfig,
	entryPoints: ['src/extension.ts'],
	outfile: 'dist/extension.js',
	external: ['vscode'],
};

/** MCP server bundle (standalone process, no vscode dependency) */
const mcpServerConfig = {
	...sharedConfig,
	entryPoints: ['src/mcp/server.ts'],
	outfile: 'dist/mcp-server.js',
	external: ['vscode'], // marked external but logger handles graceful fallback
	// No shebang banner — VS Code MCP definition provider already specifies `node` as command
};

if (isWatch) {
	const ctx = await esbuild.context(extensionConfig);
	await ctx.watch();
	const mcpCtx = await esbuild.context(mcpServerConfig);
	await mcpCtx.watch();
	console.log('Watching for changes...');
} else {
	await Promise.all([
		esbuild.build(extensionConfig),
		esbuild.build(mcpServerConfig),
	]);
}
