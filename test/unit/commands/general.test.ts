import { describe, it, expect, vi, beforeEach } from 'vitest';
import { window, commands, Uri } from '../../mocks/vscode';

vi.mock('../../../src/util/uri', () => ({
	buildPlasticUri: vi.fn((ws: string, rev: string, path: string) =>
		Uri.from({ scheme: 'plastic', authority: ws, path: `/${path}`, query: rev }),
	),
}));

vi.mock('../../../src/api/client', () => ({
	getWorkspaceGuid: vi.fn(() => 'ws-guid-123'),
}));

vi.mock('../../../src/util/logger', () => ({
	logError: vi.fn(),
}));

import { registerGeneralCommands } from '../../../src/commands/general';
import type { NormalizedChange } from '../../../src/core/types';
import { COMMANDS } from '../../../src/constants';

describe('openChange command', () => {
	let registeredHandlers: Record<string, Function>;

	beforeEach(() => {
		vi.clearAllMocks();
		registeredHandlers = {};

		// showTextDocument is not on the shared mock — add it per-test
		(window as any).showTextDocument = vi.fn();

		commands.registerCommand.mockImplementation((cmd: string, handler: Function) => {
			registeredHandlers[cmd] = handler;
			return { dispose: vi.fn() };
		});

		const mockProvider = {
			refresh: vi.fn().mockResolvedValue(undefined),
		};

		registerGeneralCommands(
			{ subscriptions: { push: vi.fn() } } as any,
			mockProvider as any,
		);
	});

	it('opens file directly for added files', async () => {
		const uri = Uri.file('/workspace/newFile.ts');
		const change: NormalizedChange = {
			path: 'newFile.ts',
			changeType: 'added',
			dataType: 'File',
		};

		await registeredHandlers[COMMANDS.openChange](uri, change);
		expect(window.showTextDocument).toHaveBeenCalledWith(uri);
		expect(commands.executeCommand).not.toHaveBeenCalled();
	});

	it('opens file directly for private files', async () => {
		const uri = Uri.file('/workspace/untracked.ts');
		const change: NormalizedChange = {
			path: 'untracked.ts',
			changeType: 'private',
			dataType: 'File',
		};

		await registeredHandlers[COMMANDS.openChange](uri, change);
		expect(window.showTextDocument).toHaveBeenCalledWith(uri);
	});

	it('opens diff for changed files with revisionGuid', async () => {
		const uri = Uri.file('/workspace/src/modified.ts');
		const change: NormalizedChange = {
			path: 'src/modified.ts',
			changeType: 'changed',
			dataType: 'File',
			revisionGuid: 'rev-abc-123',
		};

		await registeredHandlers[COMMANDS.openChange](uri, change);
		expect(commands.executeCommand).toHaveBeenCalledWith(
			'vscode.diff',
			expect.objectContaining({ scheme: 'plastic' }),
			uri,
			expect.stringContaining('modified.ts'),
		);
	});

	it('opens diff for changed files without revisionGuid (CLI fallback)', async () => {
		const uri = Uri.file('/workspace/src/modified.ts');
		const change: NormalizedChange = {
			path: 'src/modified.ts',
			changeType: 'changed',
			dataType: 'File',
		};

		await registeredHandlers[COMMANDS.openChange](uri, change);
		expect(commands.executeCommand).toHaveBeenCalledWith(
			'vscode.diff',
			expect.objectContaining({ scheme: 'plastic' }),
			uri,
			expect.stringContaining('modified.ts'),
		);
	});

	it('opens diff for checkedOut files', async () => {
		const uri = Uri.file('/workspace/src/checkout.ts');
		const change: NormalizedChange = {
			path: 'src/checkout.ts',
			changeType: 'checkedOut',
			dataType: 'File',
		};

		await registeredHandlers[COMMANDS.openChange](uri, change);
		expect(commands.executeCommand).toHaveBeenCalledWith(
			'vscode.diff',
			expect.anything(),
			uri,
			expect.any(String),
		);
	});

	it('falls back to opening file when no change metadata', async () => {
		const uri = Uri.file('/workspace/src/file.ts');
		await registeredHandlers[COMMANDS.openChange](uri);
		expect(window.showTextDocument).toHaveBeenCalledWith(uri);
	});
});
