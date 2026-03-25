# Changelog

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
