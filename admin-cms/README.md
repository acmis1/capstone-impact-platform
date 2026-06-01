# Capstone Impact Platform: Admin CMS (Staging Foundation)

This is the production-grade **School-owned Admin/CMS Staging Foundation** developed in Next.js, TypeScript, and Supabase. It implements the core ingestion, schema-validation, and feed compilation algorithms for Part 2 of the Capstone project.

---

## 🛡️ Staging Isolation & Safety Rules

1.  **Strict Isolation from Prototype**: This workspace is located inside `/admin-cms` and is completely separate from the original `/Prototype` directory, preserving all initial demo logs and mock parameters.
2.  **Staging-Only Database & Storage**: This foundation uses a newly created, isolated Supabase free-tier staging project (`capstone-impact-staging`) instead of the previous demo project.
3.  **Duda Isolation**: The live showcase layer is *not* connected to the new staging buckets during this validation phase to prevent any visual disruptions on stakeholder-facing pages.
4.  **No Secrets in Git**: Secret values, database passwords, and administrative keys must never be committed. `.env` and `.env.local` files are strictly git-ignored.
5.  **Staging Data Restriction**: In accordance with university privacy rules, no active student records or coordinator email listings may be uploaded. Staging testing operates exclusively on fake generated mock fixtures.

---

## ⚙️ Configuration & Setup Steps

### Step 1: Environment Configuration
Copy the staging environment template to a local ignored configuration file:
```bash
cp .env.example .env.local
```

Open `.env.local` and populate the keys for your isolated Supabase staging project:
*   `NEXT_PUBLIC_SUPABASE_URL`: Your Supabase project URL (e.g. `https://xyz.supabase.co`)
*   `NEXT_PUBLIC_SUPABASE_ANON_KEY`: Client-safe anonymous key.
*   `SUPABASE_SERVICE_ROLE_KEY`: Server-only administrative key (bypasses RLS). **Never expose to client-side scripts.**
*   `GEMINI_API_KEY`: Google Gemini API key (Optional; keep `GEMINI_ASSISTIVE_EXTRACTION_ENABLED=false` to skip).

---

## 🏃 Available Scripts

Run these scripts inside the `admin-cms/` directory to validate the staging baseline:

### 1. Perform TypeScript Compile Checks
Checks code structure, type annotations, and import aliases without outputting build files:
```bash
npm run typecheck
```

### 2. Verify Approved-Only Public Feed Compiler
Runs the core compile and validate pipeline locally against mock fixtures, outputting audit metrics and validating schema structures:
```bash
npm run check:sample-feed
```

### 3. Build Staging Assets
Compiles the application to production bundle structures:
```bash
npm run build
```

---

## 📂 Codebase Architecture

The staging foundation is structured as follows:
*   `src/app/` — App Router landing pages and administrative status dashboards.
*   `src/domain/` — Relational domain models mapping Projects, MediaAssets, and WorkflowStates cleanly to eradicate unstructured JSON blobs.
*   `src/lib/env.ts` — Runtime environment validation powered by `zod`.
*   `src/lib/supabase/` — Safe client and secure administrative server-side connection wrappers.
*   `src/lib/gemini/` — Assistive metadata extraction adapter (disabled by default).
*   `src/feed/` — Approved-only public JSON feed compilers and schemaallow-list contract validators.
*   `src/validation/` — Rules-first metadata review and approval validation engines.
*   `src/storage/` — Documented operational storage guidelines and access policies.
*   `src/fixtures/` — Fictional mock dataset records representing diverse publication states.
*   `src/scripts/` — Offline validation script executing compilation checks on startup.
