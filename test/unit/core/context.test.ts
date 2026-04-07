import { describe, it, expect, vi } from 'vitest';
import { createPlasticContext } from '../../../src/core/context';

// Mock cmCli before importing CliBackend so we can inspect how the backend
// dispatches between the context-aware and module-global exec paths.
vi.mock('../../../src/core/cmCli', () => ({
	execCm: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
	execCmToFile: vi.fn(),
	execCmWithContext: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
	execCmToFileWithContext: vi.fn(),
	getCmWorkspaceRoot: vi.fn(() => undefined),
}));

import { CliBackend } from '../../../src/core/backendCli';
import { execCm, execCmWithContext } from '../../../src/core/cmCli';

describe('createPlasticContext', () => {
	it('creates a frozen context with the expected fields', () => {
		const ctx = createPlasticContext({
			workspaceRoot: '/tmp/ws',
			cmPath: '/usr/bin/cm',
		});
		expect(ctx.workspaceRoot).toBe('/tmp/ws');
		expect(ctx.cmPath).toBe('/usr/bin/cm');
		expect(Object.isFrozen(ctx)).toBe(true);
	});

	it('does not share state between contexts', () => {
		const a = createPlasticContext({ workspaceRoot: '/a', cmPath: '/cm1' });
		const b = createPlasticContext({ workspaceRoot: '/b', cmPath: '/cm2' });
		expect(a.workspaceRoot).toBe('/a');
		expect(b.workspaceRoot).toBe('/b');
		expect(a).not.toBe(b);
	});

	it('throws when workspaceRoot is empty', () => {
		expect(() => createPlasticContext({ workspaceRoot: '', cmPath: '/cm' }))
			.toThrow(/workspaceRoot must be a non-empty string/);
	});

	it('throws when cmPath is empty', () => {
		expect(() => createPlasticContext({ workspaceRoot: '/ws', cmPath: '' }))
			.toThrow(/cmPath must be a non-empty string/);
	});
});

describe('CliBackend context injection', () => {
	it('falls through to the module-level execCm when constructed without a context', async () => {
		vi.mocked(execCm).mockClear();
		vi.mocked(execCmWithContext).mockClear();
		const backend = new CliBackend();
		await backend.getStatus(false);
		expect(execCm).toHaveBeenCalledTimes(1);
		expect(execCmWithContext).not.toHaveBeenCalled();
	});

	it('routes through execCmWithContext when constructed with a context', async () => {
		vi.mocked(execCm).mockClear();
		vi.mocked(execCmWithContext).mockClear();
		const ctx = createPlasticContext({ workspaceRoot: '/tmp/ws', cmPath: '/usr/bin/cm' });
		const backend = new CliBackend(ctx);
		await backend.getStatus(false);
		expect(execCmWithContext).toHaveBeenCalledTimes(1);
		expect(execCmWithContext).toHaveBeenCalledWith(ctx, ['status', '--machinereadable', '--all']);
		expect(execCm).not.toHaveBeenCalled();
	});

	it('two backends with different contexts do not share state', async () => {
		vi.mocked(execCmWithContext).mockClear();
		const ctxA = createPlasticContext({ workspaceRoot: '/ws/a', cmPath: '/cm' });
		const ctxB = createPlasticContext({ workspaceRoot: '/ws/b', cmPath: '/cm' });
		const backendA = new CliBackend(ctxA);
		const backendB = new CliBackend(ctxB);

		await backendA.getStatus(false);
		await backendB.getStatus(false);

		expect(execCmWithContext).toHaveBeenCalledTimes(2);
		expect(execCmWithContext).toHaveBeenNthCalledWith(1, ctxA, ['status', '--machinereadable', '--all']);
		expect(execCmWithContext).toHaveBeenNthCalledWith(2, ctxB, ['status', '--machinereadable', '--all']);
	});
});
