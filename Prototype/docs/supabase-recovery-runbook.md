# Prototype Supabase Backend Reconstruction & Recovery Runbook

This runbook outlines the step-by-step procedure to reconstruct and seed the database and storage feed for the Prototype backend, and documents the completed recovery state.

---

## Current Recovery Status

The recovery of the Prototype Supabase backend is complete.
*   **Project Identity**: The project `capstone-prototype-recovery-2026` is the active replacement Prototype recovery project.
*   **Database Schema**: The `public.projects` table and server-only RLS restrictions were successfully configured (no anonymous SELECT policies exist).
*   **Storage Buckets**: The `feeds` and `project-assets` buckets were created.
*   **Recovery Execution**: The controlled recovery apply completed successfully once.
*   **Database Seeding**: `public.projects` contains exactly 10 project records.
*   **Showcase Feed**: `feeds/capstones-latest.json` contains exactly 6 public project records.
*   **Sanitization**: Obsolete deleted-project references (such as `xojnnhilqaldxoilmxli`) in the local seed and feed are `0`.
*   **Feed Integrity**: The public feed was created without overwriting existing files (`upsert: false`).
*   **Asset & Poster Status**: All 10 current project poster URLs were separately verified as healthy. Current poster files are served through the separate `capstone-impact-demo-assets` repository.
*   **Storage Integrity**: The Supabase `project-assets` bucket remained untouched during poster repair. No poster files were uploaded to the Supabase storage bucket.

> [!WARNING]
> The recovery is complete. Do not run `npm run recovery:apply` again against the current recovery project. It may only be considered during a separately approved recovery or clean-rebuild incident after remote-state auditing.

---

## ⚠️ Critical Project Identity Boundaries

This repository interacts with multiple environments. Ensure you do not confuse them:
1.  **`capstone-impact-staging` (Surviving Old Demo Project)**: **DO NOT MODIFY**. This is the surviving old demo/staging project. It is NOT the recovery target. Its exact historical role is not relied upon by the recovery safeguards, but it must remain completely untouched.
2.  **Deleted Prototype Backend**: The original backend project previously used by `/Prototype` no longer exists. Its generated reference (`xojnnhilqaldxoilmxli`) remains blocked internally as a denied constant.
3.  **Active Replacement**: The `capstone-prototype-recovery-2026` project is the active replacement Prototype recovery project.

### Safeguard Operations Wording
*   **Allowlisting**: Code-level safeguards enforce protection based on exact generated-reference allowlisting of the expected reference.
*   **Denylisting**: The deleted reference is separately denied by comparing the derived ref.
*   **Manual Verification**: The code cannot determine or block a human-readable Dashboard project name from a URL directly. The operator must manually confirm the Dashboard project name is correct before configuring its generated reference in the environment settings.
*   **Apply Blocks**: The `recovery:apply` script cannot run while obsolete domain references remain inside the local files (`db.json` or `capstones-latest.json`).

---

## Validated Feed Snapshot

To guarantee data integrity and guard against race conditions or mid-flight filesystem changes, the recovery runner utilizes a single-pass validated snapshot pattern:

1.  The `main()` entrypoint reads the local public-feed file once.
2.  `runRecovery` captures the supplied feed content immediately on invocation.
3.  The runner parses and validates the captured feed structure.
4.  An immutable `Buffer` snapshot is constructed directly from the same validated source string.
5.  A canonical equality check compares the `Buffer` contents against the validated feed array to verify zero payload alteration before any client creation occurs.
6.  The same immutable `Buffer` is used for the Storage upload phase.
7.  The feed file is not read again after recovery operations begin.
8.  The Storage upload uses:
    *   `contentType: 'application/json'`
    *   `upsert: false` (to prevent overwriting existing feeds).
9.  The remote object is downloaded and verified canonically after creation.

---

## Environment Configuration Loader

To manage configuration securely, the recovery CLI uses a dedicated environment configuration loader:

*   **Explicit Loading**: `Prototype/.env` is loaded explicitly by the recovery CLI entrypoint (`main()`) before configurations are read.
*   **Quiet Mode**: Dotenv runs with quiet mode enabled, preventing it from printing injection or diagnostic messages to console output.
*   **No Override**: Override is disabled (`override: false`), ensuring that operating-system level environment variables always take precedence.
*   **Import Isolation**: Importing the recovery runner or utility modules (e.g. for testing purposes) does not load the environment file automatically.
*   **Test Isolation**: Unit tests utilize an isolated target environment (`targetEnv`) and never read the real `Prototype/.env` file.
*   **Optional for Dry-Runs**: The `recovery:dry-run` task works completely offline even when `Prototype/.env` is absent or empty.
*   **Required for Apply**: Executing `recovery:apply` requires the target Supabase URL, generated reference subdomain allowlist, and server key to be available through the loaded private environment.
*   **Credential Masking**: No credential or secret configuration value is ever printed, returned, or logged.
*   **Git-Ignored Security**: The configuration file `Prototype/.env` remains Git-ignored.

---

## Resumability and Partial Failure

The recovery runner is built to support resumability and handles failures safely without requiring data rollbacks:

*   **Idempotence**: The recovery process is idempotent. If rerun, it skips existing database rows that match the local seed canonically.
*   **Zero Overwrite**: Existing identical public feeds are accepted without another upload, while unexpected or conflicting rows and feeds halt the runner.
*   **Execution Ordering**: Database project records are inserted before a missing public feed is created.
*   **Non-Transactional Boundaries**: Database mutations and Storage uploads are separate operations and do not form a single cross-service transaction.
*   **Partial Failure Procedure**:
    1.  If database insertion succeeds but the feed upload fails (e.g., due to a temporary network drop or permissions issue), **stop**.
    2.  Preserve the fixed failure code reported by the runner.
    3.  Inspect and correct the cause of the Storage error.
    4.  Rerun the guarded recovery command.
    5.  Matching database rows are detected and skipped automatically.
    6.  The still-missing public feed is created.
*   **Operator Safety Rules**:
    *   Never manually delete matching database rows merely to restart recovery.
    *   Never change the bucket upload configuration from `upsert: false` to `true`.

---

## Historical One-Time Recovery Sequence — Completed

The following sequence records the completed historical recovery steps:

1.  **Review PR #6**: The recovery foundation PR targets `break/admin-cms-staging-foundation` (not `main`). The recovery foundation was successfully merged into that staging foundation branch.
2.  **Merge PR #6**: Merged PR #6 into `break/admin-cms-staging-foundation` after approval.
3.  **Create Project**: Created the replacement Supabase project `capstone-prototype-recovery-2026` manually in the Dashboard.
4.  **Database Setup**: Configured the projects table and RLS constraints via the SQL Editor:
    ```sql
    BEGIN;
    CREATE TABLE IF NOT EXISTS public.projects (
        id BIGINT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON TABLE public.projects FROM anon;
    REVOKE ALL ON TABLE public.projects FROM authenticated;
    GRANT ALL ON TABLE public.projects TO service_role;
    COMMIT;
    ```
5.  **Create Buckets**: Created public storage buckets `feeds` and `project-assets` manually in the Dashboard.
6.  **Configure Environment**: Configured private environment variables in `Prototype/.env`.
7.  **Run Offline Dry-Run**: Ran the dry-run command from `/Prototype`:
    ```bash
    npm run recovery:dry-run
    ```
8.  **Confirm Identity**: Confirmed the Dashboard project name and generated reference match the target manually.
9.  **Run Recovery Apply**: Executed the one controlled recovery apply command:
    ```bash
    npm run recovery:apply
    ```
10. **Verify Seeding**: Verified that 10 database records and 6 public-feed records were successfully created.
11. **Poster Repair**: Verified that two missing poster files were repaired in the separate `demo-assets` repository and all 10 poster URLs are healthy, with zero uploads to the Supabase `project-assets` bucket.

*(Note: Rerunning `npm run recovery:apply` against the current recovery project is prohibited. Future emergency clean-rebuild procedures require separate approval).*

---

## Post-Recovery & Promotion Status

*   **Render Deployment**: Render branch configurations and deployment verification are separate post-recovery activities.
*   **Duda Integration**: Duda runtime configuration and public page rendering verification are separate post-recovery activities.
*   **Promotion Status**: PR #9 was merged into `main` on 2026-07-18 using merge commit `792c0db1db27da04bcd5dd96109180888bca8ac6`. The `main` branch is now the repository source of truth for the recovered Prototype and the separate production-oriented admin CMS foundation. The `break/admin-cms-staging-foundation` branch remains temporarily preserved pending deployment verification.
*   **Current File Categories in PR #9**:
    *   Prototype recovery and Duda wiring
    *   Separate production-oriented admin CMS foundation
    *   Supabase staging schema, RLS, and admin identity migrations
    *   Automated tests and fixtures
    *   Root workspace tooling and configurations
    *(Note: This documentation correction only updates this runbook and does not modify the migrations, tests, fixtures, or workspace files).*
