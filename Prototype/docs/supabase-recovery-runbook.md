# Prototype Supabase Backend Reconstruction & Recovery Runbook

This runbook outlines the safe, step-by-step procedure to reconstruct and seed the database and storage feed for the Prototype backend.

---

## ⚠️ Critical Project Identity Boundaries

This repository interacts with multiple environments. Ensure you do not confuse them:
1.  **`capstone-impact-staging` (Surviving Old Demo Project)**: **DO NOT MODIFY**. This is the surviving old demo/staging project. It is NOT the recovery target. Its exact historical role is not relied upon by the recovery safeguards, but it must remain completely untouched.
2.  **Deleted Prototype Backend**: The original backend project previously used by `/Prototype` no longer exists. Its generated reference (`xojnnhilqaldxoilmxli`) remains blocked internally as a denied constant.
3.  **`capstone-prototype-recovery-2026` (Proposed Reconstruction Target)**: This is the proposed human-readable name of the future replacement project. It is not yet created, and is different from its generated project reference subdomain.

### Safeguard Operations Wording
*   **Allowlisting**: Code-level safeguards enforce protection based on exact generated-reference allowlisting of the expected reference.
*   **Denylisting**: The deleted reference is separately denied by comparing the derived ref.
*   **Manual Verification**: The code cannot determine or block a human-readable Dashboard project name from a URL directly. The operator must manually confirm the Dashboard project name is correct before configuring its generated reference in the environment settings.
*   **Apply Blocks**: The `recovery:apply` script cannot run while obsolete domain references remain inside the local files (`db.json` or `capstones-latest.json`).

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
2.  Create the public feed distribution bucket with the exact canonical name:
    *   Name: `feeds`
    *   Visibility: **Public** (check the "Public bucket" switch)
3.  Create the media asset bucket with the exact canonical name:
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

# Safety Check - Unique generated project reference subdomain
# (NOT the human-readable project name. Extract it from your URL: https://<REF>.supabase.co)
SUPABASE_EXPECTED_PROJECT_REF=<GENERATED_PROJECT_REFERENCE>

# Canonical targets (alternative names are rejected by the recovery system)
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

## Phase 6: Recovery Execution Sequence

The complete manual/automated recovery sequence is:
1.  Merge reviewed recovery foundation files to the main branch.
2.  Create the replacement Supabase project manually in the Dashboard.
3.  Execute Phase 2 (SQL Schema and RLS).
4.  Execute Phase 3 (Create buckets `feeds` and `project-assets` with Public visibility).
5.  Prepare a separately reviewed URL/media rewrite manifest.
6.  Generate sanitized recovery copies of `db.json` and `capstones-latest.json` (replacing obsolete domains).
7.  Confirm that the obsolete-reference count reports exactly zero.
8.  Run the offline `npm run recovery:dry-run` script to check readiness.
9.  Run `npm run recovery:apply` to perform Storage and Database preflight check.
10. Seeding database project records occurs automatically inside the apply task.
11. Public feed restoration files (`capstones-latest.json`) are compiled and uploaded automatically.
12. Restore static project media assets to `project-assets` bucket in a separate reviewed manifest and controlled task.
13. Update Render environment variables with the new `SUPABASE_URL` and `SUPABASE_SECRET_KEY`.
14. Update the Duda layout HTML widget code block with the new feed file URL.
15. Perform automated and browser regression tests on the staging prototype.
