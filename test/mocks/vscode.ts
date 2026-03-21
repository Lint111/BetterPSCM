import { vi } from 'vitest';

// --- Uri ---

export class Uri {
	readonly scheme: string;
	readonly authority: string;
	readonly path: string;
	readonly query: string;
	readonly fsPath: string;

	private constructor(scheme: string, authority: string, path: string, query: string = '') {
		this.scheme = scheme;
		this.authority = authority;
		this.path = path;
		this.query = query;
		this.fsPath = path;
	}

	static file(p: string): Uri {
		return new Uri('file', '', p);
	}

	static parse(value: string): Uri {
		const match = value.match(/^([^:]+):\/\/([^/]*)(\/.*)?$/);
		if (match) return new Uri(match[1], match[2] ?? '', match[3] ?? '');
		return new Uri('file', '', value);
	}

	static from(components: { scheme: string; authority?: string; path?: string; query?: string }): Uri {
		return new Uri(components.scheme, components.authority ?? '', components.path ?? '', components.query ?? '');
	}

	static joinPath(base: Uri, ...segments: string[]): Uri {
		const joined = [base.path, ...segments].join('/').replace(/\/+/g, '/');
		return new Uri(base.scheme, base.authority, joined);
	}

	toString(): string {
		const q = this.query ? `?${this.query}` : '';
		return `${this.scheme}://${this.authority}${this.path}${q}`;
	}
}

// --- EventEmitter ---

export class EventEmitter<T> {
	private listeners: Array<(e: T) => void> = [];

	readonly event = (listener: (e: T) => void) => {
		this.listeners.push(listener);
		return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
	};

	fire(data: T): void {
		for (const l of this.listeners) l(data);
	}

	dispose(): void {
		this.listeners = [];
	}
}

// --- ThemeColor / ThemeIcon ---

export class ThemeColor {
	constructor(public readonly id: string) {}
}

export class ThemeIcon {
	constructor(public readonly id: string, public readonly color?: ThemeColor) {}
}

// --- TreeItem ---

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 } as const;

export class TreeItem {
	label: string;
	collapsibleState: number;
	description?: string;
	tooltip?: string;
	contextValue?: string;
	iconPath?: any;

	constructor(label: string, collapsibleState?: number) {
		this.label = label;
		this.collapsibleState = collapsibleState ?? 0;
	}
}

// --- Enums ---

export const StatusBarAlignment = { Left: 1, Right: 2 } as const;
export const ProgressLocation = { SourceControl: 1, Notification: 15, Window: 10 } as const;
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const;
export const OverviewRulerLane = { Left: 1, Center: 2, Right: 4, Full: 7 } as const;

// --- Memento (for StagingManager) ---

export function createMockMemento(initial: Record<string, unknown> = {}): any {
	const store = new Map<string, unknown>(Object.entries(initial));
	return {
		get: (key: string, defaultValue?: unknown) => store.has(key) ? store.get(key) : defaultValue,
		update: vi.fn((key: string, value: unknown) => { store.set(key, value); return Promise.resolve(); }),
		keys: () => [...store.keys()],
	};
}

// --- window ---

export const window = {
	showInformationMessage: vi.fn(),
	showWarningMessage: vi.fn(),
	showErrorMessage: vi.fn(),
	showInputBox: vi.fn(),
	showQuickPick: vi.fn(),
	registerTreeDataProvider: vi.fn(),
	registerWebviewViewProvider: vi.fn(),
	withProgress: vi.fn(async (_opts: any, task: any) => task({ report: vi.fn() })),
	createOutputChannel: vi.fn(() => ({
		appendLine: vi.fn(),
		show: vi.fn(),
		dispose: vi.fn(),
	})),
	createStatusBarItem: vi.fn(() => ({
		text: '',
		tooltip: '',
		command: undefined as string | undefined,
		show: vi.fn(),
		hide: vi.fn(),
		dispose: vi.fn(),
	})),
	createTextEditorDecorationType: vi.fn(() => ({
		key: 'mock-decoration',
		dispose: vi.fn(),
	})),
};

// --- workspace ---

const defaultConfig: Record<string, unknown> = {};

export const workspace = {
	getConfiguration: vi.fn(() => ({
		get: (key: string, defaultValue?: unknown) => defaultConfig[key] ?? defaultValue,
	})),
	registerTextDocumentContentProvider: vi.fn(() => ({ dispose: vi.fn() })),
	onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
	workspaceFolders: undefined as any,
};

/**
 * Helper: set config values for tests that use getConfig().
 */
export function setMockConfig(values: Record<string, unknown>): void {
	Object.assign(defaultConfig, values);
}

// --- scm ---

export const scm = {
	createSourceControl: vi.fn((_id: string, _label: string, _rootUri?: Uri) => ({
		inputBox: { value: '', placeholder: '' },
		acceptInputCommand: undefined as any,
		quickDiffProvider: undefined as any,
		count: 0,
		createResourceGroup: vi.fn((_id: string, _label: string) => ({
			id: _id,
			label: _label,
			resourceStates: [] as any[],
			dispose: vi.fn(),
		})),
		dispose: vi.fn(),
	})),
};

// --- commands ---

export const commands = {
	registerCommand: vi.fn(),
	executeCommand: vi.fn(),
};

// --- Disposable ---

export class Disposable {
	constructor(private readonly callOnDispose: () => void) {}
	static from(...disposables: { dispose: () => void }[]): Disposable {
		return new Disposable(() => disposables.forEach(d => d.dispose()));
	}
	dispose(): void {
		this.callOnDispose();
	}
}
