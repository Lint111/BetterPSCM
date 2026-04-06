# Changelog

## [0.3.0] - 2026-04-06

### Fixed
- `bpscm_file_history`: `cm history --format` rejected `{changeset}`/`{type}` — use `{changesetid}` and drop the (unavailable) type field
- `bpscm_annotate`: parser never matched cm's padded default output — switch to an explicit `--format` with a unit-separator delimiter, correctly populating changeset IDs, authors, and line numbers
- `bpscm_branches`: was routed to the REST backend and failed with "invalid user api token" for local-only workspaces — route `listBranches` to the CLI backend
- `bpscm_clean_stale`: unconditionally reverted all CO files, which could wipe legitimate in-progress edits (Unity opens scenes/assets as CO before the filesystem watcher promotes real edits to CH). CO files are now SHA-256 compared against the base revision; only byte-identical files are reverted
- `bpscm_get_status(detect_stale=true)`: now content-hashes CO files the same way as CH, so `possiblyStale` reflects real content divergence

### Added
- WSL → Windows path translation at the cm execution boundary. MCP clients running under WSL can now pass `/mnt/c/...` paths to any cm-backed tool (history, annotate, diff, etc.); they are rewritten to `C:\...` before handoff to `cm.exe`.

## [0.2.0] - 2026-03-25

### Added
- Moved file diff titles showing old → new filename
- Stale CH file detection via SHA-256 content comparison in MCP clean_stale
- IPC notifications from MCP server to refresh SCM panel on mutations
- CLI-first hybrid fallback for changeset diffs and listings

### Fixed
- Operator precedence bug in cm CLI killed/SIGTERM error handling
- Checkin now allows checkedOut files through filter (external tool edits)
- Robust checkin retry with broader cm rejection pattern matching
- Quick diff fetches base content from sourcePath for moved files
- REST backend propagates diff errors instead of silently returning empty

## [0.1.0] - 2026-03-13

### Added
- Git-like staging with "Staged Changes" and "Changes" resource groups
- Quick diff with inline gutter decorations
- Revert individual file changes
- Branch explorer with create, switch, and delete
- Status bar showing current branch
- Interactive SVG history graph with branch lines
- File history and annotate (blame) views
- Code review lifecycle — create, comment, change status, manage reviewers
- Threaded review comments with tree view filtering
- Merge branches with conflict preview
- Label management on changesets
- Lock rule management (create, list, delete)
- Lock release for file locks
- Workspace auto-detection from `.plastic/` folder
- Workspace update with conflict handling
- SSO auto-login via Unity Plastic desktop client tokens
- MCP server with 14 tools, 3 resources, and 2 prompts
- Standalone MCP mode: `node dist/mcp-server.js --workspace /path`
- Dual backend: REST API (primary) with cm CLI fallback
