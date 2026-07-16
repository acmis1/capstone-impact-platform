# Manual Supabase Migration Application Guide

Follow these step-by-step instructions to set up the staging database schema on your newly created `capstone-impact-staging` Supabase project.

## ⚠️ Pre-Flight Safety Checks & Critical Warnings

> [!WARNING]
> **DO NOT USE OLD SCRIPT VERSION:** If you copied the database SQL before the June 1st schema correction (which lacked audit trail logs, extended import ingestion fields, and strict RLS definitions), **DO NOT apply it**. Delete any active queries and copy only this corrected version.

> [!IMPORTANT]
> * **Check Project Name:** Ensure you are logged into the Supabase Dashboard and have selected the `capstone-impact-staging` project.
> * **DO NOT run these scripts against the old demo project.**
> * **DO NOT connect Duda to this database yet.**
> * **Verify Buckets:** Confirm that the following storage buckets have been created in your staging project:
>   * `project-drafts-private` (Private bucket)
>   * `project-public-assets` (Public bucket)
>   * `public-feeds` (Public bucket)

> [!NOTE]
> **Staging Environment Expectations & Idempotency:**
> * These migration scripts are designed primarily for a **clean staging project**.
> * We have added re-run safety clauses (`DROP TRIGGER IF EXISTS` and `DROP POLICY IF EXISTS`) to allow re-running these scripts.
> * However, if a partial migration fails midway due to a schema conflict or manual database change, the safest option during this break/staging phase is to **reset the staging database** via the Supabase Dashboard, or execute the manual SQL table teardown script provided at the bottom of this guide.

---

## Step-by-Step Setup

### 1. Execute Staging Schema
1. In the Supabase Dashboard, navigate to the **SQL Editor** from the left navigation panel.
2. Click **New query** (or "+ New Query").
3. Open the file **`migrations/0001_staging_schema.sql`** in your editor and copy its entire contents.
4. Paste the SQL query into the Supabase SQL Editor workspace.
5. Click the **Run** button (or press `Ctrl + Enter` / `Cmd + Enter`).
6. Ensure the query completes successfully with a `Success` message.

### 2. Execute RLS Policies
1. Click **New query** to open a clean editor workspace.
2. Open the file **`migrations/0002_staging_rls_policies.sql`** in your editor and copy its entire contents.
3. Paste the SQL query into the Supabase SQL Editor.
4. Click **Run**.
5. Ensure the query completes successfully.

### 3. Verification
1. Navigate to the **Database** section (table icon) in the left panel.
2. Under the **Table Editor**, confirm that the following tables exist:
   * `programs`
   * `disciplines`
   * `industry_categories`
   * `admin_users`
   * `user_roles`
   * `import_batches`
   * `projects`
   * `project_disciplines`
   * `project_industry_categories`
   * `media_assets`
   * `validation_flags`
   * `approval_records`
   * `published_snapshots`
3. Click on the settings/options of any table and verify that **Row-Level Security (RLS) is Enabled** (indicated by an "RLS Enabled" badge or shield icon).

---

## Staging Rollback / Reset Instructions

If you need to clean up or re-apply a fresh staging database schema:

### Option A: Complete Project Reset (Recommended for clean environment)
If there is no critical test data:
1. Navigate to **Project Settings** > **API** or **Database**.
2. If using Supabase local CLI environment or you wish to start completely fresh, you can reset the database. Otherwise, use Option B.

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
After executing the teardown, repeat Steps 1 & 2 to apply the schema clean.

---

## 🔐 Step 3: Execute Admin Auth Identity Link (Migration 0003)

1. Open the SQL Editor in your Supabase Dashboard.
2. Open the file **`migrations/0003_admin_auth_identity.sql`** and copy its content.
3. Paste it into the SQL Editor and click **Run**.
4. This adds the `auth_user_id` column to the `admin_users` table to link identity credentials.

---

## Administrative User Provisioning in Staging

Staging operates on manually provisioned admins using Supabase Auth. Since there is no public self-registration form, follow these steps to add a staging administrator:

### 1. Create the Auth User in Supabase Dashboard
1. In your Supabase Dashboard, navigate to **Authentication** > **Users** in the left sidebar.
2. Click **Add User** > **Create User**.
3. Fill in the canonical fictional email address `auth-test-admin@example.com` and a secure password.
4. Set **Auto-confirm User?** to `true` (checked) so no email confirmation is sent.
5. Click **Create User**.

### 2. Retrieve the User UUID
1. Locate the newly created user in the **Authentication** > **Users** list.
2. Copy the UUID value displayed in the **User UID** / **ID** column (represented as `<AUTH_USER_UUID>` in script templates).

### 3. Provision the Admin CMS Role in SQL Editor
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

