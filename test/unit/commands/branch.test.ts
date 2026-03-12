import { describe, it, expect, vi, beforeEach } from 'vitest';
import { window, commands } from '../../mocks/vscode';

vi.mock('../../../src/core/workspace', () => ({
	listBranches: vi.fn(),
	createBranch: vi.fn(),
	deleteBranch: vi.fn(),
	switchBranch: vi.fn(),
	getCurrentBranch: vi.fn(),
}));

vi.mock('../../../src/util/logger', () => ({
	logError: vi.fn(),
}));

import { registerBranchCommands } from '../../../src/commands/branch';
import { listBranches, createBranch, deleteBranch, switchBranch, getCurrentBranch } from '../../../src/core/workspace';
import { COMMANDS } from '../../../src/constants';

const mockListBranches = vi.mocked(listBranches);
const mockCreateBranch = vi.mocked(createBranch);
const mockDeleteBranch = vi.mocked(deleteBranch);
const mockSwitchBranch = vi.mocked(switchBranch);
const mockGetCurrentBranch = vi.mocked(getCurrentBranch);

describe('branch commands', () => {
	let registeredHandlers: Record<string, Function>;
	let mockProvider: any;
	let mockBranchTree: any;

	beforeEach(() => {
		vi.clearAllMocks();
		registeredHandlers = {};

		commands.registerCommand.mockImplementation((cmd: string, handler: Function) => {
			registeredHandlers[cmd] = handler;
			return { dispose: vi.fn() };
		});

		mockProvider = {
			refresh: vi.fn().mockResolvedValue(undefined),
		};

		mockBranchTree = {
			refresh: vi.fn(),
		};

		registerBranchCommands(
			{ subscriptions: { push: vi.fn() } } as any,
			mockProvider as any,
			mockBranchTree as any,
		);
	});

	it('registers all three branch commands', () => {
		expect(registeredHandlers[COMMANDS.switchBranch]).toBeDefined();
		expect(registeredHandlers[COMMANDS.createBranch]).toBeDefined();
		expect(registeredHandlers[COMMANDS.deleteBranch]).toBeDefined();
	});

	describe('switchBranch', () => {
		it('shows QuickPick and switches', async () => {
			mockListBranches.mockResolvedValue([
				{ id: 1, name: '/main', owner: 'user', date: '', isMain: true },
				{ id: 2, name: '/main/feature', owner: 'dev', date: '', isMain: false },
			]);
			mockGetCurrentBranch.mockResolvedValue('/main');
			window.showQuickPick.mockResolvedValue({ label: '/main/feature' });

			await registeredHandlers[COMMANDS.switchBranch]();

			expect(mockSwitchBranch).toHaveBeenCalledWith('/main/feature');
			expect(mockProvider.refresh).toHaveBeenCalled();
			expect(mockBranchTree.refresh).toHaveBeenCalled();
		});

		it('filters current branch from QuickPick', async () => {
			mockListBranches.mockResolvedValue([
				{ id: 1, name: '/main', owner: 'user', date: '', isMain: true },
				{ id: 2, name: '/main/feature', owner: 'dev', date: '', isMain: false },
			]);
			mockGetCurrentBranch.mockResolvedValue('/main');
			window.showQuickPick.mockResolvedValue({ label: '/main/feature' });

			await registeredHandlers[COMMANDS.switchBranch]();

			const quickPickItems = window.showQuickPick.mock.calls[0][0];
			expect(quickPickItems).toHaveLength(1);
			expect(quickPickItems[0].label).toBe('/main/feature');
		});

		it('does nothing when user cancels QuickPick', async () => {
			mockListBranches.mockResolvedValue([]);
			mockGetCurrentBranch.mockResolvedValue(undefined);
			window.showQuickPick.mockResolvedValue(undefined);

			await registeredHandlers[COMMANDS.switchBranch]();
			expect(mockSwitchBranch).not.toHaveBeenCalled();
		});
	});

	describe('createBranch', () => {
		it('creates branch from input', async () => {
			window.showInputBox.mockResolvedValue('/main/newBranch');
			mockCreateBranch.mockResolvedValue({
				id: 3, name: '/main/newBranch', owner: '', date: '', isMain: false,
			});

			await registeredHandlers[COMMANDS.createBranch]();

			expect(mockCreateBranch).toHaveBeenCalledWith('/main/newBranch');
			expect(mockBranchTree.refresh).toHaveBeenCalled();
		});

		it('does nothing when user cancels input', async () => {
			window.showInputBox.mockResolvedValue(undefined);

			await registeredHandlers[COMMANDS.createBranch]();
			expect(mockCreateBranch).not.toHaveBeenCalled();
		});
	});

	describe('deleteBranch', () => {
		it('deletes branch after confirmation', async () => {
			window.showWarningMessage.mockResolvedValue('Delete');

			await registeredHandlers[COMMANDS.deleteBranch]({
				branch: { id: 5, name: '/main/old', isCurrent: false },
			});

			expect(mockDeleteBranch).toHaveBeenCalledWith(5);
			expect(mockBranchTree.refresh).toHaveBeenCalled();
		});

		it('does not delete current branch', async () => {
			await registeredHandlers[COMMANDS.deleteBranch]({
				branch: { id: 1, name: '/main', isCurrent: true },
			});

			expect(mockDeleteBranch).not.toHaveBeenCalled();
			expect(window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('Cannot delete'));
		});

		it('does nothing when user cancels', async () => {
			window.showWarningMessage.mockResolvedValue(undefined);

			await registeredHandlers[COMMANDS.deleteBranch]({
				branch: { id: 5, name: '/main/old', isCurrent: false },
			});

			expect(mockDeleteBranch).not.toHaveBeenCalled();
		});
	});
});
