# Capstone Impact Platform: Admin CMS (Staging Foundation)

This is the **staging foundation for the future production Admin/CMS** developed in Next.js, TypeScript, and Supabase. It implements the core ingestion, schema-validation, and feed compilation staging baseline for Part 2 of the Capstone project.

---

## 🛡️ Staging Isolation & Safety Rules

1.  **Strict Isolation from Prototype**: This workspace is located inside `apps/admin-cms/` and is completely separate from the original `/Prototype` directory, preserving all initial demo logs and mock parameters.
2.  **Staging-Only Database & Storage**: This foundation uses a newly created, isolated Supabase free-tier staging project (`capstone-impact-staging`) instead of the previous demo project.
3.  **Duda Isolation**: The live showcase layer is *not* connected to the new staging buckets during this validation phase to prevent any visual disruptions on stakeholder-facing pages.
4.  **No Secrets in Git**: Secret values, database passwords, and administrative keys must never be committed. `.env` and `.env.local` files are strictly git-ignored.
5.  **Staging Data Restriction**: In accordance with university privacy rules, no active student records or coordinator email listings may be uploaded. Staging testing operates exclusively on fake generated mock fixtures.
6.  **Staging Status**: This is a production-oriented staging foundation for development verification, not the final production implementation. The final workflow, relational schema definitions, and RLS policies are subject to stakeholder and academic advisor confirmation in July.

---

## ⚙️ Configuration & Setup Steps

### Step 1: Environment Configuration
Copy the staging environment template to a local ignored configuration file:
```bash
cp .env.example .env.local
```

Open `.env.local` and populate the keys for your isolated Supabase staging project:
*   `NEXT_PUBLIC_SUPABASE_URL`: Your Supabase project URL (e.g. `https://xyz.supabase.co`)
*   `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`: Client-safe publishable key (`sb_publishable_...`). Preferred public key.
*   `SUPABASE_SERVICE_ROLE_KEY`: Server-only administrative key (JWT format, beginning with `eyJhbGc...`). **Preferred staging database admin key** to reliably bypass RLS on PostgREST request paths.
*   `SUPABASE_SECRET_KEY`: Server-only administrative key (`sb_secret_...`). Supported server-only fallback key. **NEVER expose to browser code.**

> [!WARNING]
> **NEVER COMMIT `.env.local` to git or expose private keys to standard frontend client-side scripts.**

> [!IMPORTANT]
> **🔑 Staging Database Admin Operations & Key Preference:**
> * Staging database admin operations **prefer `SUPABASE_SERVICE_ROLE_KEY` first** because standard Supabase JS/PostgREST database requests require the JWT `service_role` signature to bypass Row-Level Security (RLS).
> * The latest `SUPABASE_SECRET_KEY` (`sb_secret_...`) format is fully supported as a fallback, but in this PostgREST path it may trigger `permission denied` (42501/403) errors if RLS bypass claims cannot be parsed from non-JWT Bearer authentication headers.

---

## 🏃 Available Scripts

You can run these scripts in either of two ways:

### Option A: From the Repository Root (Convenience Scripts)
*   **TypeScript Checks**: `npm run typecheck:admin`
*   **Audit Public Feed**: `npm run check:feed`
*   **Build Workspace**: `npm run build:admin`
*   **Start Local CMS**: `npm run dev:admin`

### Option B: From the App Workspace Directory
First navigate into the app folder:
```bash
cd apps/admin-cms
```
Then execute standard scripts:
*   **Perform TypeScript Compile Checks**: `npm run typecheck`
*   **Verify Approved-Only Public Feed Compiler**: `npm run check:sample-feed`
*   **Build Staging Assets**: `npm run build`
*   **Start Staging CMS locally**: `npm run dev`

---

## 📂 Codebase Architecture

The staging foundation is structured as follows:
*   `infra/supabase/` — Database migrations (`0001_staging_schema.sql`, `0002_staging_rls_policies.sql`) and manual apply guidelines.
*   `src/app/` — App Router landing pages, status dashboards, and API endpoints (`/api/health`, `/api/projects`).
*   `src/domain/` — Relational domain models mapping Projects, MediaAssets, and WorkflowStates cleanly to eradicate unstructured JSON blobs.
*   `src/repositories/` — Decoupled repository patterns (`ProjectRepository`, `SupabaseProjectRepository`) for DB operations.
*   `src/lib/env.ts` — Runtime environment validation powered by `zod`.
*   `src/lib/supabase/` — Safe client and secure administrative server-side connection wrappers.
*   `src/lib/gemini/` — Assistive metadata extraction adapter (disabled by default).
*   `src/feed/` — Approved-only public JSON feed compilers and schema contract validators.
*   `src/validation/` — Rules-first metadata review and approval validation engines.
*   `src/storage/` — Documented operational storage guidelines and access policies.
*   `src/fixtures/` — Fictional mock dataset records representing diverse publication states.
*   `src/scripts/` — Offline validation script executing compilation checks on startup.

---

## 💾 Database Schema & APIs

The staging database schema is now scaffolded and ready for manual application:

1. **Schema Migration:** Apply `infra/supabase/migrations/0001_staging_schema.sql` and `infra/supabase/migrations/0002_staging_rls_policies.sql` to your **capstone-impact-staging** project using the Supabase SQL Editor.
2. **Setup Instructions:** Refer to `infra/supabase/manual-apply-guide.md` for full step-by-step instructions.
3. **No Real Data:** Never populate this database with real stakeholder or student personal data.
4. **API Endpoints:**
   * **`GET /api/health`:** Basic health check. Runs completely offline without any database connection.
   * **`GET /api/projects`:** Retrieves project records from the staging database. Requires `.env.local` to be configured and migrations applied. Includes strict error catching to prevent exposing database keys.
