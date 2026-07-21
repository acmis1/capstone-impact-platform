# Manual Supabase Migration Application Guide

Follow these step-by-step instructions to set up the staging database schema on your newly created `capstone-admin-cms-staging-2026` Supabase project.

## ⚠️ Pre-Flight Safety Checks & Critical Warnings

> [!WARNING]
> **DO NOT USE OLD SCRIPT VERSION:** If you copied the database SQL before the June 1st schema correction (which lacked audit trail logs, extended import ingestion fields, and strict RLS definitions), **DO NOT apply it**. Delete any active queries and copy only this corrected version.

> [!IMPORTANT]
> * **Check Project Name:** Ensure you are logged into the Supabase Dashboard and have selected the `capstone-admin-cms-staging-2026` project.
> * **DO NOT run these scripts against the old demo project.**
> * **DO NOT run these scripts against the Prototype recovery project.** No migration or database commands should ever target the Prototype recovery project.
> * **DO NOT connect Duda to this database yet.**
> * **Storage Provisioning Is a Separate Task:** Do not create or configure
>   Storage buckets during this migration application task. After migrations
>   0001 through 0004 have been applied and verified read-only, provision and
>   verify the following buckets through a separately approved Storage task:
>
>   - `project-drafts-private` — private draft uploads
>   - `project-public-assets` — approved public images and downloadable PDFs
>   - `public-feeds` — approved public JSON feed files
>
>   No media upload, seed, or feed publication may occur before that separate
>   Storage setup and policy verification is complete.

> [!CAUTION]
> * **Destructive Operations Warning:** Reset, teardown, and destructive SQL (Option A and Option B below) require separate, explicit approval and are not part of the normal staging migration flow.

> [!NOTE]
> **Current Environment & Staging Status:**
> In the present staging environment (`capstone-admin-cms-staging-2026` located in Singapore):
> - migrations 0001 through 0006 have already been manually applied and read-only verified;
> - the three Storage buckets (`project-drafts-private`, `project-public-assets`, `public-feeds`) have already been provisioned and verified;
> - initial administrator bootstrap linkage has been completed through the guarded CLI script (`CREATED`);
> - dashboard login and session logout were manually verified in Microsoft Edge;
> - do not rerun migrations or identity provisioning merely because this guide exists;
> - reset, teardown, and destructive SQL require separate explicit approval.

---

## Step-by-Step Setup

The migrations must be applied in the exact order below:

1. `0001_staging_schema.sql`
2. `0002_staging_rls_policies.sql`
3. `0003_admin_auth_identity.sql`
4. `0004_explicit_data_api_grants.sql`
5. `0005_initial_admin_bootstrap.sql`
6. `0006_fix_initial_admin_bootstrap_runtime.sql`
7. Read-only verification before any seed or identity provisioning

---

### Step 1: Execute Staging Schema (0001)
1. In the Supabase Dashboard, navigate to the **SQL Editor** from the left navigation panel.
2. Click **New query** (or "+ New Query").
3. Open the file **`migrations/0001_staging_schema.sql`** in your editor and copy its entire contents.
4. Paste the SQL query into the Supabase SQL Editor workspace.
5. Click the **Run** button.
6. Ensure the query completes successfully.

### Step 2: Execute RLS Policies (0002)
1. Click **New query** to open a clean editor workspace.
2. Open the file **`migrations/0002_staging_rls_policies.sql`** and copy its entire contents.
3. Paste the SQL query into the Supabase SQL Editor.
4. Click **Run**.
5. Ensure the query completes successfully.

### Step 3: Execute Admin Auth Identity Link (0003)
1. Click **New query** to open a clean editor workspace.
2. Open the file **`migrations/0003_admin_auth_identity.sql`** and copy its content.
3. Paste it into the SQL Editor and click **Run**.
4. This adds the `auth_user_id` column to the `admin_users` table to link identity credentials.

### Step 4: Execute Explicit Data API Grants (0004)
1. Click **New query** to open a clean editor workspace.
2. Open the file **`migrations/0004_explicit_data_api_grants.sql`** and copy its content.
3. Paste it into the SQL Editor and click **Run**.
4. This establishes explicit least-privilege Data API grants:
   * **Grants vs RLS:** Postgres grants control whether a role has basic permission to reach a table/object. RLS controls row-level permissions once access is authorized.
   * **anon:** Receives no privileges on any Admin/CMS table.
   * **authenticated:** Receives read-only (`SELECT` only) privileges on the three lookup tables (`programs`, `disciplines`, `industry_categories`).
   * **service_role:** Receives full administrative CRUD (`SELECT`, `INSERT`, `UPDATE`, `DELETE`) privileges on all 13 tables. The service-role / secret key must remain strictly server-side.
   * **Future Defaults:** Automatic table exposure on future public-schema objects is disabled. Every future table requires an explicit reviewed grant migration.

### Step 5: Execute Initial Admin Bootstrap (0005)
1. Click **New query** to open a clean editor workspace.
2. Open the file **`migrations/0005_initial_admin_bootstrap.sql`** and copy its content.
3. Paste it into the SQL Editor and click **Run**.
4. This registers the secure, transactional PL/pgSQL function `public.bootstrap_initial_admin(uuid, text, text)` with executable permissions granted strictly to `service_role`.

### Step 6: Execute Corrective Admin Bootstrap Runtime Fix (0006)
1. Click **New query** to open a clean editor workspace.
2. Open the file **`migrations/0006_fix_initial_admin_bootstrap_runtime.sql`** and copy its content.
3. Paste it into the SQL Editor and click **Run**.
4. This replaces `pg_catalog.trim` with PostgreSQL standard `pg_catalog.btrim` as the strongest supported code-level fix for the PL/pgSQL RPC failure.

### Step 7: Sequence Verification
1. **Schema & Permission Verification:** Perform a read-only audit of the database tables, schema privileges, and functions to ensure everything is correct.
2. **Empty Anonymous Storage Responses:** Note that an empty anonymous Storage `.list()` response is inconclusive because RLS may return an empty set rather than a direct authorization error. Do not create or add anonymous Storage list policies.
3. **Storage Architecture Confirmation:** The staging Storage architecture utilizes server-only administrative writes for private drafts, and public approved assets/JSON feeds for retrieval.
4. **Stop:** Do not proceed with any seeds, media uploads, or user creation yet.
5. **Storage Provisioning:** Complete the required Storage provisioning and policy verification through a separate approved Storage task.
6. **Seeds and Identity Provisioning:** Only after Storage provisioning is complete and verified may you run the secure linking script or insert fictional seeds.

---

## Staging Rollback / Reset Instructions

If you need to clean up or re-apply a fresh staging database schema (note that reset, teardown, and destructive SQL require separate explicit approval and are not part of the normal staging migration flow; teardown/reset is not approved by this PR, current staging must not be reset, and migration history must not be destructively replayed without explicit approval):

### Option A: Complete Project Reset
If there is no critical test data:
1. Navigate to **Project Settings** in your Supabase Dashboard.
2. If using Supabase local CLI environment or you wish to start completely fresh, you can reset the database.

### Option B: Manual SQL Table Teardown
Open the **SQL Editor** and run the following script to drop all tables in reverse dependency order:

```sql
DROP TABLE IF EXISTS published_snapshots CASCADE;
DROP TABLE IF EXISTS approval_records CASCADE;
DROP TABLE IF EXISTS validation_flags CASCADE;
DROP TABLE IF EXISTS media_assets CASCADE;
DROP TABLE IF EXISTS project_industry_categories CASCADE;
DROP TABLE IF EXISTS project_disciplines CASCADE;
DROP TABLE IF EXISTS projects CASCADE;
DROP TABLE IF EXISTS import_batches CASCADE;
DROP TABLE IF EXISTS user_roles CASCADE;
DROP TABLE IF EXISTS admin_users CASCADE;
DROP TABLE IF EXISTS industry_categories CASCADE;
DROP TABLE IF EXISTS disciplines CASCADE;
DROP TABLE IF EXISTS programs CASCADE;
```
After a separately approved teardown, apply the complete sequence in order: 0001, 0002, 0003, 0004, 0005, 0006, followed by read-only verification.

---

## Safe Initial Administrator Onboarding Flow

Initial administrator provisioning in a fresh isolated environment must use the guarded initial-bootstrap workflow as documented in:

[./staging-admin-bootstrap.md](./staging-admin-bootstrap.md)

*Note for Current Staging:* Current staging (`capstone-admin-cms-staging-2026`) has already completed its initial administrator bootstrap (`CREATED`). Do not rerun the initial bootstrap to add another person. Provisioning additional university staff remains a separate future workflow.

> [!WARNING]
> * **DO NOT** paste the Auth UUID directly into manual SQL editor queries.
> * **DO NOT** manually insert `admin_users` or `user_roles` records.
> * **DO NOT** send passwords, emails, UUIDs, or tokens to coding agents or chat.
> * **DO NOT** run the linking operation when zero or multiple Auth matches exist.
> * **No automatic Auth-user deletion is allowed.**

Follow this exact safe sequence to provision the initial administrator in a fresh isolated setup:

1. **Complete the secure invitation and password setup:** Follow the two-step flow from the email link to private password setup, routing to `/auth/confirm/accept` and then `/auth/set-password`.
2. **Confirm exactly one Auth user exists:** Verify the user is registered in `auth.users` in Supabase with status verified.
3. **Set temporary local bootstrap variables privately:** Configure your local process environment variables privately (e.g. `CAPSTONE_BOOTSTRAP_ADMIN_EMAIL`, `CAPSTONE_BOOTSTRAP_ADMIN_FULL_NAME`, `CAPSTONE_BOOTSTRAP_CONFIRM`).
4. **Run the linking script once:** Run `npm run link:admin-staging` (or `npm run link:staging-admin` in `apps/admin-cms`).
5. **Clear all temporary variables:** Immediately clear the temporary bootstrap variables from your shell process.
6. **Run the check command:** Run `npm run check:admin-auth`.
7. **Verify readiness status:** Continue only when the checker reports `READY_FOR_MANUAL_LOGIN_TEST`.
8. **Perform the manual login test:** Log in to the Console dashboard at `/login` to confirm the flow is working.
