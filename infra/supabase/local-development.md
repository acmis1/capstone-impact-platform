# Reproducible Local Supabase Development Guide

This guide documents the canonical, local-only Supabase development workflow for the Capstone Impact Platform (`acmis1/capstone-impact-platform`).

## 1. Architectural Principles

- **Zero Remote Dependencies:** Local development runs entirely inside local Docker containers via the repository-pinned Supabase CLI (`supabase@2.109.1`).
- **No Supabase Organization Membership Required:** Developers do not need access to hosted Supabase, Duda, Render, or Vercel dashboards to build, test, and run the application locally.
- **Isolated Local State:** All database tables, authentication identities, storage buckets, and Mailpit email captures run on `http://127.0.0.1`.
- **Synthetic Data Safety:** Local database seeds use strictly synthetic mock data. No real student or stakeholder PII or credentials are used or committed.
- **Verification Strategy & Scope:**
  - Static migration tests inspect committed SQL contracts.
  - Runtime verification inspects the actual local database reset, live schema, policy semantics, exact table-grant matrix, function execution privileges, storage buckets, and real password logins for all three synthetic accounts.
  - Real password sign-in was verified for all three synthetic accounts (`local.admin@capstone.test`, `local.reviewer@capstone.test`, `local.editor@capstone.test`).
  - The exact live table-grant matrix was verified across all 13 tables (anon 0 privileges; authenticated lookup SELECT only; service_role full CRUD).
  - Bootstrap function positive (`service_role`) and negative (`PUBLIC`, `anon`, `authenticated`) execution grants were verified, and trigger-helper execution privileges were verified as unexposed.
  - Live policy roles, commands, and expressions were verified (`select_*_authenticated` = true; `admin_all_*` = false).
  - Validation was performed on one Windows Docker Desktop environment; another teammate must still confirm cross-platform onboarding.
  - No hosted service was contacted in this final run.
  - `supabase:seed:buckets` is a dedicated local-only script (`seedLocalSupabaseFixtures.ts`).
  - Hosted staging migration history remains separate and is not altered by local setup.

---

## 2. Professional Daily Developer Workflow

Follow these steps when onboarding or starting daily work:

### Step 1: Clone & Install Dependencies
```bash
git clone https://github.com/acmis1/capstone-impact-platform.git
cd capstone-impact-platform
npm install
```

### Step 2: Ensure Docker Desktop is Running
Start Docker Desktop on your operating system. Verify container runtime status:
```bash
docker ps
```

### Step 3: Start Local Supabase Stack
Start the local Supabase containers (PostgreSQL, Auth, Storage, Studio, Mailpit):
```bash
npm run supabase:start
```

### Step 4: Reset Local Database & Replay Migrations
Replay all timestamped migrations (`20260601035138_...` through `20260719165119_...`) and load `seed.sql`:
```bash
npm run supabase:reset
```

### Step 5: Seed Local Storage Buckets & Synthetic Fixtures
Ensure storage buckets exist with exact local policies and synthetic poster fixtures:
```bash
npm run supabase:seed:buckets
```
*Note: `supabase:seed:buckets` is strictly local-only (`seedLocalSupabaseFixtures.ts`) and does not invoke staging scripts.*

### Step 6: Generate Local Environment Configuration
Write validated loopback environment settings to `apps/admin-cms/.env.local`:
```bash
npm run supabase:env:local
```
*Note: Existing hosted environment files must never be overwritten by local setup.*

### Step 7: Provision Local Synthetic Staff Accounts
Create reproducible synthetic accounts for `admin`, `reviewer`, and `editor`:
```bash
npm run supabase:users:local
```
This writes random per-developer passwords into the ignored file `apps/admin-cms/.local-users.json`.

### Step 8: Verify Local Stack Integrity
Run the automated verification suite:
```bash
npm run supabase:verify:local
```

### Step 9: Launch Admin/CMS Application
Start the Next.js development server:
```bash
npm run dev:admin
```
Open [http://localhost:3000](http://localhost:3000) and sign in using the synthetic credentials in `apps/admin-cms/.local-users.json`.

---

## 3. Storage & Bucket Boundaries

| Bucket Name | Visibility | Purpose | Allowed Types | Max File Size |
|---|---|---|---|---|
| `project-drafts-private` | Private | Local synthetic draft media & private uploads | PNG, JPEG, WEBP, PDF | 20 MB |
| `project-public-assets` | Public | Local synthetic showcase images & posters | PNG, JPEG, WEBP, PDF | 20 MB |
| `public-feeds` | Public | Exported JSON showcase feeds (`capstones-latest.json`) | JSON | 10 MB |

---

## 4. Mailpit Local Email Capture

Local authentication emails (e.g. password reset, invitation links) are captured by Mailpit at:
👉 **Mailpit Web UI:** [http://localhost:54324](http://localhost:54324)

No emails leave your machine during local development.

---

## 5. Security & Prohibited Operations

- **DO NOT** run `supabase login`, `supabase link`, `supabase db push`, `supabase db pull`, or `supabase migration repair` against hosted staging/production without maintainer authorization.
- **DO NOT** commit credentials, secrets, tokens, or `.env.local` files.
- **DO NOT** seed real user emails, passwords, or personal identity data.
