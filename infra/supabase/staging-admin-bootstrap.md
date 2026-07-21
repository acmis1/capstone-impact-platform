# Staging Administrator Bootstrap Guide

This guide documents the secure, manual sequence to link the initial Supabase Auth user to the first Admin/CMS administrator profile.

> [!WARNING]
> * **Confirm Project Scope:** The script must be executed only after the human confirms they are targeting the correct, isolated Admin/CMS staging project (`capstone-admin-cms-staging-2026`).
> * **No Password Input:** No password is ever accepted or passed to this linking script.
> * **No Bearer Token Reuse:** The prior invitation whose URL exposed a bearer token is compromised and must never be reused.

## Current Staging Status

In the present staging environment (`capstone-admin-cms-staging-2026` located in Singapore):
- migrations 0001 through 0005 have already been manually applied and read-only verified;
- `bootstrap_initial_admin` exists with `service_role`-only execution;
- `admin_users` and `user_roles` remain empty before the initial administrator onboarding;
- the `bootstrap_initial_admin` function has not yet been invoked for the replacement administrator;
- this status applies only to the isolated Admin/CMS staging project.

## Concurrency and Lookup Safety
- **Serialization:** Migration 0005 implements a transaction-scoped advisory lock that serializes concurrent bootstrap attempts, ensuring two processes cannot execute the check-then-insert flow simultaneously.
- **No RPC Writes on Ambiguity:** If the script detects `AUTH_USER_NOT_FOUND` (0 matches) or `MULTIPLE_AUTH_MATCHES` (>1 match), it stops execution immediately and does NOT call the RPC database write function.
- **Rerun Safety:** The linking script is safe to rerun only after migration 0005 has been successfully verified on the database.

## Manual Sequencing

Follow these steps once the replacement invitation flow has been completed and verified:

1. **Invite User and Complete Invitation Flow**:
   Complete the secure two-step invitation flow as documented in [auth-invitation-setup.md](./auth-invitation-setup.md):
   - The invitation email link directs the browser to `/auth/confirm?token_hash=...&type=invite`.
   - GET `/auth/confirm` validates the query parameters and stores the token hash in a temporary HttpOnly cookie, performing no OTP verification.
   - It redirects the browser via a 303 status to the clean URL `/auth/confirm/accept`.
   - The user must explicitly click the **Accept invitation** button to submit the POST form.
   - The acceptance Server Action reads the cookie, deletes it immediately, and calls the Supabase Auth `verifyOtp` API.
   - On success, the user is redirected to `/auth/set-password` where they privately set their password.
   - Setting the password successfully completes the Auth account setup and intentionally signs out the temporary invitation session.
   - The user does not need to remain logged in before running the separate administrator-linking operation.

   > [!IMPORTANT]
   > * Do not store, write, commit, or disclose the password to the repository, coding agents, or assistant.
   > * **The replacement invitation flow must be fully completed and the invitation session signed out before the linking command runs.**

2. **Set Temporary Process Variables**:
   In your local terminal session, configure the temporary process variables containing the email and full name of the existing Auth user, along with the fixed safety-confirmation phrase:
   ```powershell
   $env:CAPSTONE_BOOTSTRAP_ADMIN_EMAIL = "admin@example.com"
   $env:CAPSTONE_BOOTSTRAP_ADMIN_FULL_NAME = "Initial Admin"
   $env:CAPSTONE_BOOTSTRAP_CONFIRM = "LINK_EXISTING_STAGING_ADMIN"
   ```
   *Note: `CAPSTONE_BOOTSTRAP_CONFIRM` must equal the documented fixed phrase required by the guarded script. It is a safety-confirmation phrase, NOT an invitation token, access token, refresh token, password, or Supabase credential.*

3. **Run linking script**:
   From the repository root directory, execute the link script:
   ```bash
   npm run link:admin-staging
   ```
   Or inside `apps/admin-cms`:
   ```bash
   npm run link:staging-admin
   ```

4. **Clean up variables**:
   Immediately clear the temporary variables from your process environment:
   ```powershell
   Remove-Item Env:CAPSTONE_BOOTSTRAP_ADMIN_EMAIL
   Remove-Item Env:CAPSTONE_BOOTSTRAP_ADMIN_FULL_NAME
   Remove-Item Env:CAPSTONE_BOOTSTRAP_CONFIRM
   ```

5. **Verify authentication readiness**:
   Run the read-only staging authentication checker to confirm readiness status matches `READY_FOR_MANUAL_LOGIN_TEST`:
   ```bash
   npm run check:admin-auth
   ```

6. **Perform manual login**:
   Test logging into the Admin/CMS web dashboard only after the checker reports readiness status.

## Rollback & Recovery Guidance

- **First Live Incident & Recovery**:
  - **Confirmed:** The first live bootstrap attempt matched exactly one invited Supabase Auth user (`auth_match_count=1`), invoked the RPC function (`rpc_called=YES`), produced no administrator or role rows (0 rows verified by `npm run check:admin-auth`), and failed during the RPC/database stage (`classification=DATABASE_BOOTSTRAP_FAILURE`).
  - **Strongest Supported Cause:** Migration 0005 contains `pg_catalog.trim(...)` calls which is the strongest code-level explanation because PostgreSQL documents `btrim` as the regular trimming function in `pg_catalog`.
  - **Not Yet Live-Confirmed:** The exact PostgreSQL SQLSTATE returned by the live staging call has not been directly observed; successful execution after migration 0006 application and whether a PostgREST schema-cache reload is required remain to be verified on staging.
  - **Operational Rules:** No automatic retry was performed. Corrective migration `0006_fix_initial_admin_bootstrap_runtime.sql` replaces `pg_catalog.trim` with PostgreSQL standard `pg_catalog.btrim`. Migration 0006 must be reviewed, merged, and manually applied to live Supabase before any subsequent bootstrap attempt. A new explicit operator approval is required before running `npm run link:admin-staging` again. No manual direct database insertion into `admin_users` or `user_roles` is permitted.

- **Auth User Deletion**: Never delete the Supabase Auth user automatically.
- **Migration History**: Never rerun migration history destructively.
- **Idempotency**: Running the bootstrap operation on an already completed setup returns `ALREADY_PROVISIONED` safely without modifications.
- **Recovery of Role**: If the profile exists but lacks roles, running the bootstrap script returns `ROLE_REPAIRED` to restore the `admin` role.
- **Ambiguous States**: Any other state or mismatch (e.g. multiple profiles, mismatched UUIDs) will raise a controlled exception and block operations, requiring manual database review.
