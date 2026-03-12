import { describe, it, expect, vi, beforeEach } from 'vitest';
import { workspace } from '../../mocks/vscode';

vi.mock('../../../src/core/cmCli', () => ({
	isCmAvailable: vi.fn(() => false),
}));

import { isCmAvailable } from '../../../src/core/cmCli';
import { getConfig, isConfigured } from '../../../src/util/config';

const mockIsCmAvailable = vi.mocked(isCmAvailable);

describe('getConfig', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns config with defaults', () => {
		const cfg = getConfig();
		expect(cfg.pollInterval).toBe(3000);
		expect(cfg.showPrivateFiles).toBe(true);
		expect(cfg.mcpEnabled).toBe(false);
	});
});

describe('isConfigured', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockIsCmAvailable.mockReturnValue(false);
	});

	it('returns false when nothing is configured', () => {
		expect(isConfigured()).toBe(false);
	});

	it('returns true when cm CLI is available', () => {
		mockIsCmAvailable.mockReturnValue(true);
		expect(isConfigured()).toBe(true);
	});

	it('returns true when REST API settings are present', () => {
		workspace.getConfiguration.mockReturnValue({
			get: (key: string, def?: unknown) => {
				if (key === 'plasticScm.serverUrl') return 'https://example.com';
				if (key === 'plasticScm.organizationName') return 'my-org';
				return def;
			},
		} as any);

		expect(isConfigured()).toBe(true);
	});
});
