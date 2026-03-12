import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AdaptivePoller } from '../../../src/util/polling';

describe('AdaptivePoller', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('calls callback after base interval', async () => {
		const callback = vi.fn().mockResolvedValue(undefined);
		const poller = new AdaptivePoller(callback, 1000);

		poller.start();
		expect(callback).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1000);
		expect(callback).toHaveBeenCalledTimes(1);

		poller.dispose();
	});

	it('calls callback repeatedly', async () => {
		const callback = vi.fn().mockResolvedValue(undefined);
		const poller = new AdaptivePoller(callback, 500);

		poller.start();
		await vi.advanceTimersByTimeAsync(500);
		await vi.advanceTimersByTimeAsync(500);
		expect(callback).toHaveBeenCalledTimes(2);

		poller.dispose();
	});

	it('stops on dispose', async () => {
		const callback = vi.fn().mockResolvedValue(undefined);
		const poller = new AdaptivePoller(callback, 500);

		poller.start();
		poller.dispose();

		await vi.advanceTimersByTimeAsync(1000);
		expect(callback).not.toHaveBeenCalled();
	});

	it('stop prevents further callbacks', async () => {
		const callback = vi.fn().mockResolvedValue(undefined);
		const poller = new AdaptivePoller(callback, 500);

		poller.start();
		await vi.advanceTimersByTimeAsync(500);
		expect(callback).toHaveBeenCalledTimes(1);

		poller.stop();
		await vi.advanceTimersByTimeAsync(1000);
		expect(callback).toHaveBeenCalledTimes(1);

		poller.dispose();
	});

	it('backs off after idle threshold', async () => {
		const callback = vi.fn().mockResolvedValue(undefined);
		// base=1000, backoff=5000, threshold=1500
		const poller = new AdaptivePoller(callback, 1000, 5000, 1500);

		poller.start();

		// t=1000: 1st call, idle=1000 < 1500 → stays at base
		await vi.advanceTimersByTimeAsync(1000);
		expect(callback).toHaveBeenCalledTimes(1);

		// t=2000: 2nd call, idle=2000 > 1500 → switches to backoff (5000ms)
		await vi.advanceTimersByTimeAsync(1000);
		expect(callback).toHaveBeenCalledTimes(2);

		// Next call won't happen until t=7000 (2000+5000). Advance 4000ms → no new call
		await vi.advanceTimersByTimeAsync(4000);
		expect(callback).toHaveBeenCalledTimes(2);

		// Advance 1000ms more (t=7000) → 3rd call
		await vi.advanceTimersByTimeAsync(1000);
		expect(callback).toHaveBeenCalledTimes(3);

		poller.dispose();
	});

	it('notifyChange resets to base interval', async () => {
		const callback = vi.fn().mockResolvedValue(undefined);
		const poller = new AdaptivePoller(callback, 1000, 5000, 500);

		poller.start();

		// Let it back off
		await vi.advanceTimersByTimeAsync(1000);
		expect(callback).toHaveBeenCalledTimes(1);

		// Now notify change — should reset interval
		poller.notifyChange();

		// Should fire again after base interval (1000), not backoff (5000)
		await vi.advanceTimersByTimeAsync(1000);
		expect(callback).toHaveBeenCalledTimes(2);

		poller.dispose();
	});

	it('swallows callback errors', async () => {
		const callback = vi.fn().mockRejectedValue(new Error('boom'));
		const poller = new AdaptivePoller(callback, 500);

		poller.start();
		await vi.advanceTimersByTimeAsync(500);
		expect(callback).toHaveBeenCalledTimes(1);

		// Should continue polling after error
		await vi.advanceTimersByTimeAsync(500);
		expect(callback).toHaveBeenCalledTimes(2);

		poller.dispose();
	});
});
