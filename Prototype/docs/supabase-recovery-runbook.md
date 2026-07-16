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

## Recovery Execution Sequence

The complete manual and automated recovery sequence is:

1.  **Review PR #6**: The recovery foundation PR targets `break/admin-cms-staging-foundation` (not `main`). The recovery foundation must first be reviewed and merged into that staging foundation branch. Promotion from the staging foundation to `main` is a separate future decision.
2.  **Merge PR #6**: Merge PR #6 into `break/admin-cms-staging-foundation` only after explicit approval.
3.  **Create Project**: Create the replacement Supabase project manually in the Dashboard.
4.  **Database Setup**: Navigate to the SQL Editor and create the projects table and RLS constraints:
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
    *(Note: The table is server-only. Do not configure any anonymous database SELECT policy).*
5.  **Create Buckets**: Create the exact public storage buckets in the Dashboard:
    *   `feeds` (Public visibility)
    *   `project-assets` (Public visibility)
6.  **Configure Environment**: Configure private environment variables in `Prototype/.env` (`SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and `SUPABASE_EXPECTED_PROJECT_REF`).
7.  **Run Offline Dry-Run**: Run the dry-run command from `/Prototype`:
    ```bash
    npm run recovery:dry-run
    ```
    *Expected Local Results*:
    *   Seed record count: `10`
    *   Public feed record count: `6`
    *   Feed subset validation: `passed`
    *   Duplicate-ID validation: `passed`
    *   Obsolete deleted-reference count: `0`
    *   `READY_FOR_APPLY`: `true`
    *   No Supabase client creation
    *   No network request
    *   Exit code: `0`
8.  **Confirm Identity**: Confirm the Dashboard project name and generated reference match the target manually.
9.  **Run Recovery Apply**: Execute the controlled apply task:
    ```bash
    npm run recovery:apply
    ```
10. **Verify Seeding**: Verify that 10 database records and 6 public feed records are successfully set.
11. **Restore Assets**: Restore static project media assets to `project-assets` in a separate reviewed task (this is not performed or inventoried by the recovery runner).
12. **Update Render**: Update Render web environment variables in a separate controlled task.
13. **Update Duda**: Update the Duda layout HTML widget code block in a separate controlled task.
14. **Regression Testing**: Perform regression testing on the staging prototype.
15. **Consider Promotion**: Consider later promotion of the staging foundation branch to `main` as a separate decision.
