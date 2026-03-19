import * as vscode from 'vscode';

export class AdaptivePoller implements vscode.Disposable {
	private timer: ReturnType<typeof setInterval> | undefined;
	private lastChangeTime = Date.now();
	private currentInterval: number;
	private disposed = false;

	constructor(
		private readonly callback: () => Promise<void>,
		private readonly baseInterval: number,
		private readonly backoffInterval: number = baseInterval * 3,
		private readonly backoffThreshold: number = 30_000,
	) {
		this.currentInterval = baseInterval;
	}

	start(): void {
		if (this.disposed) return;
		this.stop();
		this.scheduleNext();
	}

	stop(): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	/** Pause polling temporarily. Call resume() to restart. */
	pause(): void {
		this.stop();
	}

	/** Resume polling after a pause. */
	resume(): void {
		if (this.disposed) return;
		this.scheduleNext();
	}

	notifyChange(): void {
		this.lastChangeTime = Date.now();
		if (this.currentInterval !== this.baseInterval) {
			this.currentInterval = this.baseInterval;
			this.stop();
			this.scheduleNext();
		}
	}

	private scheduleNext(): void {
		if (this.disposed) return;
		this.timer = setTimeout(async () => {
			if (this.disposed) return;
			try {
				await this.callback();
			} catch {
				// Errors are expected to be handled by the callback itself.
				// Continue polling — transient errors shouldn't stop the poller.
			}
			this.adaptInterval();
			this.scheduleNext();
		}, this.currentInterval);
	}

	private adaptInterval(): void {
		const idleTime = Date.now() - this.lastChangeTime;
		if (idleTime > this.backoffThreshold && this.currentInterval === this.baseInterval) {
			this.currentInterval = this.backoffInterval;
		}
	}

	dispose(): void {
		this.disposed = true;
		this.stop();
	}
}
