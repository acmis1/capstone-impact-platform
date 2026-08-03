# Local Supabase Development & Testing Guide

This document defines the canonical local database setup, seed fixtures, synthetic staff authentication workflow, and verification log for the Capstone Impact Platform.

---

## 1. Local Architecture & Environment Guarantees

Local development is powered by Docker Desktop/Engine and the repository-pinned Supabase CLI (`2.109.1`).

### Guarantees
1. **Loopback Isolation**: Local database (`127.0.0.1:54322`) and API services (`127.0.0.1:54321`) run entirely on loopback.
2. **Zero Cloud Account Dependency**: Local development requires **no** Supabase cloud account or organization membership.
3. **No Hosted Staging Impact**: Local reset, seeding, and user provisioning perform zero network calls to hosted Supabase infrastructure.
4. **Deterministic Migration Replay**: Running `npm run supabase:reset` replays all 7 timestamped migrations from `infra/supabase/migrations/` in strict ascending order.

---

## 2. Canonical Local Setup Instructions

```bash
# 1. Clean install dependencies
npm ci

# 2. Run automated onboarding precheck (12 checks)
npm run onboarding:check

# 3. Start local Supabase containers
npm run supabase:start

# 4. Replay all 7 migrations and seed database
npm run supabase:reset

# 5. Seed local storage buckets and synthetic media fixtures
npm run supabase:seed:buckets

# 6. Generate apps/admin-cms/.env.local with loopback credentials
npm run supabase:env:local

# 7. Provision local synthetic staff accounts into Auth & DB
npm run supabase:users:local

# 8. Run comprehensive local Supabase verification
npm run supabase:verify:local
```

---

## 3. Synthetic Staff Credentials

Synthetic staff accounts are created locally with predictable test passwords. Credentials are saved to `apps/admin-cms/.local-users.json` (git-ignored):

* **Admin Role**: `local.admin@capstone.test`
* **Reviewer Role**: `local.reviewer@capstone.test`
* **Editor Role**: `local.editor@capstone.test`

Password format: `TestPassword123!`

---

## 4. Empirical Fresh-Clone Verification Log

### Verification Metadata
- **Verified Branch**: `infra/second-developer-onboarding`
- **Toolchain Used**: Node `v24.14.1`, npm `11.11.0` (Satisfies Node 24 maintained LTS range `>= 24.14.1 < 25` and `npm >= 11.11.0 < 12`)
- **Docker Engine**: Docker Desktop on Windows 11
- **Tested Operating System**: Windows (x64)
- **Unverified Operating Systems**: macOS, Linux (require independent human developer verification)

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
16. `npm run test:admin`: **PASS** (36 test files, 366 tests passed).
17. `npm run typecheck:admin`: **PASS** (`tsc --noEmit` code 0).
18. `npm run build:admin`: **PASS** (`next build` completed in 2.7s).
19. `npm run supabase:stop`: Stopped local container stack cleanly.
