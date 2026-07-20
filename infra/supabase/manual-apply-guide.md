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
> **Staging Environment Expectations & Idempotency:**
> * These migration scripts are designed primarily for a **clean staging project**.
> * We have added re-run safety clauses (`DROP TRIGGER IF EXISTS` and `DROP POLICY IF EXISTS`) to allow re-running these scripts.
> * However, if a partial migration fails midway due to a schema conflict or manual database change, the safest option during this break/staging phase is to **reset the staging database** via the Supabase Dashboard, or execute the manual SQL table teardown script. Note that any reset or teardown requires separate explicit approval.

---

## Step-by-Step Setup

The migrations must be applied in the exact order below:

1. `0001_staging_schema.sql`
2. `0002_staging_rls_policies.sql`
3. `0003_admin_auth_identity.sql`
4. `0004_explicit_data_api_grants.sql`
5. `0005_initial_admin_bootstrap.sql`
6. Read-only verification before any seed or identity provisioning

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

### Step 6: Sequence Verification
1. **Schema & Permission Verification:** Perform a read-only audit of the database tables, schema privileges, and functions to ensure everything is correct.
2. **Empty Anonymous Storage Responses:** Note that an empty anonymous Storage `.list()` response is inconclusive because RLS may return an empty set rather than a direct authorization error. Do not create or add anonymous Storage list policies.
3. **Storage Architecture Confirmation:** The staging Storage architecture utilizes server-only administrative writes for private drafts, and public approved assets/JSON feeds for retrieval.
4. **Stop:** Do not proceed with any seeds, media uploads, or user creation yet.
5. **Storage Provisioning:** Complete the required Storage provisioning and policy verification through a separate approved Storage task.
6. **Seeds and Identity Provisioning:** Only after Storage provisioning is complete and verified may you run the secure linking script or insert fictional seeds.

---

## Staging Rollback / Reset Instructions

If you need to clean up or re-apply a fresh staging database schema (note that reset, teardown, and destructive SQL require separate explicit approval and are not part of the normal staging migration flow):

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
After executing the teardown, repeat Steps 1 through 4 to apply the schema clean.

---

## Administrative User Provisioning in Staging

Staging operates on administrators invited through Supabase Auth. Since self-registration is disabled, you must configure the invitation flow, accept the invitation, set the password, and then link the user.

### 1. Configure and Complete the Invitation Flow
Follow the detailed instructions in [auth-invitation-setup.md](./auth-invitation-setup.md) to:
1. Configure Site URL and Allowed Redirect URLs.
2. Update the Invite User email template.
3. Send exactly one new invitation from the Supabase Authentication dashboard.
4. Complete the invitation acceptance, OTP verification, and private password setup.
5. Confirm the user exists in `auth.users` with status verified.

### 2. Retrieve the User Details
Locate the user's email address and full name to prepare for the safe administrator linking script. Invitation acceptance must be completed before administrator linking.

### 3. Provision the Admin CMS Role via the Bootstrap Script
> [!WARNING]
> This script is staging-only and must never be executed on production.
> Before running, confirm that the active database connection is exactly the isolated staging database.
> If any safety exception is raised, stop execution immediately and verify the current database state.

Open the **SQL Editor** and execute the following query to link the Auth user to the administrative schema (replace the placeholder `<AUTH_USER_UUID>` with your generated staging UID):

```sql
DO $$
DECLARE
    v_auth_uuid UUID := '<AUTH_USER_UUID>'::UUID;
    v_email VARCHAR := 'auth-test-admin@example.com';
    v_full_name VARCHAR := 'Staging Auth Test Administrator';
    
    v_auth_exists BOOLEAN;
    v_auth_email VARCHAR;
    v_admin_id UUID;
    v_existing_linked_email VARCHAR;
    v_existing_admin_linked_uuid UUID;
    v_admin_count INT;
BEGIN
    -- 1. Verify that an Auth user exists in auth.users with the supplied UUID
    SELECT EXISTS (SELECT 1 FROM auth.users WHERE id = v_auth_uuid) INTO v_auth_exists;
    IF NOT v_auth_exists THEN
        RAISE EXCEPTION 'AUTH_USER_NOT_FOUND';
    END IF;

    -- 2. Verify that the Auth user's email matches the canonical email
    SELECT email INTO v_auth_email FROM auth.users WHERE id = v_auth_uuid;
    IF v_auth_email IS DISTINCT FROM v_email THEN
        RAISE EXCEPTION 'AUTH_EMAIL_MISMATCH';
    END IF;

    -- 3. Check if another admin_users row is already linked to the supplied UUID
    SELECT email INTO v_existing_linked_email FROM admin_users WHERE auth_user_id = v_auth_uuid AND email IS DISTINCT FROM v_email;
    IF v_existing_linked_email IS NOT NULL THEN
        RAISE EXCEPTION 'AUTH_IDENTITY_ALREADY_LINKED';
    END IF;

    -- 4. Check if the canonical admin_users row is already linked to a different UUID
    SELECT auth_user_id INTO v_existing_admin_linked_uuid FROM admin_users WHERE email = v_email;
    IF v_existing_admin_linked_uuid IS NOT NULL AND v_existing_admin_linked_uuid IS DISTINCT FROM v_auth_uuid THEN
        RAISE EXCEPTION 'CANONICAL_PROFILE_LINK_CONFLICT';
    END IF;

    -- 5. Check if more than one matching administrator row is found for this email
    SELECT COUNT(*) INTO v_admin_count FROM admin_users WHERE email = v_email;
    IF v_admin_count > 1 THEN
        RAISE EXCEPTION 'MULTIPLE_CANONICAL_ADMIN_ROWS';
    END IF;

    -- 6. Create or retrieve the canonical admin_users profile
    IF v_admin_count = 0 THEN
        INSERT INTO admin_users (email, full_name, auth_user_id)
        VALUES (v_email, v_full_name, v_auth_uuid)
        RETURNING id INTO v_admin_id;
    ELSE
        SELECT id INTO v_admin_id FROM admin_users WHERE email = v_email;
        
        -- Update the profile linkage and full name safely
        UPDATE admin_users
        SET auth_user_id = v_auth_uuid,
            full_name = v_full_name
        WHERE id = v_admin_id;
    END IF;

    -- 7. Assign the admin role idempotently
    INSERT INTO user_roles (user_id, role)
    VALUES (v_admin_id, 'admin')
    ON CONFLICT (user_id, role) DO NOTHING;

    RAISE NOTICE 'STAGING_ADMIN_PROVISIONED';
END $$;
```

