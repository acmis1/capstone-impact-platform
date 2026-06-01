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

---

## Step-by-Step Setup

### 1. Execute Staging Schema
1. In the Supabase Dashboard, navigate to the **SQL Editor** from the left navigation panel.
2. Click **New query** (or "+ New Query").
3. Open the file [0001_staging_schema.sql](file:///d:/IT%20RMIT/Capstone/admin-cms/supabase/migrations/0001_staging_schema.sql) in your editor and copy its entire contents.
4. Paste the SQL query into the Supabase SQL Editor workspace.
5. Click the **Run** button (or press `Ctrl + Enter` / `Cmd + Enter`).
6. Ensure the query completes successfully with a `Success` message.

### 2. Execute RLS Policies
1. Click **New query** to open a clean editor workspace.
2. Open the file [0002_staging_rls_policies.sql](file:///d:/IT%20RMIT/Capstone/admin-cms/supabase/migrations/0002_staging_rls_policies.sql) in your editor and copy its entire contents.
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
