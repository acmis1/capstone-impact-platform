# Contributing to Capstone Impact Platform

This guide outlines the contributor workflow, engineering contracts, and security boundaries for developers working on the Capstone Impact Platform (`acmis1/capstone-impact-platform`).

---

## A. Prerequisites

Before starting local development, ensure your environment meets these requirements:

- **Git:** Installed and configured.
- **Node.js & npm Toolchain:**
  - Node.js `>= 20.9.0` (pinned via `.nvmrc` to Node 20 LTS `20.18.0`).
  - npm `>= 10.0.0` (package manager `npm@10.8.2`).
  - Run `npm run onboarding:check` to verify toolchain compliance.
- **Docker Daemon:**
  - Docker Desktop (Windows/macOS) or Docker Engine (Linux).
  - Ensure the Docker daemon is running and accessible (`docker ps`).
- **Local Disk & RAM:**
  - Recommended minimum 8 GB RAM and 10 GB free disk space for running local Supabase containers (PostgreSQL, Auth, Storage, Studio, Mailpit).
- **Access & Credentials:**
  - Repository access to `acmis1/capstone-impact-platform`.
  - **No Supabase organization membership or hosted dashboard credentials are required** for local development.

---

## B. Canonical Fresh-Clone Setup

Follow this exact sequence on a fresh clone:

1. **Clone the repository:**
   ```bash
   git clone https://github.com/acmis1/capstone-impact-platform.git
   cd capstone-impact-platform
   ```

2. **Verify checkout is on main:**
   ```bash
   git checkout main
   ```

3. **Install dependencies cleanly:**
   ```bash
   npm ci
   ```

4. **Run the onboarding precheck:**
   ```bash
   npm run onboarding:check
   ```

5. **Start local Supabase containers:**
   ```bash
   npm run supabase:start
   ```

6. **Reset local database and replay all seven migrations:**
   ```bash
   npm run supabase:reset
   ```

7. **Seed local storage buckets and synthetic poster fixtures:**
   ```bash
   npm run supabase:seed:buckets
   ```

8. **Generate loopback-only local environment file:**
   ```bash
   npm run supabase:env:local
   ```

9. **Provision reproducible synthetic local staff users:**
   ```bash
   npm run supabase:users:local
   ```

10. **Run the local Supabase verifier:**
    ```bash
    npm run supabase:verify:local
    ```

11. **Launch the Admin/CMS development server:**
    ```bash
    npm run dev:admin
    ```

12. **Open the login page in your browser:**
    Open [http://localhost:3000/login](http://localhost:3000/login) and log in using synthetic credentials from `apps/admin-cms/.local-users.json` (verifies `admin`, `reviewer`, and `editor` synthetic roles).

13. **Stop the stack when finished:**
    ```bash
    npm run supabase:stop
    ```

---

## C. Daily Workflow

1. **Update main:**
   ```bash
   git checkout main
   git pull origin main
   ```

2. **Create a narrow feature branch:**
   ```bash
   git checkout -b feat/short-descriptive-name
   ```

3. **Start or reuse local Supabase stack:**
   ```bash
   npm run supabase:start
   ```

4. **Reset database locally when pull/checkout introduces schema updates:**
   ```bash
   npm run supabase:reset
   ```

5. **Run the Admin/CMS application & tests:**
   ```bash
   npm run dev:admin
   npm run test:admin
   ```

6. **Stop local services when finished:**
   ```bash
   npm run supabase:stop
   ```

---

## D. Branch & Pull-Request Rules

- **Never commit directly to `main`:** All work must originate on a topic/feature branch.
- **Narrow Change Scope:** Keep branches focused on a single feature, fix, or governance task.
- **Append-Only Migrations:** Database migrations are strictly append-only after merge. Never alter or rename merged migration files (`0001` through `0007`).
- **Controlled File Staging:** Use explicit path staging (`git add <file1> <file2>`). Do NOT use `git add .` or `git add -A` for controlled repository tasks.
- **Required Validation Gates:** Before submitting or requesting review, all code changes must pass:
  ```bash
  npm run lint --workspace=apps/admin-cms
  npm run test:admin
  npm run typecheck:admin
  npm run build:admin
  npm run check:feed
  git diff --check
  ```
- **No Auto-Merge:** All pull requests require review and explicit manual merge.

---

## E. Security Boundaries

- **Synthetic Data Only:** Never use real student, staff, or stakeholder PII or credentials. Fixtures must remain 100% synthetic.
- **No Secrets in Repository:** Never commit API keys, service-role keys, private connection strings, or environment files (`.env.local`, `.local-users.json`).
- **Key Preference Model:**
  - Browser code receives only `NEXT_PUBLIC_` browser-safe configuration.
  - Server-side administrative operations prefer `SUPABASE_SECRET_KEY` (with `SUPABASE_SERVICE_ROLE_KEY` fallback).
  - Never expose server keys or service-role keys to Client Components.
- **No Unauthorized Hosted Operations:** Never run `supabase db push`, `supabase db pull`, `supabase migration repair`, or state-changing scripts against hosted staging or production without explicit maintainer authorization.
- **Ignored Files:** Verify `.env.local` and `.local-users.json` remain untracked in `.gitignore`.

---

## F. Database Development

- **Local Isolated Database:** Each developer works against their own local containerized Supabase instance.
- **Schema Changes:** Any schema, policy, or function change requires a new 14-digit timestamped migration in `infra/supabase/migrations/`.
- **Clean Local Reset:** Test schema changes by running `npm run supabase:reset` to verify migrations apply cleanly from scratch.
- **Static Migration Tests:** Add Vitest contract tests under `apps/admin-cms/src/security/` for any new migration.
- **Function Privilege Default:** PostgreSQL grants no default execution privileges to Data API roles for postgres-owned functions after migration 0007. New functions are private by default and require explicit grants.
- **`supabase_admin` Isolation:** Do not modify `supabase_admin` default privileges or internal schemas (`auth.`, `storage.`).

---

## G. Definition of Done

A task is considered complete when:

1. **Requested scope is implemented** following repository architectural conventions.
2. **Working tree is clean** and free of untracked build artifacts.
3. **All validation commands pass:** `lint`, `test:admin`, `typecheck:admin`, `build:admin`, and `check:feed`.
4. **No hosted resources were touched or altered.**
5. **Documentation is updated** (e.g. `README.md`, `apps/admin-cms/README.md`, `infra/supabase/local-development.md`) whenever setup or behavior changes.
