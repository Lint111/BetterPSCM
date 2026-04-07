/**
 * Per-workspace runtime context.
 *
 * Historically, BetterPSCM stored all workspace-scoped state in module-level
 * variables: cmPath, workspaceRoot, the active backend, auth tokens, etc.
 * That was fine when the extension only ever touched one workspace at a
 * time, but it made integration tests fragile (every test had to reset
 * shared globals), blocked multi-workspace support, and coupled the MCP
 * server to the extension's initialization order.
 *
 * PlasticContext is the replacement: a plain, frozen struct passed explicitly
 * to whichever component needs it. The migration from globals is incremental
 * — this file is the starting point. As more call sites adopt the context,
 * the corresponding globals will be removed.
 *
 * Minimum viable shape for the first milestone (unblocks integration tests):
 *   - workspaceRoot: absolute path to the Plastic workspace
 *   - cmPath: absolute path to the cm binary
 *
 * Future additions (deferred):
 *   - backend: PlasticBackend instance owned by the context
 *   - apiClient: REST client bound to this workspace
 *   - stagingStore: per-workspace staging state
 *   - auth: token cache scoped to the workspace's server
 */

export interface PlasticContext {
	/** Absolute path to the Plastic workspace root (contains .plastic/). */
	readonly workspaceRoot: string;
	/** Absolute path to the cm binary to use for this context. */
	readonly cmPath: string;
}

/**
 * Create a frozen PlasticContext from the given fields. Freezing guards
 * against accidental mutation by consumers that treat the context as a
 * mutable object. Validates that both fields are non-empty so a bad
 * construction fails at the factory call site rather than deep inside
 * a spawn() call with an undefined binary.
 */
export function createPlasticContext(opts: {
	workspaceRoot: string;
	cmPath: string;
}): PlasticContext {
	if (!opts.workspaceRoot || typeof opts.workspaceRoot !== 'string') {
		throw new Error('createPlasticContext: workspaceRoot must be a non-empty string');
	}
	if (!opts.cmPath || typeof opts.cmPath !== 'string') {
		throw new Error('createPlasticContext: cmPath must be a non-empty string');
	}
	return Object.freeze({
		workspaceRoot: opts.workspaceRoot,
		cmPath: opts.cmPath,
	});
}
