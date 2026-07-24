# Reproducible Local Supabase Development Guide

This guide documents the canonical, 100% reproducible local Supabase development workflow for the Capstone Impact Platform (`acmis1/capstone-impact-platform`).

## 1. Architectural Principles

- **Zero Remote Dependencies:** Local development runs entirely inside local Docker containers via the repository-pinned Supabase CLI (`supabase@2.109.1`).
- **No Supabase Organization Membership Required:** Developers do not need access to hosted Supabase, Duda, Render, or Vercel dashboards to build, test, and run the application locally.
- **Isolated Local State:** All database tables, authentication identities, storage buckets, and Mailpit email captures run on `http://127.0.0.1`.
- **Synthetic Data Safety:** Local database seeds use strictly synthetic mock data. No real student or stakeholder PII or credentials are used or committed.

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

### Step 5: Generate Local Environment Configuration
Write validated loopback environment settings to `apps/admin-cms/.env.local`:
```bash
npm run supabase:env:local
```

### Step 6: Provision Local Synthetic Staff Accounts
Create reproducible synthetic accounts for `admin`, `reviewer`, and `editor`:
```bash
npm run supabase:users:local
```
This writes random per-developer passwords into the ignored file `apps/admin-cms/.local-users.json`.

### Step 7: Verify Local Stack Integrity
Run the automated verification suite:
```bash
npm run supabase:verify:local
```

### Step 8: Launch Admin/CMS Application
Start the Next.js development server:
```bash
npm run dev:admin
```
Open [http://localhost:3000](http://localhost:3000) and sign in using the synthetic credentials in `apps/admin-cms/.local-users.json`.

---

## 3. Storage & Bucket Boundaries

| Bucket Name | Visibility | Purpose | Allowed Types | Max File Size |
|---|---|---|---|---|
| `project-drafts-private` | Private | Raw student uploads & internal draft media | PNG, JPEG, WEBP, PDF | 20 MB |
| `project-public-assets` | Public | Public showcase images and posters | PNG, JPEG, WEBP, PDF | 20 MB |
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
