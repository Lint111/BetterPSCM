/**
 * Base class for BetterPSCM webview panels.
 *
 * Captures the boilerplate every panel duplicates: createWebviewPanel,
 * onDidDispose wiring, onDidReceiveMessage routing, disposable tracking,
 * and dispose-once semantics. Subclasses provide just the panel-specific
 * bits — viewType, title, message handler, content rendering.
 *
 * Designed for `vscode.WebviewPanel` lifecycle. The history graph panel
 * uses `vscode.WebviewView` (sidebar) which has a different lifecycle and
 * does NOT extend this class.
 */

import * as vscode from 'vscode';

/** Configuration passed to BetterPanel's constructor. */
export interface BetterPanelOptions {
	/** Unique view type identifier (e.g. 'bpscm.codeReviewPanel'). */
	viewType: string;
	/** Initial tab title. Subclasses can update via `this.panel.title = ...` later. */
	title: string;
	/** Editor column to open in. Defaults to ViewColumn.One. */
	viewColumn?: vscode.ViewColumn;
	/** Allow scripts in the webview. Defaults to true (every BetterPSCM panel needs it). */
	enableScripts?: boolean;
	/** Keep webview state when the panel is hidden. Defaults to true. */
	retainContextWhenHidden?: boolean;
}

/**
 * Subclasses extend this and implement `handleMessage`. The base wires the
 * panel + disposables + dispose-once flag. Override `onPanelDispose` for
 * cleanup that should run when VS Code disposes the underlying panel
 * (e.g. removing this instance from a static registry).
 */
export abstract class BetterPanel implements vscode.Disposable {
	protected readonly panel: vscode.WebviewPanel;
	protected readonly disposables: vscode.Disposable[] = [];
	private _disposed = false;

	protected constructor(opts: BetterPanelOptions) {
		this.panel = vscode.window.createWebviewPanel(
			opts.viewType,
			opts.title,
			opts.viewColumn ?? vscode.ViewColumn.One,
			{
				enableScripts: opts.enableScripts ?? true,
				retainContextWhenHidden: opts.retainContextWhenHidden ?? true,
			},
		);

		this.panel.onDidDispose(
			() => {
				// Run subclass cleanup BEFORE marking disposed so the subclass
				// can still touch panel state (e.g. unregister from a static
				// instance map keyed by id stored on this).
				this.onPanelDispose();
				this.dispose();
			},
			null,
			this.disposables,
		);

		this.panel.webview.onDidReceiveMessage(
			(msg) => this.handleMessage(msg),
			null,
			this.disposables,
		);
	}

	/**
	 * Hook for subclasses that need to react to VS Code disposing the panel
	 * (e.g. clear themselves from a static registry). Called from the
	 * onDidDispose handler before `dispose()` runs. Default: no-op.
	 */
	protected onPanelDispose(): void {
		/* override in subclass */
	}

	/**
	 * Process a message posted from the webview client JS via
	 * `vscode.postMessage(...)`. The shape of `msg` is panel-specific.
	 */
	protected abstract handleMessage(msg: unknown): void | Promise<void>;

	/**
	 * Idempotent dispose — safe to call from anywhere. Cleans up event
	 * listeners and disposes the underlying webview panel. The panel
	 * disposal triggers VS Code's onDidDispose, which (re-entrantly)
	 * calls dispose() and onPanelDispose() — the `_disposed` guard
	 * breaks the recursion on the second entry.
	 *
	 * This routing means BOTH paths reach onPanelDispose:
	 *   - User closes the panel via VS Code → onDidDispose listener
	 *     calls onPanelDispose then this.dispose()
	 *   - Caller invokes instance.dispose() → this.dispose() calls
	 *     this.panel.dispose() which fires the listener
	 */
	dispose(): void {
		if (this._disposed) return;
		this._disposed = true;
		for (const d of this.disposables) {
			try { d.dispose(); } catch { /* swallow — best-effort cleanup */ }
		}
		this.disposables.length = 0;
		// Trigger VS Code panel disposal so the onDidDispose listener
		// runs onPanelDispose() for the subclass cleanup hooks. If the
		// panel is already disposed (we got here from the listener),
		// VS Code's dispose is idempotent and this is a no-op.
		try { this.panel.dispose(); } catch { /* already disposed */ }
	}

	/** Whether this panel has already been disposed. */
	protected get isDisposed(): boolean {
		return this._disposed;
	}

	/** Bring the panel to the front. */
	reveal(viewColumn?: vscode.ViewColumn): void {
		if (this._disposed) return;
		this.panel.reveal(viewColumn);
	}
}
