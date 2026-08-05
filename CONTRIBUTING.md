# Contributing to Capstone Impact Platform

This guide outlines the contributor workflow, repository branching rules, database migration standards, security boundaries, and definition of done for the Capstone Impact Platform (`acmis1/capstone-impact-platform`).

> [!TIP]
> **DEVELOPERS / NEW CONTRIBUTORS**: Please read **[`START_HERE.md`](./START_HERE.md)** first for setup and guidelines. See **[`docs/first-contribution.md`](./docs/first-contribution.md)** for a beginner contribution guide and **[`docs/onboarding-acceptance-checklist.md`](./docs/onboarding-acceptance-checklist.md)** for human verification.

---

## A. Prerequisites & Toolchain Contract

All contributors must install and verify the canonical toolchain before making repository modifications.

- **Node.js**: `Node >= 24.14.1 < 25` (Pinned via `.nvmrc` to `24.14.1`; Node 24 is the maintained LTS line used for verification).
- **npm**: `npm >= 11.11.0 < 12` (Declared in `packageManager` as `npm@11.11.0`).
- **Docker**: Docker Desktop (Windows/macOS) or Docker Engine (Linux) running locally.
- **Supabase CLI**: Pinned in `package.json` devDependencies as `supabase@2.109.1`.

---

## B. Fresh-Clone Onboarding Workflow

For a clean checkout (requires zero hosted Supabase or organization access):

```bash
# 1. Clone repository and navigate to root
git clone https://github.com/acmis1/capstone-impact-platform.git
cd capstone-impact-platform

# 2. Clean install dependencies
npm ci

# 3. Run automated onboarding precheck (12 checks)
npm run onboarding:check

# 4. Start local Supabase container stack
npm run supabase:start

# 5. Reset local database and replay all 8 migrations
npm run supabase:reset

# 6. Seed local storage buckets and synthetic media fixtures
npm run supabase:seed:buckets

# 7. Generate loopback local environment file (apps/admin-cms/.env.local)
npm run supabase:env:local

# 8. Provision synthetic staff accounts (apps/admin-cms/.local-users.json)
npm run supabase:users:local

# 9. Run comprehensive local Supabase verification suite
npm run supabase:verify:local

# 10. Start Next.js Admin/CMS development server
npm run dev:admin

# 11. Run public feed compliance check
npm run check:feed

# 12. Stop local stack when finished
npm run supabase:stop
```

---

## C. Repository Branching & Workflow Rules

1. **Never Commit Directly to Main**: All development must occur on narrow feature branches (`feat/*`, `fix/*`, `infra/*`, `docs/*`, `security/*`).
2. **Sync Before Branching**: Always fetch `origin` and update `main` before creating a new branch:
   ```bash
   git checkout main
   git pull --ff-only origin main
   ```
3. **Target Main**: Feature branches must branch from and target `main`.
4. **No Auto-Merge**: PRs require explicit review and manual merge. Auto-merge is prohibited.
5. **Stage Explicit Files Only**: Never use broad staging commands like `git add .` or `git add -A`. Stage explicit file paths (`git add path/to/file1 path/to/file2`).
6. **Clean Diff Gate**: Run `git diff --check` before committing to ensure no trailing whitespace or git diff syntax errors exist.
7. **No Force-Push**: Never force-push any branch. Never force-push `main`.
8. **No Rebase of Pushed Branches**: Do not rebase a pushed branch unless a maintainer explicitly directs it.

---

## D. Security & Data Handling Boundaries

1. **Synthetic Data Only**: Never load or test with real project participant, staff, or supervisor personal data. Use synthetic mock data only.
2. **Never Use Production/Recovery Environments**: Local development must target loopback (`127.0.0.1`). Never use production or recovery environments.
3. **No Credentials in Code or Docs**: Secrets, API keys, private tokens, passwords, and database connection strings must never appear in code, logs, screenshots, issues, or pull requests.
4. **Local Credentials Ignored**: Local environment files (`apps/admin-cms/.env.local`) and user credential stores (`apps/admin-cms/.local-users.json`) remain strictly git-ignored.
5. **Dashboard Access Policy**: Normal local contributors need no hosted administrative dashboard access (Supabase, Duda, Render, Vercel). Hosted operator access requires explicit project owner authorization for the specific operation and environment.
6. **Staging Guard & Acknowledgment Refusal**: Shared-staging state-changing commands require target environment identity validation (`CAPSTONE_RUNTIME_ENV=staging`, `CAPSTONE_EXPECTED_SUPABASE_HOST`) and double-acknowledgment flags (`--apply --confirm-staging=capstone-admin-cms-staging-2026`). Missing required flags cause a refusal before Supabase admin-client creation.

---

## E. Database & Migration Governance

1. **Append-Only Migrations**: Migrations are append-only after merge. Never edit, rename, or delete existing migrations `0001` through `0008`.
2. **New Schema Changes**: Any schema, policy, or grant change requires a new 14-digit timestamped migration file in `infra/supabase/migrations/` (`YYYYMMDDHHMMSS_description.sql`).
3. **Local Replay & Reset Verification**: Verify all schema changes locally by running `npm run supabase:reset` to replay migrations from zero in strict timestamp order.
4. **Static Contract Tests**: Add static contract tests in `apps/admin-cms/src/security/` for any new database migration file.
5. **RLS, Grants, and Function ACLs**:
   - Ensure Row-Level Security (RLS) is enabled on all tables.
   - Enforce explicit least-privilege Data API grants (`anon`, `authenticated`, `service_role`).
   - New postgres-owned functions are private by default; execution privileges must be explicitly revoked from `PUBLIC`, `anon`, and `authenticated`, and granted only to intended roles (e.g. `service_role`).
   - Do not alter `supabase_admin` default privileges.

### Migration Inventory (8 Timestamped Migrations)

1. `20260601035138_staging_schema.sql` — Schema baseline and constraints
2. `20260601035139_staging_rls_policies.sql` — Row-Level Security policies
3. `20260715102956_admin_auth_identity.sql` — Admin user identity linkage
4. `20260719003407_explicit_data_api_grants.sql` — Data API table grants
5. `20260719165118_initial_admin_bootstrap.sql` — Guarded admin bootstrap function
6. `20260719165119_fix_initial_admin_bootstrap_runtime.sql` — Bootstrap runtime correction
7. `20260803174000_harden_function_execute_defaults.sql` — Function default execute ACL revokes and RLS helper guard *(Committed in repository; local/repository-only; not yet applied to hosted staging)*
8. `20260803180000_transactional_review_actions.sql` — Atomic project review action PostgreSQL RPC and audit logging *(Committed in repository; local/repository-only; not yet applied to hosted staging)*

---

## F. Definition of Done

A contribution is complete when:
- The work requires zero hosted resource or dashboard access for local execution.
- `npm run onboarding:check` passes (12/12 automated checks).
- All 8 database migrations replay cleanly via `npm run supabase:reset`.
- `npm run check:feed` passes schema validation.
- `npm run lint --workspace=apps/admin-cms` reports 0 errors and 0 warnings.
- `npm run test:admin` passes all unit and security tests.
- `npm run typecheck:admin` passes with zero TypeScript errors.
- `npm run build:admin` builds Next.js without errors.
- `git diff --check` passes cleanly.
- Documentation accurately reflects all code and schema changes.

---

## G. Developer Contribution Lifecycle

1. **Repository Access & Forks**:
   - Developers with direct repository write access create branches directly on `acmis1/capstone-impact-platform`.
   - External developers fork the repository and open Pull Requests from their fork to `acmis1/capstone-impact-platform:main`.

2. **Issue Selection & Assignment**:
   - Always pick an assigned issue from GitHub Issues before starting work.
   - Limit work to **one issue per branch**. Do not bundle multiple unrelated tasks into one branch.

3. **Branch Creation & Naming**:
   - Sync `main` first:
     ```bash
     git checkout main
     git pull --ff-only origin main
     ```
   - Create your feature branch using approved prefixes (`docs/*`, `feat/*`, `fix/*`, `infra/*`, `security/*`):
     - Example: `git checkout -b feat/project-filter-ui`
     - Example: `git checkout -b fix/table-sorting-order`

4. **Synchronizing Your Branch**:
   - Keep your branch synchronized with `main` using merge — do not rebase a pushed branch:
     ```bash
     git fetch origin
     git checkout main
     git pull --ff-only origin main
     git checkout your-feature-branch
     git merge main
     ```

5. **Commit Message Conventions**:
   - Use clear, action-oriented commit messages formatted as `type(scope): message`:
     - `feat(review): implement atomic review transition RPC`
     - `fix(auth): correct synthetic password generator boundary`
     - `docs(readme): add developer onboarding guide`
     - `chore(deps): update local devDependencies`

6. **Resolving Merge Conflicts Safely**:
   - If merge conflicts occur against `main`, resolve them locally in your feature branch.
   - **Never force-push (`git push --force`) any branch. Never force-push `main`.**
   - Do not resolve migration conflicts by editing merged migrations — ask a maintainer.
   - Re-run `npm run verify:all` after resolving conflicts to ensure all quality gates pass.

7. **Review Expectations & Self-Merging Prohibition**:
   - Self-merging without maintainer review is strictly prohibited.
   - Request review from a maintainer (`@acmis1`).
   - If changes are requested during review, make corrective commits on your feature branch and push to update the open PR.

8. **Branch Cleanup After Squash Merge**:
   - Pull requests are squash-merged into `main`.
   - After your PR is merged, delete the remote branch:
     ```bash
     git push origin --delete your-feature-branch
     ```
   - Switch locally to `main` and update:
     ```bash
     git checkout main
     git pull --ff-only origin main
     ```
   - Try to delete your local branch pointer:
     ```bash
     git branch -d your-feature-branch
     ```
   - If Git refuses (because squash-merge history is not directly in your branch), verify the diff is empty:
     ```bash
     git diff main..your-feature-branch
     ```
   - If the diff is empty, the branch is safe to leave as a harmless local pointer, or ask a maintainer to confirm before deleting.
   - **Do not use `git branch -D` unless a maintainer has confirmed it is safe.**
