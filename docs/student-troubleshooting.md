# Student Developer Troubleshooting Guide

This guide provides solutions for common issues student developers may encounter when setting up or developing on the Capstone Impact Platform.

> [!NOTE]
> `npm run setup:local` is safely rerunnable. It checks an existing `.env.local` before overwriting it: loopback configurations are safely regenerated, hosted-looking files are refused, and no keys or tokens are ever printed. If it failed mid-way, run it again after fixing the specific step.

---

## 1. Toolchain & Environment Issues

### Problem: Unsupported Node.js or npm Version
- **Symptom**: `onboarding:check` fails with `[FAIL] Node.js version check` or `[FAIL] npm version check`.
- **Cause**: Installed Node.js or npm is outside the pinned range (`Node >= 24.14.1 < 25`, `npm >= 11.11.0 < 12`).
- **Solution**: Use `nvm` (Node Version Manager) or `nvm-windows` to install and switch to Node 24.14.1:
  ```bash
  nvm install 24.14.1
  nvm use 24.14.1
  ```
  Verify versions:
  ```bash
  node -v  # Expected: v24.14.1
  npm -v   # Expected: 11.11.0 or >=11.11.0 <12
  ```

---

### Problem: `npm ci` Failures
- **Symptom**: `npm ci` errors out with `ENOENT`, `ERESOLVE`, or lockfile mismatch.
- **Solution**: Delete `node_modules` and reinstall. Do **not** run `npm install` instead of `npm ci`.

  **Windows PowerShell:**
  ```powershell
  Remove-Item -Recurse -Force node_modules -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force apps\admin-cms\node_modules -ErrorAction SilentlyContinue
  npm cache verify
  npm ci
  ```

  **macOS / Linux:**
  ```bash
  rm -rf node_modules apps/admin-cms/node_modules
  npm cache verify
  npm ci
  ```

---

## 2. Docker & Supabase Container Issues

### Problem: Docker Daemon Unavailable
- **Symptom**: `npm run supabase:start` fails with `error during connect: Get "http://%2F%2F.%2Fpipe%2Fdocker_engine/..."` or `Is the Docker daemon running?`.
- **Cause**: Docker Desktop is not running or the Docker service has stopped.
- **Solution**:
  1. Open Docker Desktop on Windows/macOS (or start the `docker` service on Linux).
  2. Wait until Docker Desktop shows **Engine running**.
  3. Verify:
     ```bash
     docker ps
     ```
  4. Retry `npm run setup:local`.

---

### Problem: Local Port Conflicts
- **Symptom**: `npm run supabase:start` or `npm run dev:admin` fails with `port 54321 is already in use` or `port 3000 in use`.
- **Cause**: Another process is occupying local ports (`3000`, `54321–54324`).

  **Windows PowerShell:**
  ```powershell
  Get-NetTCPConnection -LocalPort 54321 | Select-Object OwningProcess
  ```

  **macOS / Linux:**
  ```bash
  lsof -i :54321
  ```

- Terminate conflicting background processes or stop other Supabase projects.

---

### Problem: Stale Local Containers / Cannot Start Stack

Try these steps **in order**. Do not skip ahead.

1. **Stop the stack cleanly first:**
   ```bash
   npm run supabase:stop
   ```

2. **Check the current status:**
   ```bash
   npm run supabase:status
   ```

3. **Retry starting:**
   ```bash
   npm run supabase:start
   ```

4. **If the above three steps do not resolve the issue — LAST RESORT (ask a maintainer first):**
   Only use direct Docker cleanup if you have identified the exact containers belonging to this project and a maintainer has confirmed it is safe to proceed. Destructive Docker cleanup of unknown containers can affect other projects on your machine.
   ```bash
   # Only after maintainer guidance:
   npm run supabase:stop
   docker ps -a
   # Identify containers labeled with this project before removing any.
   ```

> [!IMPORTANT]
> Do not run `docker rm -f` on containers you cannot identify as belonging to this project. Ask a maintainer if you are unsure.

---

## 3. Local Credentials & Login Issues

### Problem: Missing `apps/admin-cms/.env.local`
- **Symptom**: Next.js server displays environment error `NEXT_PUBLIC_SUPABASE_URL is missing`.
- **Solution**: Generate a fresh loopback environment file:
  ```bash
  npm run supabase:env:local
  ```

> [!NOTE]
> `npm run setup:local` only overwrites an existing `.env.local` when it is verified as pointing to a loopback Supabase URL (`localhost`, `127.0.0.1`, or `::1`). Hosted-looking files are never overwritten — the command refuses and tells you to inspect the file manually.

---

### Problem: Missing `apps/admin-cms/.local-users.json`
- **Symptom**: Cannot find local synthetic passwords for login.
- **Solution**: Provision local synthetic staff accounts:
  ```bash
  npm run supabase:users:local
  ```
  Open `apps/admin-cms/.local-users.json` to find credentials for `local.admin@capstone.test`, `local.reviewer@capstone.test`, and `local.editor@capstone.test`.

---

### Problem: Login Fails on `http://localhost:3000/login`
- **Symptom**: "Invalid login credentials" message when attempting to sign in.
- **Cause**: Local GoTrue database state was wiped or reset without re-provisioning synthetic users.
- **Solution**: Re-run local user provisioning:
  ```bash
  npm run supabase:users:local
  ```

---

## 4. Safe Reset & Shutdown Reference

> [!WARNING]
> `npm run supabase:reset` destroys the local database state and replays all 8 migrations from scratch. This affects **local** containers only. It does **not** touch hosted staging or production data.

- **Safe Full Rerun (recommended after any partial failure):**
  ```bash
  npm run setup:local
  ```
  This is safe to rerun at any time. It checks your existing environment file before any overwrite.

- **Safe Stack Shutdown:**
  ```bash
  npm run supabase:stop
  ```

---

## 5. Migration & Schema Issues

### Problem: Database Migration Mismatch / Migration Error
- **Symptom**: `npm run supabase:reset` fails on a specific `.sql` migration file.
- **Cause**: Local migration files `0001` through `0008` were edited, or PostgreSQL syntax error exists in a new migration.
- **Solution**:
  - Ensure migrations `0001` through `0008` are **not edited** (`git diff infra/supabase/migrations/`).
  - Verify new migration SQL syntax locally:
    ```bash
    npm run supabase:reset
    ```
  - Do not resolve migration conflicts by editing merged migrations. Ask a maintainer.

---

## 6. Build, Lint & Test Failures

### Problem: Failed Vitest Unit Tests
- **Symptom**: `npm run test:admin` reports failing assertions.
- **Solution**: Inspect the specific test file listed in output. Run only the failing test file:
  ```bash
  npx vitest run path/to/failing.test.ts --dir apps/admin-cms
  ```

### Problem: Next.js Build Failure (`npm run build:admin`)
- **Symptom**: `next build` fails with type errors or missing export errors.
- **Solution**: Run typecheck first to pinpoint exact line numbers:
  ```bash
  npm run typecheck:admin
  ```

---

## 7. When Not to Retry & When to Ask a Maintainer

### DO NOT Retry — Stop Immediately If:
1. You see any prompt or error requesting hosted Supabase organization credentials, database connection strings, or cloud API tokens.
2. A script targets a hosted environment or prompts for `--confirm-staging=capstone-admin-cms-staging-2026`.
3. You detect accidental secret exposure or uncommitted credentials in `git status`.
4. Git merge conflicts exist on `main` or affect merged migration files.

### When to Ask a Maintainer:
- Reach out to `@acmis1` on GitHub by opening an issue or commenting on your assigned ticket if local troubleshooting does not resolve your blocker.
