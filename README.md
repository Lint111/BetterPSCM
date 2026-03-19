# BetterPSCM

Feature-complete Plastic SCM integration for VS Code — staging, diffs, branches, code reviews, and AI agent support via MCP.

## Features

### Source Control
- **Git-like staging** — Stage/unstage individual files, then check in only what you want
- **Two resource groups** — "Staged Changes" and "Changes" with inline actions
- **Quick diff** — Click any changed file to see inline diffs with gutter decorations
- **Revert changes** — Discard individual file modifications

### Branch Management
- **Branch explorer** — View all branches in the SCM sidebar
- **Create/switch/delete** — Full branch lifecycle from the command palette
- **Status bar** — Current branch always visible, click to switch

### History
- **Interactive history graph** — SVG-based changeset visualization with branch lines
- **File history** — View revision history for any file
- **Annotate (Blame)** — Line-by-line blame with changeset, author, and date

### Code Reviews
- **Full review lifecycle** — Create, comment, change status, manage reviewers
- **Threaded comments** — Nested discussions on review items
- **Tree view** — Filterable list (all, assigned to me, pending)

### Merges & Labels
- **Merge branches** — Conflict preview before merging, with optional comment
- **Labels** — Create and manage labels on changesets

### Lock Management
- **Lock rules** — Create file-pattern lock rules for binary assets
- **Release locks** — Manage and release file locks

### Workspace
- **Auto-detection** — Reads `.plastic/` folder to auto-configure server, org, repo, and branch
- **Workspace update** — Pull latest changes with conflict handling
- **SSO auto-login** — Picks up Unity SSO tokens from the Plastic desktop client

### AI Agent Support (MCP)
- **19 MCP tools** — Status, stage, checkin, diff, branches, merge, reviews, review audit, and more
- **3 resources** — Live workspace status, branch, and staged files
- **2 prompts** — Commit message generation and code review summaries
- **Standalone mode** — Run `node dist/mcp-server.js --workspace /path` without VS Code

## Requirements

- **Plastic SCM** client tools installed (`cm` CLI available in PATH), or
- **Unity Version Control** cloud workspace with REST API access

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `bpscm.serverUrl` | `""` | Plastic SCM server URL |
| `bpscm.organizationName` | `""` | Organization name |
| `bpscm.repositoryName` | `""` | Repository name |
| `bpscm.workspaceGuid` | `""` | Workspace GUID (auto-detected) |
| `bpscm.pollInterval` | `3000` | Status polling interval (ms) |
| `bpscm.showPrivateFiles` | `true` | Show unversioned files |
| `bpscm.mcp.enabled` | `false` | Enable MCP server for AI agents |

Most settings are **auto-detected** from the `.plastic/` folder when you open a Plastic SCM workspace.

## MCP Server Configuration

To use the MCP server with Claude Code or other MCP clients, add to your MCP config:

```json
{
  "mcpServers": {
    "betterpscm": {
      "command": "node",
      "args": ["/path/to/dist/mcp-server.js", "--workspace", "/path/to/workspace"]
    }
  }
}
```

Or enable it via VS Code settings: set `bpscm.mcp.enabled` to `true`.

## Dual Backend

The extension supports two backends:

1. **REST API** (primary) — Full feature set including code reviews, used when authenticated
2. **cm CLI** (fallback) — Works without authentication, used when REST is unavailable

The backend is selected automatically at startup.

## License

MIT
