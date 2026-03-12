import * as esbuild from 'esbuild';

const isWatch = process.argv.includes('--watch');
const isProd = process.env.NODE_ENV === 'production';

/** @type {esbuild.BuildOptions} */
const extensionConfig = {
	entryPoints: ['src/extension.ts'],
	bundle: true,
	outfile: 'dist/extension.js',
	external: ['vscode'],
	format: 'cjs',
	platform: 'node',
	target: 'node18',
	sourcemap: !isProd,
	minify: isProd,
	logLevel: 'info',
};

if (isWatch) {
	const ctx = await esbuild.context(extensionConfig);
	await ctx.watch();
	console.log('Watching for changes...');
} else {
	await esbuild.build(extensionConfig);
}
