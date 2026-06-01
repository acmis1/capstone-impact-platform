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
*   `src/import/` — Local metadata package ingestion types, folder parsers, and custom safety rules.
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

---

## 🚀 Staging Seed & Public Feed Publishing

Staging scripts are provided to populate the database with fake cases, audit the workflow records, and publish them to the Supabase storage feed bucket.

### ⚠️ Security & Staging Guidelines
* **Fake Data Only:** These scripts operate exclusively on synthetic staging parameters. Real RMIT stakeholder personal records or student email indexes are strictly prohibited.
* **Credentials Required:** These scripts require `apps/admin-cms/.env.local` to be correctly populated with staging URL and database admin JWT credentials.
* **Duda Showcase Layer Safety:** The public showcase site is **not** connected to this staging feed to guarantee zero disruption to stakeholders during testing.

### 🏃 Command Execution Sequence

#### Option A: Running from the App Workspace Directory
First navigate into the app workspace:
```bash
cd apps/admin-cms
```
Then execute the scripts in the following order:
1. **Seed Fake Staging Projects:** Populates the `projects` table with 4 fake cases (`approved`, `published`, `in_review`, `archived`) and sets up showcase layouts:
   ```bash
   npm run seed:staging
   ```
2. **Check Database Project Statuses:** Queries the database and reports statuses and public showcase eligibility totals:
   ```bash
   npm run check:staging-projects
   ```
3. **Publish Showcase Feed:** Compiles approved/published mock records, runs schema validators, uploads the JSON payload to the `public-feeds` bucket, and logs a database snapshot:
   ```bash
   npm run publish:staging-feed
   ```

#### Option B: Running from the Repository Root (Workspaces)
You can run the identical commands from the repository root:
1. **Seed Projects:** `npm run seed:admin-staging`
2. **Check Statuses:** `npm run check:admin-staging`
3. **Publish Feed:** `npm run publish:admin-feed`

---

## 🖼️ Staging Media Asset Workflow

A secure administrative staging media pipeline is fully integrated to validate, ingest, and promote project showcases:

### ⚙️ How It Works:
1. **Validation Gates:** Media files are validated locally using strict size caps (images max 5MB, PDFs max 20MB) and allowed MIME structures (PNG, JPEG, WEBP, PDF). Path traversals are explicitly blocked.
2. **Private Ingestion:** Unapproved draft assets are written to the private `project-drafts-private` storage bucket. These files are restricted and do not generate public showcase URLs.
3. **Showcase Promotion:** Upon official workflow approval, the backend automatically promotions the media assets from the private bucket to the public `project-public-assets` bucket.
4. **Public Feed URLs:** Public feeds read only the officially approved and promoted showcase media URLs from the public bucket.
5. **Video & Duda Constraints:** Videos are stored purely as external showcase metadata links (no heavy video binaries uploaded to staging). Duda remains disconnected during July/August semester breaks to ensure zero production disruptions.

### 🏃 Running Media Workflows:

#### Option A: Running from the App Workspace Directory
1. **Seed Staging Projects:** `npm run seed:staging`
2. **Seed Staging Media Assets:** Generates mock images/PDF buffers, uploads drafts, promotes them to public, and links URLs back to database:
   ```bash
   npm run seed:staging-media
   ```
3. **Verify Staging Media Database State:** Summarizes media uploads, types, and active bucket targets:
   ```bash
   npm run check:staging-media
   ```
4. **Publish Updated Showcase Feed:** Compiles and publishes the JSON payload with verified media URLs:
   ```bash
   npm run publish:staging-feed
   ```

#### Option B: Running from the Repository Root (Workspaces)
1. **Seed Media:** `npm run seed:admin-media`
2. **Verify Media:** `npm run check:admin-media`

---

## 🔍 Staging Read-Only Project Detail & Review

A detailed, read-only administrative inspection panel is available to review ingested capstone projects, their public media URLs, layout configurations, and staging compliance matrices:

### ⚙️ Features:
* **Interactive List Navigation**: Clicking a project title in the `/admin` dashboard routes directly to the detailed inspect path: `/admin/projects/{publicId}`.
* **Metadata Profile Audit**: Summarizes staging study programs, industry sponsors, academic supervisors, group rosters, and public showcasing states.
* **Storage Media Checks**: Reviews active poster images, PDFs, snapshots, and video links (verifying whether URLs are promoted and healthy).
* **Grid Layout Configurations**: Prints CSS showcase grid template IDs, featured media focal alignments, and active section structures.
* **Diagnostics & Compliance**: Calculates error/warning arrays in real-time, validating missing public descriptors, required assets, and checking template structures against official schemas.
* **No Database State Alteration**: Review activities operate entirely in read-only mode, guaranteeing zero write operations occur during review audits.

---

## ⚡ Controlled Staging Review Actions

Staging dashboard inspection routes fully integrate controlled administrative action triggers. These permit school staff to request changes, approve, or archive ingested capstone showcases:

### ⚙️ How It Works:
1. **Status Transition Logic**: Actions validate state transitions locally:
   * `APPROVE`: Moves `submitted`, `in_review`, or `changes_requested` to `approved`.
   * `REQUEST_CHANGES`: Moves `submitted`, `in_review`, or `approved` back to `changes_requested` for corrections.
   * `ARCHIVE`: Transitions `approved`, `published`, `in_review`, or `changes_requested` projects to `archived`, configuring archival timestamps and setting `pending_removal_from_public = true` to clean public feed indexes.
2. **Dynamic Button Rendering**: The review trigger component renders buttons on-the-fly, displaying transitions matching standard rules.
3. **Database Audit Logging & Integrity**:
   * The current implementation **explicitly blocks success** (returning status 500 / "Audit logging failed") if the audit logging insert to `approval_records` fails, preventing false success reports.
   * **⚠️ Production Requirements**: Before real administrative use, this two-step operation should be replaced by a database-side Postgres RPC function or a transaction-backed server operation to make both the status change and the audit insert completely atomic.
   * **No Real Administrative Use**: No real administrative use or data management should take place until proper authentication, authorization, and atomic audit logging are fully implemented and verified.
4. **Staging Security**: These endpoints operate under mock safety rules. Authentication is simulated, Duda remains isolated, and public feeds are not rebuilt automatically.

---

## 📦 Staging Ingestion Import Package Workflow

A decoupled offline package ingestion pipeline is integrated to parse local packages, validate metadata/assets against schema bounds, track runs inside import batches, and record detailed validation flags:

### ⚙️ How It Works:
1. **Fake Fixture Packages**: Local ingestion reads exclusively from fake staging package structures (e.g. `fixtures/import-packages/runtime-import-demo/`) containing:
   * `project.json` (metadata manifest parameters)
   * `poster.png` (required high-res poster image)
   * `poster.pdf` (required academic poster publication PDF)
   * `snapshot-1.png` (optional recommended snapshot asset)
2. **Metadata & File Parsers**: Resolves and parses manifest JSON parameters and files securely while enforcing strict bounds checks to prevent path traversal attempts.
3. **Staging Validation Gate**:
   * Inspects critical metadata keys (`publicId`, `title`, `summary`, `year`, `program`, `discipline`, `groupName`, `teamMembers`, `layoutConfig`).
   * Validates poster assets and snapshot files against size caps (images max 5MB, PDFs max 20MB) and allowed MIME structures.
   * Generates warning structures on missing recommended values (`accessibilityText`, `posterText`, snapshots).
4. **Ingestion & Tracking**:
   * Registers a single processing row inside `import_batches` to log folder source tracks, error counts, and warnings.
   * Upserts the project into the `projects` table mapping statuses directly to `in_review`.
   * Uploads provided files as **draft private media** using `uploadDraftMediaAsset` (saving objects in private storage buckets).
   * **No Public Promotion**: Assets are *not* promoted to public buckets, keeping them isolated.
   * Writes detailed warnings and errors to the `validation_flags` table mapping properties back to the project ID.
   * Marks the import batch status as `completed`.

### 🏃 Running Package Imports:

#### Option A: Running from the App Workspace Directory
1. **Import Staging Package**:
   ```bash
   npm run import:staging-package
   ```
2. **Check Import Batches**: Logs total and recent ingestion run audits:
   ```bash
   npm run check:import-batches
   ```

#### Option B: Running from the Repository Root (Workspaces)
1. **Import Package**: `npm run import:admin-package`
2. **Check Import Batches**: `npm run check:admin-imports`




