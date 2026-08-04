# Student Developer Troubleshooting Guide

This guide provides solutions for common issues student developers may encounter when setting up or developing on the Capstone Impact Platform.

---

## 1. Toolchain & Environment Issues

### Problem: Unsupported Node.js or npm Version
- **Symptom**: `onboarding:check` fails with `[FAIL] Node.js version check` or `[FAIL] npm version check`.
- **Cause**: Installed Node.js or npm is outside the pinned range (`Node >= 24.14.1 < 25`, `npm >= 11.11.0 < 12`).
- **Solution**:
  - Use `nvm` (Node Version Manager) or `nvm-windows` to install and switch to Node 24.14.1:
    ```bash
    nvm install 24.14.1
    nvm use 24.14.1
    ```
  - Verify versions:
    ```bash
    node -v  # Expected: v24.14.1
    npm -v   # Expected: 11.11.0 or >=11.11.0 <12
    ```

### Problem: `npm ci` Failures
- **Symptom**: `npm ci` errors out with `ENOENT`, `ERESOLVE`, or lockfile mismatch.
- **Solution**:
  - Do **not** run `npm install` without `ci`.
  - Delete `node_modules` and clear npm cache:
    ```bash
    rm -rf node_modules apps/admin-cms/node_modules
    npm cache clean --force
    npm ci
    ```

---

## 2. Docker & Supabase Container Issues

### Problem: Docker Daemon Unavailable
- **Symptom**: `npm run supabase:start` fails with `error during connect: Get "http://%2F%2F.%2Fpipe%2Fdocker_engine/..."` or `Is the Docker daemon running?`.
- **Cause**: Docker Desktop is not running or the Docker service has stopped.
- **Solution**:
  1. Open Docker Desktop application on Windows/macOS (or start `dockerd` service on Linux).
  2. Wait until Docker Desktop displays "Engine running".
  3. Test daemon status:
     ```bash
     docker ps
     ```
  4. Retry `npm run setup:local`.

### Problem: Local Port Conflicts
- **Symptom**: `npm run supabase:start` or `npm run dev:admin` fails with `port 54321 is already in use` or `port 3000 in use`.
- **Cause**: Another local process (e.g. background PostgreSQL, another Supabase project, or leftover Node process) is occupying local ports (`3000`, `54321`, `54322`, `54323`, `54324`).
- **Solution**:
  - Check which process is using the port:
    - On Windows (PowerShell):
      ```powershell
      Get-NetTCPConnection -LocalPort 54321 | Select-Object OwningProcess
      ```
    - On macOS/Linux:
      ```bash
      lsof -i :54321
      ```
  - Terminate conflicting background processes or stop other running Supabase projects (`supabase stop`).

### Problem: Stale Local Containers / Reset Failure
- **Symptom**: `npm run supabase:reset` fails with `Error: container ... already exists` or orphaned volume errors.
- **Solution (Safe Container Reset)**:
  ```bash
  npm run supabase:stop
  docker ps -a --filter label=com.supabase.cli.project=capstone-impact-platform -q | xargs docker rm -f
  npm run setup:local
  ```

---

## 3. Local Credentials & Login Issues

### Problem: Missing `apps/admin-cms/.env.local`
- **Symptom**: Next.js server displays environment error `NEXT_PUBLIC_SUPABASE_URL is missing`.
- **Solution**:
  - Generate a fresh loopback environment file:
    ```bash
    npm run supabase:env:local
    ```
  - Verify that `apps/admin-cms/.env.local` exists.

### Problem: Missing `apps/admin-cms/.local-users.json`
- **Symptom**: Unable to find local synthetic passwords for login.
- **Solution**:
  - Provision local synthetic staff accounts:
    ```bash
    npm run supabase:users:local
    ```
  - Open `apps/admin-cms/.local-users.json` to find credentials for `local.admin@capstone.test`, `local.reviewer@capstone.test`, and `local.editor@capstone.test`.

### Problem: Login Fails on `http://localhost:3000/login`
- **Symptom**: "Invalid login credentials" message when attempting to sign in.
- **Cause**: Local GoTrue database state was wiped or reset without re-provisioning synthetic users.
- **Solution**:
  - Re-run local user provisioning:
    ```bash
    npm run supabase:users:local -- --force
    ```

---

## 4. Migration & Schema Issues

### Problem: Database Migration Mismatch / Migration Error
- **Symptom**: `npm run supabase:reset` fails on a specific `.sql` migration file.
- **Cause**: Local migration files `0001` through `0008` were edited, or PostgreSQL syntax error exists in a new migration.
- **Solution**:
  - Ensure migrations `0001` through `0008` have not been altered (`git diff infra/supabase/migrations/`).
  - Verify new migration SQL syntax locally:
    ```bash
    npm run supabase:reset
    ```

---

## 5. Build, Lint & Test Failures

### Problem: Failed Vitest Unit Tests
- **Symptom**: `npm run test:admin` reports failing assertions.
- **Solution**:
  - Inspect the specific test file listed in output.
  - Run only the failing test file:
    ```bash
    npx vitest run path/to/failing.test.ts --dir apps/admin-cms
    ```

### Problem: Next.js Build Failure (`npm run build:admin`)
- **Symptom**: `next build` fails with type errors or missing export errors.
- **Solution**:
  - Run typecheck first to pinpoint exact line numbers:
    ```bash
    npm run typecheck:admin
    ```

---

## 6. Windows-Specific Behavior: Paths with Spaces

### Problem: Script Fails on Windows Paths Containing Spaces
- **Symptom**: Node script or command fails when repository path is `D:\IT RMIT\Capstone\...` (spaces in path).
- **Solution**:
  - All repository scripts in `apps/admin-cms/src/scripts/` handle space-containing paths safely using quote wrapping.
  - Avoid passing raw unquoted paths in custom CLI commands.

---

## 7. Safe Reset & Shutdown Reference

- **Safe Full Reset**:
  ```bash
  npm run setup:local
  ```
- **Safe Stack Shutdown**:
  ```bash
  npm run supabase:stop
  ```

---

## 8. When Not to Retry & When to Ask a Maintainer

### DO NOT Retry — Stop Immediately If:
1. You see any prompt or error asking for hosted Supabase organization credentials, database connection strings, or cloud API tokens.
2. A script prompts for `--confirm-staging=capstone-admin-cms-staging-2026` or targets a hosted environment.
3. You detect accidental secret exposure or uncommitted credentials in `git status`.
4. Git merge conflicts occur on `main` or unmerged migration files.

### When to Ask a Maintainer:
- Reach out to project maintainers (`@acmis1`) on GitHub by opening an issue or commenting on your assigned ticket if local troubleshooting does not resolve your blocker.
