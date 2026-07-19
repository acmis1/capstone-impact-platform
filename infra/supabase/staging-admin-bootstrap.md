# Staging Administrator Bootstrap Guide

This guide documents the secure, manual sequence to link the initial Supabase Auth user to the first Admin/CMS administrator profile.

> [!WARNING]
> * **PR Phase vs Execution:** Note that migration `0005_initial_admin_bootstrap.sql` has not yet been applied to the staging database merely because this PR exists.
> * **Confirm Project Scope:** The script must be executed only after the human confirms they are targeting the correct, isolated Admin/CMS staging project.
> * **No Password Input:** No password is ever accepted or passed to this linking script.

## Concurrency and Lookup Safety
* **Serialization:** Migration 0005 implements a transaction-scoped advisory lock that serializes concurrent bootstrap attempts, ensuring two processes cannot execute the check-then-insert flow simultaneously.
* **No RPC Writes on Ambiguity:** If the script detects `AUTH_USER_NOT_FOUND` (0 matches) or `MULTIPLE_AUTH_MATCHES` (>1 match), it stops execution immediately and does NOT call the RPC database write function.
* **Rerun Safety:** The linking script is safe to rerun only after migration 0005 has been successfully verified on the database.

## Manual Sequencing

Follow these steps once migration `0005_initial_admin_bootstrap.sql` has been manually applied to the staging database:

1. **Create or Invite User**:
   Create or invite exactly one initial user through Supabase Authentication dashboard or API.
   > [!IMPORTANT]
   > Do not store, write, commit, or disclose the password to the repository, coding agents, or assistant.

2. **Set Temporary Process Variables**:
   In your local terminal session, configure the temporary process variables containing the email and full name of the existing Auth user, along with the confirmation token:
   ```powershell
   $env:CAPSTONE_BOOTSTRAP_ADMIN_EMAIL = "admin@example.com"
   $env:CAPSTONE_BOOTSTRAP_ADMIN_FULL_NAME = "Initial Admin"
   $env:CAPSTONE_BOOTSTRAP_CONFIRM = "LINK_EXISTING_STAGING_ADMIN"
   ```

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

- **Auth User Deletion**: Never delete the Supabase Auth user automatically.
- **Migration History**: Never rerun migration history destructively.
- **Idempotency**: Running the bootstrap operation on an already completed setup returns `ALREADY_PROVISIONED` safely without modifications.
- **Recovery of Role**: If the profile exists but lacks roles, running the bootstrap script returns `ROLE_REPAIRED` to restore the `admin` role.
- **Ambiguous States**: Any other state or mismatch (e.g. multiple profiles, mismatched UUIDs) will raise a controlled exception and block operations, requiring manual database review.
