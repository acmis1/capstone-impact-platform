# Reproducible Local Supabase Development & Onboarding Guide

This guide documents the canonical, local-only Supabase development workflow for the Capstone Impact Platform (`acmis1/capstone-impact-platform`).

## 1. Architectural Principles

- **Zero Remote Dependencies:** Local development runs entirely inside local Docker containers via the repository-pinned Supabase CLI (`supabase@2.109.1`).
- **No Supabase Organization Membership Required:** Developers do not need access to hosted Supabase, Duda, Render, or Vercel dashboards to build, test, and run the application locally.
- **Isolated Local State:** All database tables, authentication identities, storage buckets, and Mailpit email captures run on `http://127.0.0.1`.
- **Synthetic Data Safety:** Local database seeds use strictly synthetic mock data. No real student or stakeholder PII or credentials are used or committed.
- **Deterministic Migration Replay:** Running `npm run supabase:reset` replays all 7 timestamped migrations from `infra/supabase/migrations/` in strict ascending order, ending with `20260803174000_harden_function_execute_defaults.sql` *(migration 0007 is repository/local-only and not applied to hosted staging)*.
- **Verification Strategy & Scope:**
  - Static migration tests inspect committed SQL contracts.
  - Runtime verification inspects the actual local database reset, live schema, policy semantics, exact table-grant matrix, function execution privileges, storage buckets, and real password logins for all three synthetic accounts.
  - Real password sign-in was verified for all three synthetic accounts (`local.admin@capstone.test`, `local.reviewer@capstone.test`, `local.editor@capstone.test`).
  - The exact live table-grant matrix was verified across all 13 tables (anon 0 privileges; authenticated lookup SELECT only; service_role full CRUD).
  - Bootstrap function positive (`service_role`) and negative (`PUBLIC`, `anon`, `authenticated`) execution grants were verified, and trigger-helper execution privileges were verified as unexposed.
  - `supabase:seed:buckets` is a dedicated local-only script (`seedLocalSupabaseFixtures.ts`).
  - Hosted staging migration history remains separate and is not altered by local setup.

---

## 2. Professional Daily Developer Workflow

Prerequisites:
- **Node.js**: `>= 24.14.1 < 25` (Pinned via `.nvmrc` to `24.14.1`)
- **npm**: `>= 11.11.0 < 12` (Declared in `packageManager` as `npm@11.11.0`)
- **Docker Desktop / Engine**: Active locally.

Follow these steps when onboarding or starting daily work:

### Step 1: Clone & Clean Install Dependencies
```bash
git clone https://github.com/acmis1/capstone-impact-platform.git
cd capstone-impact-platform
npm ci
```

### Step 2: Run Automated Onboarding Precheck
Run the automated toolchain, Docker, Git, migration, and dependency precheck (12 checks):
```bash
npm run onboarding:check
```

### Step 3: Ensure Docker Desktop is Running
Start Docker Desktop on your operating system. Verify container runtime status:
```bash
docker ps
```

### Step 4: Start Local Supabase Stack
Start the local Supabase containers (PostgreSQL, Auth, Storage, Studio, Mailpit):
```bash
npm run supabase:start
```

### Step 5: Reset Local Database & Replay Migrations
Replay all 7 timestamped migrations (`20260601035138_...` through `20260803174000_...`) and load `seed.sql`:
```bash
npm run supabase:reset
```

### Step 6: Seed Local Storage Buckets & Synthetic Fixtures
Ensure storage buckets exist with exact local policies and synthetic poster fixtures:
```bash
npm run supabase:seed:buckets
```
*Note: `supabase:seed:buckets` is strictly local-only (`seedLocalSupabaseFixtures.ts`) and does not invoke staging scripts.*

### Step 7: Generate Local Environment Configuration
Write validated loopback environment settings to `apps/admin-cms/.env.local`:
```bash
npm run supabase:env:local
```
*Note: Existing hosted environment files must never be overwritten by local setup.*

### Step 8: Provision Local Synthetic Staff Accounts
Create reproducible synthetic accounts for `admin`, `reviewer`, and `editor`:
```bash
npm run supabase:users:local
```
This writes random per-developer passwords into the ignored file `apps/admin-cms/.local-users.json`.

### Step 9: Verify Local Stack Integrity
Run the automated verification suite:
```bash
npm run supabase:verify:local
```

### Step 10: Launch Admin/CMS Application
Start the Next.js development server:
```bash
npm run dev:admin
```
Open [http://localhost:3000/login](http://localhost:3000/login) and sign in using the synthetic credentials in `apps/admin-cms/.local-users.json`.

### Step 11: Clean Up Local Stack
Stop the local containers when finished:
```bash
npm run supabase:stop
```

---

## 3. Second-Developer Fresh-Clone Acceptance Checklist

When onboarding a new developer or testing on a fresh machine:

- [ ] Node.js (`>=24.14.1 <25`) & npm (`>=11.11.0 <12`) installed.
- [ ] Docker Desktop running (`docker ps` returns active daemon status).
- [ ] Fresh clone created: `git clone https://github.com/acmis1/capstone-impact-platform.git`.
- [ ] `npm ci` completes without workspace errors.
- [ ] `npm run onboarding:check` passes all 12 prechecks.
- [ ] `npm run supabase:start` launches local container suite.
- [ ] `npm run supabase:reset` replays all 7 migrations cleanly.
- [ ] `npm run supabase:seed:buckets` provisions local buckets and poster fixtures.
- [ ] `npm run supabase:env:local` creates `apps/admin-cms/.env.local`.
- [ ] `npm run supabase:users:local` provisions synthetic `admin`, `reviewer`, and `editor` accounts.
- [ ] `npm run supabase:verify:local` outputs PASS for all local checks.
- [ ] `npm run dev:admin` opens [http://localhost:3000/login](http://localhost:3000/login) and logs in cleanly.
- [ ] Zero hosted keys, organization access, or hosted Supabase dashboard actions were required.

---

## 4. Storage & Bucket Boundaries

| Bucket Name | Visibility | Purpose | Allowed Types | Max File Size |
|---|---|---|---|---|
| `project-drafts-private` | Private | Local synthetic draft media & private uploads | PNG, JPEG, WEBP, PDF | 20 MB |
| `project-public-assets` | Public | Local synthetic showcase images & posters | PNG, JPEG, WEBP, PDF | 20 MB |
| `public-feeds` | Public | Exported JSON showcase feeds (`capstones-latest.json`) | JSON | 10 MB |

---

## 5. Mailpit Local Email Capture

Local authentication emails (e.g. password reset, invitation links) are captured by Mailpit at:
👉 **Mailpit Web UI:** [http://localhost:54324](http://localhost:54324)

No emails leave your machine during local development.

---

## 6. Empirical Remote Fresh-Clone Verification Log

### Verification Metadata
- **Verified Branch**: `infra/second-developer-onboarding`
- **Toolchain Used**: Node `v24.14.1`, npm `11.11.0` (Satisfies Node 24 range `>= 24.14.1 < 25` and `npm >= 11.11.0 < 12`)
- **Docker Engine**: Docker Desktop on Windows 11
- **Environment Tested**: Verified in a clean Windows remote-clone run
- **Unverified Platforms**: macOS, Linux and independent human onboarding remain unverified

### Verification Sequence & Outcomes
1. `node -v` & `npm -v`: Verified Node `v24.14.1` and npm `11.11.0`.
2. `npm ci`: Added 532 packages cleanly.
3. `npm run onboarding:check`: **PASS** (12/12 automated prechecks passed).
4. `npm run supabase:start`: Container stack started cleanly.
5. `npm run supabase:reset`: Replayed all 7 database migrations (`0001` through `0007`) in strict timestamp order.
6. `npm run supabase:seed:buckets`: Created 3 local storage buckets (`project-drafts-private`, `project-public-assets`, `public-feeds`) and seeded 2 poster fixtures.
7. `npm run supabase:env:local`: Wrote loopback configuration to `apps/admin-cms/.env.local`.
8. `npm run supabase:users:local`: Provisioned 3 synthetic staff accounts (`local.admin`, `local.reviewer`, `local.editor`).
9. `npm run supabase:verify:local`: **PASS** (Verified loopback connectivity, 13 tables, RLS enablement, indexes/triggers, policy semantics, 13-table grant matrix, function execution ACLs, storage bucket policies, public feed compiler, and password sign-in for all 3 synthetic roles).
10. `migration_count`: Verified exactly 7 migration-history rows in `supabase_migrations.schema_migrations`.
11. `npm run dev:admin`: Next.js 16 server started on port 3000.
12. `http://localhost:3000/api/health`: Returned `HTTP 200 OK`.
13. `http://localhost:3000/login`: Returned `HTTP 200 OK`.
14. `npm run check:feed`: **PASS** (2 public feed records compiled, schema compliant).
15. `npm run lint --workspace=apps/admin-cms`: **PASS** (0 errors, 0 warnings).
16. `npm run test:admin`: **PASS** (36 test files, 376 tests passed).
17. `npm run typecheck:admin`: **PASS** (`tsc --noEmit` code 0).
18. `npm run build:admin`: **PASS** (`next build` completed in 2.7s).
19. `npm run supabase:stop`: Stopped local container stack cleanly.

---

## 7. Security & Prohibited Operations

- **DO NOT** run `supabase login`, `supabase link`, `supabase db push`, `supabase db pull`, or `supabase migration repair` against hosted staging/production without maintainer authorization.
- **DO NOT** commit credentials, secrets, tokens, or `.env.local` files.
- **DO NOT** seed real user emails, passwords, or personal identity data.
