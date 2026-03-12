# Phase 3a: Branch Tree + Operations — Design

**Goal:** Activity bar panel showing branches with current branch indicator, plus create/switch/delete branch commands.

**Architecture:** Extend `PlasticBackend` with 4 branch methods, implement in both REST and CLI backends, create a `TreeDataProvider` for the branches view, and wire up branch commands via QuickPick/InputBox.

---

## 1. Backend Interface Extensions

Add to `PlasticBackend`:

```typescript
listBranches(): Promise<BranchInfo[]>;
createBranch(name: string, from?: string): Promise<BranchInfo>;
deleteBranch(name: string): Promise<void>;
switchBranch(name: string): Promise<void>;
```

New type in `types.ts`:

```typescript
interface BranchInfo {
  id: number;
  name: string;
  owner: string;
  date: string;
  comment?: string;
  isMain: boolean;
  headChangeset?: number;
  changesetsCount?: number;
}
```

### RestBackend

- **listBranches:** V2 `GET /repositories/{repoName}/branches` with pagination
- **createBranch:** V1 `POST /repos/{repoName}/branches` with `{ name, changeset }`
- **deleteBranch:** V2 `DELETE /repositories/{repoName}/branches/{branchId}`
- **switchBranch:** V1 `POST /workspaces/{guid}/update`

### CliBackend

- **listBranches:** `cm find branch --format="{name}#{id}#{owner}#{date}#{comment}"`
- **createBranch:** `cm branch create <name>`
- **deleteBranch:** `cm branch delete <name>`
- **switchBranch:** `cm switch <name>`

## 2. Branch Tree View Provider

`src/views/branchesTreeProvider.ts` — `TreeDataProvider<BranchTreeItem>`:

- Flat list (no hierarchy nesting)
- Current branch sorted first with checkmark icon
- Each item: branch name as label, owner + date as description
- Refresh on demand + after any branch operation
- Context menu: Switch to Branch, Delete Branch

## 3. Branch Commands

- **switchBranch:** QuickPick → `switchBranch()` → refresh tree + status bar + SCM
- **createBranch:** InputBox → `createBranch(name)` → refresh tree
- **deleteBranch:** Confirm dialog → `deleteBranch(name)` → refresh tree. Guard: cannot delete current branch.

## 4. Wiring

- `extension.ts` creates `BranchesTreeProvider`, registers via `registerTreeDataProvider`
- Commands in new `src/commands/branch.ts`
- After switch: refresh SCM provider + status bar + branch tree

## Files

| File | Change |
|---|---|
| `src/core/types.ts` | Add `BranchInfo` |
| `src/core/backend.ts` | Add 4 branch methods |
| `src/core/backendRest.ts` | REST branch operations |
| `src/core/backendCli.ts` | CLI branch operations |
| `src/core/workspace.ts` | Facade functions |
| `src/views/branchesTreeProvider.ts` | New — tree provider |
| `src/commands/branch.ts` | New — branch commands |
| `src/extension.ts` | Wire tree + commands |
