# Contributing to Capstone Impact Platform

This guide outlines the contributor workflow, repository standards, security boundaries, and definition of done for the Capstone Impact Platform.

---

## A. Prerequisites & Environment Setup

All contributors must install and verify the canonical toolchain before making repository modifications.

### 1. Canonical Toolchain Contract
- **Node.js**: `Node >= 24.14.1 < 25` (Pinned via `.nvmrc` to `24.14.1`; Node 24 is the maintained LTS line used for verification).
- **npm**: `npm >= 11.11.0 < 12` (Declared in `packageManager` as `npm@11.11.0`).
- **Docker**: Docker Desktop (Windows/macOS) or Docker Engine (Linux). Must be running locally.
- **Supabase CLI**: Pinned in `package.json` devDependencies as `supabase@2.109.1`. *(Local development requires NO Supabase cloud account or organization membership.)*

---

## B. Canonical Fresh-Clone Onboarding Workflow

For a clean clone, execute the following sequence:

```bash
# 1. Clone repository and navigate to root
git clone https://github.com/acmis1/capstone-impact-platform.git
cd capstone-impact-platform

# 2. Verify toolchain contract
node -v   # Must satisfy >= 24.14.1 < 25
npm -v    # Must satisfy >= 11.11.0 < 12

# 3. Clean install dependencies
npm ci

# 4. Run automated onboarding precheck (12 checks)
npm run onboarding:check

# 5. Start local Supabase container stack
npm run supabase:start

# 6. Reset local database and replay all 7 migrations
npm run supabase:reset

# 7. Seed local storage buckets and synthetic media fixtures
npm run supabase:seed:buckets

# 8. Generate loopback local environment file (apps/admin-cms/.env.local)
npm run supabase:env:local

# 9. Provision synthetic staff accounts (apps/admin-cms/.local-users.json)
npm run supabase:users:local

# 10. Run comprehensive local Supabase verification suite
npm run supabase:verify:local

# 11. Start Next.js Admin/CMS development server
npm run dev:admin

# 12. Run public feed compliance check
npm run check:feed

# 13. Stop local stack when finished
npm run supabase:stop
```

---

## C. Daily Developer Workflow

```bash
# Start local containers
npm run supabase:start

# Launch Next.js dev server
npm run dev:admin

# Run unit and security test suite
npm run test:admin

# Run TypeScript type checking
npm run typecheck:admin

# Run ESLint
npm run lint --workspace=apps/admin-cms

# Stop local stack
npm run supabase:stop
```

---

## D. Repository Branching & Pull Request Rules

- **Branch Naming**: Use feature branches with clear prefixes: `feat/*`, `fix/*`, `infra/*`, `docs/*`, `security/*`.
- **Merge Base**: All feature branches must branch from and target `main`.
- **Explicit Path Staging**: Never run `git add .` or `git add -A`. Stage explicit paths using `git add <file1> <file2>`.
- **Clean Diff Gate**: Run `git diff --check` before committing to ensure no whitespace errors exist.

---

## E. Security & Governance Boundaries

1. **No Credentials in Code**: Never hardcode, log, or commit secret keys, API tokens, passwords, or connection strings.
2. **Local Environment Generator**: Always use `npm run supabase:env:local` to generate `apps/admin-cms/.env.local`. Do not manually copy or alter `.env.example` templates meant for shared staging.
3. **No Private Dashboard Access**: Developers and automated subagents must never attempt to access private Supabase, Duda, Render, or cloud administrative dashboards.
4. **Synthetic Data Only**: Never load real student, staff, or supervisor personal data into local or staging environments.
5. **Stage-Gated Staging Scripts**: Staging scripts require explicit acknowledgement flags (`--apply --confirm-staging=capstone-admin-cms-staging-2026`). Default invocations operate strictly in dry-run mode.

---

## F. Database & Migration Governance

- **Migration Inventory (7 Migrations)**:
  1. `20260601035138_staging_schema.sql`
  2. `20260601035139_staging_rls_policies.sql`
  3. `20260715102956_admin_auth_identity.sql`
  4. `20260719003407_explicit_data_api_grants.sql`
  5. `20260719165118_initial_admin_bootstrap.sql`
  6. `20260719165119_fix_initial_admin_bootstrap_runtime.sql`
  7. `20260803174000_harden_function_execute_defaults.sql` *(Local/repository-only; not yet applied to hosted staging.)*
- **Migration Naming**: All new migration files in `infra/supabase/migrations/` must be named with a 14-digit timestamp prefix (`YYYYMMDDHHMMSS_description.sql`).

---

## G. Definition of Done for Contributions

A contribution is complete when:
- `npm run onboarding:check` passes (12/12 checks).
- All 7 database migrations replay cleanly via `npm run supabase:reset`.
- `npm run check:feed` passes.
- `npm run lint --workspace=apps/admin-cms` reports 0 errors and 0 warnings.
- `npm run test:admin` passes all tests.
- `npm run typecheck:admin` passes with zero type errors.
- `npm run build:admin` builds Next.js without errors.
- `git diff --check` passes cleanly.
- Documentation accurately reflects all code and schema changes.
