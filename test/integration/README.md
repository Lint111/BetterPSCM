# BetterPSCM Integration Tests

These tests drive a **real** `cm` binary against a **real** throwaway Plastic workspace. Unlike the unit tests under `test/unit/`, they do not mock `execCm` — the point is to catch bugs that unit tests can't see, like the `-a` flag silent no-op on CH files that was discovered on 2026-04-07.

Integration tests are **opt-in**. The default `npm test` does not run them.

## Why They Exist

Unit tests mock `execCm` and `execCmToFile`, so they verify that our code *calls cm correctly*. They cannot verify that cm *does what we think it does*. Flag semantics, output format changes across Plastic versions, path-format assumptions, and concurrency races between multiple cm processes are all invisible to the unit suite. The integration tier closes that blind spot.

## One-Time Setup

You need (a) the Plastic SCM desktop client installed on your machine, and (b) a throwaway workspace that tests can scribble on without fear.

### 1. Create a local repository

Open the Plastic SCM desktop client, switch the server selector to `local`, and create a new repository. Name it whatever you like (`testEnviroment`, `bpscm-test`, etc.) — the tests don't care about the name. Using `local` instead of a cloud server means:

- No credentials required
- No cloud state pollution
- Complete reset is just "delete the local repo"

If you prefer the CLI, the Plastic desktop GUI has a "Create repository" button that is less fiddly than the CLI equivalent.

### 2. Bind a workspace

Still in the Plastic desktop, create a workspace on your local repo:

- **Workspace name:** anything (e.g. `bpscm-integration`)
- **Path:** an empty directory you control (e.g. `C:\Users\<you>\wkspaces\bpscm-integration`)
- **Branch:** `/main`

The tests create files inside a subdirectory named `__bpscm_integration__/` under this workspace. They never touch anything outside that subdirectory. Each test creates its own unique timestamped folder beneath `__bpscm_integration__/` and cleans up in `afterEach`.

### 3. Export the environment variables

**Required:**

```bash
# Unix / WSL
export BPSCM_INTEGRATION_WORKSPACE=/mnt/c/Users/<you>/wkspaces/bpscm-integration

# Windows PowerShell
$env:BPSCM_INTEGRATION_WORKSPACE = "C:\Users\<you>\wkspaces\bpscm-integration"

# Windows cmd
set BPSCM_INTEGRATION_WORKSPACE=C:\Users\<you>\wkspaces\bpscm-integration
```

**Required when running from WSL** (because `cm` is not on the WSL PATH and the Windows default path only applies when `process.platform === 'win32'`):

```bash
export PLASTIC_CM_PATH="/mnt/c/Program Files/PlasticSCM5/client/cm.exe"
```

On native Windows the default location is probed automatically — you do not need this variable.

You can put both exports in a local `.env` file and source it before running tests, or add them to your shell rc.

## Running the Tests

```bash
# Full integration suite
npm run test:integration

# A single test file
npx vitest run --config vitest.integration.config.ts test/integration/undoCheckout.test.ts

# Watch mode while iterating
npx vitest --config vitest.integration.config.ts
```

## What Gets Written Where

All test writes are scoped to `$BPSCM_INTEGRATION_WORKSPACE/__bpscm_integration__/<timestamp>-<random>/`. The fixture helpers will never write outside that directory. After each test, `afterEach` reverts any pending cm state in the directory and removes the directory from disk. If a test crashes mid-run and leaves orphan files behind, you can clean them up with:

```bash
rm -rf "$BPSCM_INTEGRATION_WORKSPACE/__bpscm_integration__"
cd "$BPSCM_INTEGRATION_WORKSPACE" && cm undocheckout -a
```

## Adding a New Integration Test

```typescript
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createIntegrationFixture, ensureFixturesRoot, IntegrationFixture } from './fixture';

describe('my new feature (integration)', () => {
  let fx: IntegrationFixture;

  beforeAll(async () => {
    await ensureFixturesRoot();
  });

  beforeEach(async () => {
    fx = await createIntegrationFixture();
  });

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('does the thing', async () => {
    const relPath = fx.writeFile('hello.txt', 'world\n');
    await fx.backend.addToSourceControl([relPath]);
    // ... assertions
  });
});
```

Tests should:

- Only write files via `fx.writeFile(...)` (keeps paths inside the fixture directory)
- Call `fx.backend.<method>` rather than the global `getBackend()` / `setBackend()`
- Avoid assumptions about other tests — `beforeEach` creates a fresh, empty per-test directory

## Troubleshooting

| Symptom | Likely Cause |
|---|---|
| `BPSCM_INTEGRATION_WORKSPACE is not set` | Export the env var per the setup instructions. |
| `... does not contain a .plastic folder` | The path points at something that isn't a Plastic workspace root. |
| `cm binary not found` | Plastic isn't installed, `cm` isn't on PATH, and `PLASTIC_CM_PATH` is unset or wrong. |
| Tests hang on `checkin` | Plastic GUI dialog is open — check for modal windows or run with `PLASTIC_NO_GUI=1`. The fixture sets this automatically via `CM_HEADLESS_ENV`, but double-check. |
| Orphan files in the workspace after a crash | `rm -rf __bpscm_integration__` inside the workspace, then `cm undocheckout -a` to revert any dangling CH/CO records. |
| `Connection refused` on startup | The local Plastic server daemon isn't running. Open the Plastic desktop client once — it starts `plasticsd` for you. |
