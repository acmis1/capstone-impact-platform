# Reproducible Local Supabase Development & Onboarding Guide

This guide documents the canonical, local-only Supabase development workflow for the Capstone Impact Platform (`acmis1/capstone-impact-platform`).

## 1. Architectural Principles

- **No Hosted Credentials or Dashboards Required:** No hosted project credentials, private dashboards, or shared remote application environments are required for normal local development. (Note: Standard internet access is still required for initial `git clone`, `npm ci`, and pulling Docker images).
- **No Supabase Organization Membership Required:** Developers do not need access to hosted Supabase, Duda, Render, or Vercel dashboards to build, test, and run the application locally.
- **Isolated Local State:** All database tables, authentication identities, storage buckets, and Mailpit email captures run locally. Docker publishes enabled Supabase ports `54321`–`54327` only on `127.0.0.1`, and the Admin/CMS development server binds only to `127.0.0.1:3000`.
- **Verified Host Binding:** `supabase:start` creates or reuses the deterministic `capstone-impact-platform-local-loopback` bridge network, captures and passes its immutable Docker ID to the pinned Supabase CLI, rechecks that ID after execution, verifies every container attachment by ID, explicitly applies loopback to Docker create requests for Docker Desktop compatibility, and then fails closed unless structured Docker inspection proves the exact required container set, health, and every published project port.
- **Private Docker Compatibility Proxy:** The compatibility proxy exists only for one `start` or local reset invocation. It uses a cryptographically random per-run header supplied only to that CLI child, requires the header on normal and upgrade requests, strips it before forwarding, and uses a unique private endpoint. The optional Vector log collector is excluded because it requires independent Docker-socket access and cannot present the per-run CLI capability; local application, database, Auth, Storage, Studio, Mailpit, and Analytics workflows do not depend on that collector. On Unix, runtime checks require a `0700` directory plus a `0600` readiness file and socket; shutdown removes them. Native Windows uses a unique named pipe without enabling Node's all-user read/write options, but its ACL behavior remains runtime-unverified for this patch. Native developer Linux also remains runtime-unverified beyond tests and CI contracts.
- **Synthetic Data Safety:** Local database seeds use strictly synthetic mock data. No real participant or stakeholder PII or credentials are used or committed.
- **Deterministic Migration Replay:** Running `npm run supabase:reset` replays all 9 timestamped migrations from `infra/supabase/migrations/` in strict ascending order, ending with `20260808170000_transactional_project_metadata_update.sql` *(migrations 0007 through 0009 are repository/local-only and not applied to hosted staging; migration 0009 remains draft in PR #40)*.
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

### Canonical Quick Start (One Command)
```bash
git clone https://github.com/acmis1/capstone-impact-platform.git
cd capstone-impact-platform
npm ci
npm run setup:local
npm run dev:admin
```

### Clean Stack Shutdown
```bash
npm run supabase:stop
```

### Diagnostic & Subcommand Reference
The `npm run setup:local` runner automatically executes these diagnostic steps in sequence:
1. `npm run onboarding:check` — Toolchain, Docker, Git, and migration precheck
2. `npm run supabase:start` — Reuse or create the validated project Docker network, launch local Supabase containers, and assert loopback-only publication for all enabled ports
3. `npm run supabase:seed:buckets` — Reconcile private/public storage buckets and synthetic poster fixtures
4. `npm run supabase:env:local` — Write loopback environment variables to `apps/admin-cms/.env.local`
5. `npm run supabase:users:local` — Provision synthetic `admin`, `reviewer`, and `editor` staff accounts
6. `npm run supabase:verify:local` — Verify loopback connectivity, schema, grants, RLS, storage, and password logins

*(Note: `setup:local` is safe and idempotent to rerun. Use `npm run supabase:reset` separately only for an intentional clean database reconstruction that replays all 9 migrations from scratch.)*

---

## 3. Second-Developer Fresh-Clone Acceptance Checklist

When onboarding a new developer or testing on a fresh machine:

- [ ] Node.js (`>=24.14.1 <25`) & npm (`>=11.11.0 <12`) installed.
- [ ] Docker Desktop running (`docker ps` returns active daemon status).
- [ ] Fresh clone created: `git clone https://github.com/acmis1/capstone-impact-platform.git`.
- [ ] `npm ci` completes without workspace errors.
- [ ] `npm run onboarding:check` passes all 12 prechecks.
- [ ] `npm run supabase:start` launches local container suite.
- [ ] Structured Docker inspection reports ports `54321`–`54327` on loopback only, with no `0.0.0.0` or `::` publication.
- [ ] `npm run supabase:reset` replays all 9 migrations cleanly.
- [ ] `npm run supabase:seed:buckets` provisions local buckets and poster fixtures.
- [ ] `npm run supabase:env:local` creates `apps/admin-cms/.env.local`.
- [ ] `npm run supabase:users:local` provisions synthetic `admin`, `reviewer`, and `editor` accounts.
- [ ] `npm run supabase:verify:local` outputs PASS for all local checks.
- [ ] `npm run dev:admin` listens on `127.0.0.1:3000`, and [http://localhost:3000/login](http://localhost:3000/login) opens and logs in cleanly.
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
- **Unverified Platforms at the time of this historical log**: macOS, Linux and independent human onboarding were unverified

The log below is the historical Windows clean-clone record. Separately, native macOS corrective verification passed on the recorded local checkout after the loopback-binding fix: canonical setup, ports `54321`–`54327` on `127.0.0.1` only, Admin/CMS on `127.0.0.1:3000`, application smoke checks, and the full repository suite all passed. That corrective run was not an independent fresh-clone human onboarding trial; native developer Linux remains unverified beyond Ubuntu CI.

### Verification Sequence & Outcomes
1. `node -v` & `npm -v`: Verified Node `v24.14.1` and npm `11.11.0`.
2. `npm ci`: Added 532 packages cleanly.
3. `npm run onboarding:check`: **PASS** (12/12 automated prechecks passed).
4. `npm run supabase:start`: Container stack started cleanly.
5. `npm run supabase:reset`: Replayed all 7 database migrations (`0001` through `0007`) in strict timestamp order *(historical recorded log from initial 7-migration onboarding run; current baseline replays all 9 migrations `0001` through `0009`)*.
6. `npm run supabase:seed:buckets`: Created 3 local storage buckets (`project-drafts-private`, `project-public-assets`, `public-feeds`) and seeded 2 poster fixtures.
7. `npm run supabase:env:local`: Wrote loopback configuration to `apps/admin-cms/.env.local`.
8. `npm run supabase:users:local`: Provisioned 3 synthetic staff accounts (`local.admin`, `local.reviewer`, `local.editor`).
9. `npm run supabase:verify:local`: **PASS** (Verified loopback connectivity, 13 tables, RLS enablement, indexes/triggers, policy semantics, 13-table grant matrix, function execution ACLs, storage bucket policies, public feed compiler, and password sign-in for all 3 synthetic roles).
10. `migration_count`: Verified 7 migration-history rows in historical run (8 in current baseline).
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
