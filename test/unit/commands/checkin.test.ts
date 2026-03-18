import { describe, it, expect, vi, beforeEach } from 'vitest';
import { window, commands } from '../../mocks/vscode';

import { registerCheckinCommands } from '../../../src/commands/checkin';
import { COMMANDS } from '../../../src/constants';

function createMockProvider(options: {
	changes?: Array<{ path: string; changeType: string; dataType: string }>;
	stagedPaths?: string[];
	inputBoxValue?: string;
} = {}) {
	const changes = options.changes ?? [];
	const stagedPaths = options.stagedPaths ?? [];

	const mockCheckin = vi.fn().mockResolvedValue({ changesetId: 1, branchName: '/main', autoExcluded: [], autoAdded: [] });

	return {
		getAllChanges: () => changes,
		getService: () => ({
			getStagedPaths: () => stagedPaths,
			checkin: mockCheckin,
		}),
		getInputBoxValue: () => options.inputBoxValue ?? '',
		clearInputBox: vi.fn(),
		refresh: vi.fn().mockResolvedValue(undefined),
		_mockCheckin: mockCheckin,
	};
}

describe('checkin commands', () => {
	let registeredHandlers: Record<string, Function>;
	let provider: ReturnType<typeof createMockProvider>;

	beforeEach(() => {
		vi.clearAllMocks();
		registeredHandlers = {};

		commands.registerCommand.mockImplementation((cmd: string, handler: Function) => {
			registeredHandlers[cmd] = handler;
			return { dispose: vi.fn() };
		});

		provider = createMockProvider({
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
		await registeredHandlers[COMMANDS.checkin]();

		expect(provider._mockCheckin).toHaveBeenCalledWith({ comment: 'fix bug', all: false });
	});

	it('checkinAll uses all files', async () => {
		await registeredHandlers[COMMANDS.checkinAll]();

		expect(provider._mockCheckin).toHaveBeenCalledWith({ comment: 'fix bug', all: true });
	});

	it('shows warning when no staged files', async () => {
		// Re-register with empty staging
		registeredHandlers = {};
		commands.registerCommand.mockImplementation((cmd: string, handler: Function) => {
			registeredHandlers[cmd] = handler;
			return { dispose: vi.fn() };
		});

		const emptyProvider = createMockProvider({
			changes: [{ path: '/a.ts', changeType: 'changed', dataType: 'File' }],
			stagedPaths: [],
		});
		registerCheckinCommands({ subscriptions: { push: vi.fn() } } as any, emptyProvider as any);

		await registeredHandlers[COMMANDS.checkin]();
		expect(window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('No staged'));
	});

	it('shows error on checkin failure', async () => {
		provider._mockCheckin.mockRejectedValue(new Error('cm checkin failed'));

		await registeredHandlers[COMMANDS.checkin]();
		expect(window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('Check-in failed'));
	});
});
