# Prototype Supabase Backend Reconstruction & Recovery Runbook

This runbook outlines the safe, step-by-step procedure to reconstruct and seed the database and storage feed for the Prototype backend.

---

## ⚠️ Critical Project Identity Boundaries

This repository interacts with multiple environments. Ensure you do not confuse them:
1.  **`capstone-impact-staging` (Isolated Admin Staging)**: **DO NOT MODIFY**. This is the operational staging database for the Next.js Admin/CMS. Do not apply migrations, run scripts, or alter users in this database.
2.  **`capstone-prototype-recovery-2026` (Prototype Recovery Backend)**: **TARGET HUMAN-READABLE NAME**. This is the name of the replacement project to be manually created in the Supabase Dashboard. Note that this name is different from the generated project reference subdomain.
3.  **Deleted Prototype Project**: The original backend project has been deleted and is completely unreachable. Do not attempt to query or restore it.

---

## Phase 1: Manual Supabase Project Re-creation

1.  Log in to the **Supabase Dashboard**.
2.  Click **New Project** and select your organization.
3.  Set the project name to:
    ```text
    capstone-prototype-recovery-2026
    ```
4.  Configure a secure database password. Store it privately in a password manager.
5.  Wait for project provisioning to complete.

---

## Phase 2: Schema Reconstruction

1.  In your new project Dashboard, navigate to the **SQL Editor** from the left panel.
2.  Click **New query**.
3.  Paste the following schema definition script to create the table and configure permissions:
    ```sql
    BEGIN;

    CREATE TABLE IF NOT EXISTS public.projects (
        id BIGINT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

    -- Revoke all default public privileges on the projects table
    REVOKE ALL ON TABLE public.projects FROM anon;
    REVOKE ALL ON TABLE public.projects FROM authenticated;

    -- Grant full database permissions only to the service_role key
    GRANT ALL ON TABLE public.projects TO service_role;

    COMMIT;
    ```
4.  Click **Run** and verify success.

> [!NOTE]
> **Database Visibility Guard**: The Prototype server reads and writes data using the server-only privileged secret key. The Duda widget accesses the compiled JSON public file directly from Storage. Because Duda never queries the `projects` table directly, the database table remains completely inaccessible to anonymous/authenticated browser roles. Do not create any public SELECT policy.

---

## Phase 3: Storage Bucket Setup

1.  Navigate to **Storage** from the left panel.
2.  Click **New bucket** to create the public feed distribution bucket:
    *   Name: `feeds`
    *   Visibility: **Public** (check the "Public bucket" switch)
3.  Click **New bucket** to create the media asset bucket:
    *   Name: `project-assets`
    *   Visibility: **Public** (check the "Public bucket" switch)

---

## Phase 4: Local Configuration Update

Update `Prototype/.env` with the credentials of your newly created recovery project:
```env
SUPABASE_URL=<NEW_PROJECT_URL>
# Primary server secret key
SUPABASE_SECRET_KEY=<NEW_SERVER_SECRET_KEY>
SUPABASE_SERVICE_ROLE_KEY=

# safety Check - Unique generated project reference subdomain
# (NOT the human-readable project name. Extract it from your URL: https://<REF>.supabase.co)
SUPABASE_EXPECTED_PROJECT_REF=<GENERATED_PROJECT_REFERENCE>

SUPABASE_FEED_BUCKET=feeds
SUPABASE_FEED_FILE=capstones-latest.json
SUPABASE_ASSET_BUCKET=project-assets
ADMIN_ACCESS_KEY=<NEW_RANDOM_ADMIN_ACCESS_KEY>
```

---

## Phase 5: Recovery Dry-Run Execution

Before performing any database writes, run the offline verification checker from the `/Prototype` directory:
```bash
cd Prototype
npm run recovery:dry-run
```
**Expected Verification Metrics**:
*   Seed Database count: `10`
*   Public Feed count: `6`
*   Obsolete domain references matched.
*   Asset list aggregated.
*   Readiness: `PASSED`

---

## Phase 6: Guarded Seeding and Apply

*This operation makes write calls and must only be run once local configurations are verified.*

Execute the seeding and storage upload task:
```bash
npm run recovery:apply
```

### Safety Stop Conditions (Abort immediately if any occur):
1.  **Staging Target Protection**: Any request/URL pointing to or matching `capstone-impact-staging` is blocked.
2.  **Generated Reference Mismatch**: If the reference derived from `SUPABASE_URL` does not match `SUPABASE_EXPECTED_PROJECT_REF` exactly.
3.  **Mismatched Project Name**: If the human-readable project name is incorrectly supplied as the reference key.
4.  **Database Non-empty with Conflicts**: If the remote `projects` table contains unexpected IDs or conflicting data.
5.  **Existing Conflicting Feed**: If the `feeds/capstones-latest.json` file exists on storage but its canonical data differs from the local feed.
6.  **Missing Buckets**: If the required buckets are missing.
7.  **Secrets Exposure**: If any raw credentials or keys are outputted in logs.
8.  **Asset Seeding Attempt**: The `recovery:apply` script does not upload assets to `project-assets`. Media restoration requires a separate reviewed manifest and controlled task. Do not force writes to `project-assets`.
