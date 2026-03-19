# Changelog

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
