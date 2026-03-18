/**
 * Abstraction over staging state storage.
 * Extension uses MementoStagingStore (persistent), standalone MCP uses InMemoryStagingStore.
 */
export interface StagingStore {
	getAll(): Set<string>;
	add(paths: string[]): void;
	remove(paths: string[]): void;
	clear(): void;
	has(path: string): boolean;
}

/**
 * Simple in-memory staging store for standalone MCP server.
 * No persistence, no events.
 */
export class InMemoryStagingStore implements StagingStore {
	private readonly paths = new Set<string>();

	getAll(): Set<string> {
		return new Set(this.paths);
	}

	add(paths: string[]): void {
		for (const p of paths) this.paths.add(p);
	}

	remove(paths: string[]): void {
		for (const p of paths) this.paths.delete(p);
	}

	clear(): void {
		this.paths.clear();
	}

	has(path: string): boolean {
		return this.paths.has(path);
	}
}
