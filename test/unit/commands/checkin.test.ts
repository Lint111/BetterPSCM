import { describe, it, expect, vi, beforeEach } from 'vitest';
import { window, commands } from '../../mocks/vscode';

vi.mock('../../../src/core/workspace', () => ({
	checkinFiles: vi.fn(),
}));

import { checkinFiles } from '../../../src/core/workspace';
import { registerCheckinCommands } from '../../../src/commands/checkin';
import { COMMANDS } from '../../../src/constants';

const mockCheckinFiles = vi.mocked(checkinFiles);

function createMockProvider(options: {
	changes?: Array<{ path: string; changeType: string; dataType: string }>;
	stagedPaths?: string[];
	inputBoxValue?: string;
} = {}) {
	const changes = options.changes ?? [];
	const stagedPaths = new Set(options.stagedPaths ?? []);

	return {
		getAllChanges: () => changes,
		getStagingManager: () => ({
			splitChanges: (c: any[]) => ({
				staged: c.filter((x: any) => stagedPaths.has(x.path)),
				unstaged: c.filter((x: any) => !stagedPaths.has(x.path)),
			}),
			unstageAll: vi.fn(),
		}),
		getInputBoxValue: () => options.inputBoxValue ?? '',
		clearInputBox: vi.fn(),
		refresh: vi.fn().mockResolvedValue(undefined),
	};
}

describe('checkin commands', () => {
	let registeredHandlers: Record<string, Function>;

	beforeEach(() => {
		vi.clearAllMocks();
		registeredHandlers = {};

		commands.registerCommand.mockImplementation((cmd: string, handler: Function) => {
			registeredHandlers[cmd] = handler;
			return { dispose: vi.fn() };
		});

		const provider = createMockProvider({
			changes: [
				{ path: '/a.ts', changeType: 'changed', dataType: 'File' },
				{ path: '/b.ts', changeType: 'added', dataType: 'File' },
			],
			stagedPaths: ['/a.ts'],
			inputBoxValue: 'fix bug',
		});

		registerCheckinCommands({ subscriptions: { push: vi.fn() } } as any, provider as any);
	});

	it('registers checkin and checkinAll commands', () => {
		expect(registeredHandlers[COMMANDS.checkin]).toBeDefined();
		expect(registeredHandlers[COMMANDS.checkinAll]).toBeDefined();
	});

	it('checkin uses staged files only', async () => {
		mockCheckinFiles.mockResolvedValue({ changesetId: 1, branchName: '/main' });

		await registeredHandlers[COMMANDS.checkin]();

		expect(mockCheckinFiles).toHaveBeenCalledWith(['/a.ts'], 'fix bug');
	});

	it('checkinAll uses all files', async () => {
		mockCheckinFiles.mockResolvedValue({ changesetId: 1, branchName: '/main' });

		await registeredHandlers[COMMANDS.checkinAll]();

		expect(mockCheckinFiles).toHaveBeenCalledWith(['/a.ts', '/b.ts'], 'fix bug');
	});

	it('shows warning when no staged files', async () => {
		// Re-register with empty staging
		registeredHandlers = {};
		commands.registerCommand.mockImplementation((cmd: string, handler: Function) => {
			registeredHandlers[cmd] = handler;
			return { dispose: vi.fn() };
		});

		const provider = createMockProvider({
			changes: [{ path: '/a.ts', changeType: 'changed', dataType: 'File' }],
			stagedPaths: [],
		});
		registerCheckinCommands({ subscriptions: { push: vi.fn() } } as any, provider as any);

		await registeredHandlers[COMMANDS.checkin]();
		expect(window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('No staged'));
	});

	it('shows error on checkin failure', async () => {
		mockCheckinFiles.mockRejectedValue(new Error('cm checkin failed'));

		await registeredHandlers[COMMANDS.checkin]();
		expect(window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('Check-in failed'));
	});
});
