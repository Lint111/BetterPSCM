import * as vscode from 'vscode';

export class DisposableStore implements vscode.Disposable {
	private readonly items: vscode.Disposable[] = [];
	private disposed = false;

	add<T extends vscode.Disposable>(disposable: T): T {
		if (this.disposed) {
			disposable.dispose();
			throw new Error('DisposableStore is already disposed');
		}
		this.items.push(disposable);
		return disposable;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const item of this.items.reverse()) {
			item.dispose();
		}
		this.items.length = 0;
	}
}
