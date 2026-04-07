import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { BetterPanel } from '../../../src/views/panels/betterPanel';

/**
 * Test subclass that exposes the protected hooks for assertion.
 */
class TestPanel extends BetterPanel {
	public messages: unknown[] = [];
	public onDisposeCalls = 0;

	constructor() {
		super({
			viewType: 'bpscm.testPanel',
			title: 'Test Panel',
			viewColumn: vscode.ViewColumn.One,
		});
	}

	protected override handleMessage(msg: unknown): void {
		this.messages.push(msg);
	}

	protected override onPanelDispose(): void {
		this.onDisposeCalls++;
	}

	// Expose protected getter for assertions
	public getDisposed(): boolean {
		return this.isDisposed;
	}

	// Expose the underlying panel for test simulation
	public getPanel() {
		return (this as unknown as { panel: ReturnType<typeof vscode.window.createWebviewPanel> }).panel;
	}
}

describe('BetterPanel', () => {
	beforeEach(() => {
		vi.mocked(vscode.window.createWebviewPanel).mockClear();
	});

	it('creates a webview panel with the configured viewType, title, and column', () => {
		const panel = new TestPanel();
		expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
		const [viewType, title, column, options] = vi.mocked(vscode.window.createWebviewPanel).mock.calls[0];
		expect(viewType).toBe('bpscm.testPanel');
		expect(title).toBe('Test Panel');
		expect(column).toBe(vscode.ViewColumn.One);
		expect((options as any).enableScripts).toBe(true);
		expect((options as any).retainContextWhenHidden).toBe(true);
		panel.dispose();
	});

	it('routes webview messages to handleMessage', () => {
		const panel = new TestPanel();
		const wp = panel.getPanel() as any;
		wp._simulateMessage({ type: 'foo', data: 1 });
		wp._simulateMessage({ type: 'bar' });
		expect(panel.messages).toEqual([{ type: 'foo', data: 1 }, { type: 'bar' }]);
		panel.dispose();
	});

	it('calls onPanelDispose when VS Code fires onDidDispose', () => {
		const panel = new TestPanel();
		const wp = panel.getPanel() as any;
		expect(panel.onDisposeCalls).toBe(0);
		wp.dispose();
		expect(panel.onDisposeCalls).toBe(1);
		expect(panel.getDisposed()).toBe(true);
	});

	it('dispose() is idempotent — second call is a no-op', () => {
		const panel = new TestPanel();
		panel.dispose();
		expect(panel.getDisposed()).toBe(true);
		// Second call should not throw or re-dispose disposables
		expect(() => panel.dispose()).not.toThrow();
		expect(panel.getDisposed()).toBe(true);
	});

	it('reveal() is a no-op after dispose', () => {
		const panel = new TestPanel();
		const wp = panel.getPanel() as any;
		panel.dispose();
		// reveal should not throw and should not call panel.reveal again
		const revealSpy = vi.mocked(wp.reveal);
		revealSpy.mockClear();
		panel.reveal();
		expect(revealSpy).not.toHaveBeenCalled();
	});

	it('reveal() before dispose forwards to underlying panel', () => {
		const panel = new TestPanel();
		const wp = panel.getPanel() as any;
		const revealSpy = vi.mocked(wp.reveal);
		revealSpy.mockClear();
		panel.reveal(vscode.ViewColumn.Two);
		expect(revealSpy).toHaveBeenCalledWith(vscode.ViewColumn.Two);
		panel.dispose();
	});

	it('onPanelDispose is called BEFORE the disposed flag is set', () => {
		// Subclass that captures isDisposed at the moment onPanelDispose runs.
		let observedDuringHook: boolean | undefined;
		class CaptureDisposeOrderPanel extends BetterPanel {
			constructor() {
				super({ viewType: 'test', title: 'test' });
			}
			protected override handleMessage(): void { /* no-op */ }
			protected override onPanelDispose(): void {
				observedDuringHook = this.isDisposed;
			}
		}
		const panel = new CaptureDisposeOrderPanel();
		(panel as any).panel.dispose();
		// During onPanelDispose, the flag should still be false — subclasses
		// need to be able to touch panel state before it's marked disposed.
		expect(observedDuringHook).toBe(false);
	});

	it('disposable cleanup is best-effort — a throwing disposable does not abort dispose', () => {
		const panel = new TestPanel();
		// Inject a disposable that throws on dispose.
		(panel as any).disposables.push({
			dispose() {
				throw new Error('intentional test failure');
			},
		});
		expect(() => panel.dispose()).not.toThrow();
		expect(panel.getDisposed()).toBe(true);
	});

	it('external dispose() still triggers onPanelDispose (registry-leak regression)', () => {
		// Regression: a previous version of BetterPanel only called
		// onPanelDispose from the onDidDispose listener. If a caller invoked
		// instance.dispose() directly, the static registry in the subclass
		// would never be cleaned up because the underlying panel was never
		// disposed and the listener never fired.
		const panel = new TestPanel();
		expect(panel.onDisposeCalls).toBe(0);
		// Direct dispose() call — NOT via VS Code closing the panel.
		panel.dispose();
		expect(panel.onDisposeCalls).toBe(1);
		expect(panel.getDisposed()).toBe(true);
	});
});
