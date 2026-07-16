# Prototype Supabase Backend Reconstruction & Recovery Runbook

This runbook outlines the safe, step-by-step procedure to reconstruct and seed the deleted Prototype Supabase backend database, storage buckets, and external endpoints.

---

## ⚠️ Critical Project Identity Boundaries

This repository interacts with multiple environments. Ensure you do not confuse them:
1.  **`capstone-impact-staging` (Isolated Admin Staging)**: **DO NOT MODIFY**. This is the operational staging database for the Next.js Admin/CMS. Do not apply migrations, run scripts, or alter users in this database.
2.  **`capstone-prototype-recovery-2026` (Prototype Recovery Backend)**: **TARGET DATABASE**. This is the replacement project to be manually created in the Supabase Dashboard to host the reconstructed `/Prototype` backend.
3.  **Deleted Project (Obsolete Backend)**: The original project used by `/Prototype` has been deleted and is completely unreachable.

---

## Phase 1: Manual Supabase Project Re-creation

1.  Log in to the **Supabase Dashboard**.
2.  Click **New Project** and select your organization.
3.  Set the project name exactly to:
    ```text
    capstone-prototype-recovery-2026
    ```
4.  Configure a secure database password. Store it privately in a password manager.
5.  Wait for project provisioning to complete.

---

## Phase 2: Schema Reconstruction

1.  In your new project Dashboard, navigate to the **SQL Editor** from the left panel.
2.  Click **New query**.
3.  Paste the following schema definition script to create the required tables and public select policies:
    ```sql
    -- Create the projects metadata table
    CREATE TABLE public.projects (
        id bigint PRIMARY KEY,
        data jsonb NOT NULL,
        updated_at timestamptz DEFAULT now()
    );

    -- Enable Row Level Security (RLS)
    ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

    -- Enable select access for anonymous/public visitors
    CREATE POLICY "Enable select access for all users" 
    ON public.projects FOR SELECT 
    USING (true);
    ```
4.  Click **Run** and verify success.

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
SUPABASE_URL=https://<NEW_PROJECT_REF>.supabase.co
# Primary secret server-key
SUPABASE_SECRET_KEY=<NEW_SECRET_ROLE_KEY>
# Legacy service-role key fallback (optional)
SUPABASE_SERVICE_ROLE_KEY=<NEW_SERVICE_ROLE_KEY>

# Safety Check - Enforces target protection check
SUPABASE_EXPECTED_PROJECT_REF=capstone-prototype-recovery-2026

SUPABASE_FEED_BUCKET=feeds
SUPABASE_FEED_FILE=capstones-latest.json
SUPABASE_ASSET_BUCKET=project-assets
```

> [!IMPORTANT]
> **Secret Key Policy**: Never check in the `.env` file, print raw key contents in console logs, or expose keys to React/Vite client-side code.

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
*   Obsolescence domains matched.
*   Asset list aggregated.
*   Readiness: `PASSED`

---

## Phase 6: Guarded Seeding and Apply

*This operation makes write calls and must only be run once local configurations are verified.*

Execute the seeding and storage upload task:
```bash
npm run recovery:apply
```

### Safety Stop Conditions during execution:
*   The script will abort immediately if the project reference subdomain in `SUPABASE_URL` does not match `SUPABASE_EXPECTED_PROJECT_REF`.
*   The script will abort if the remote `projects` table contains unexpected IDs not matching local seed files.
*   The script will abort if existing project records contain conflicting data.

---

## Phase 7: External Integration Updates

1.  **Duda Integration**:
    *   Retrieve the new public URL of the feed file from the `feeds` bucket:
        `https://<NEW_PROJECT_REF>.supabase.co/storage/v1/object/public/feeds/capstones-latest.json`
    *   Update the Duda HTML widget script with this new feed address.
2.  **Render Deployment**:
    *   Update the Render service environment settings with the new `SUPABASE_URL` and `SUPABASE_SECRET_KEY` credentials.
