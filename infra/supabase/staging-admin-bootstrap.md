# Staging Administrator Bootstrap Guide

This guide documents the secure, manual sequence to link the initial Supabase Auth user to the first Admin/CMS administrator profile.

> [!WARNING]
> * **Confirm Project Scope:** The script must be executed only after the human confirms the exact authorized isolated target using the [staging reconciliation runbook](staging-reconciliation-runbook.md). The legacy project named in the historical evidence below is not the active staging-v2 target.
> * **No Password Input:** No password is ever accepted or passed to this linking script.
> * **No Bearer Token Reuse:** The prior invitation whose URL exposed a bearer token is compromised and must never be reused.

## Historical Legacy Staging Status

The following was recorded for the legacy staging environment (`capstone-admin-cms-staging-2026` located in Singapore); it is not current staging-v2 evidence:
- migrations 0001 through 0006 have already been manually applied and read-only verified;
- `bootstrap_initial_admin` exists with `service_role`-only execution using standard `pg_catalog.btrim`;
- one initial administrator is linked in `admin_users`;
- exactly one recognized `admin` role assignment exists in `user_roles`;
- the guarded bootstrap execution returned `CREATED` (`provisioned=1`, `auth_match_count=1`, `rpc_called=YES`);
- the read-only readiness checker (`npm run check:admin-auth`) passed with status `READY_FOR_MANUAL_LOGIN_TEST`;
- manual browser login and logout verification passed in Edge;
- future runs for the same identity should normally return `ALREADY_PROVISIONED`;
- no direct administrator or role SQL inserts are supported.

## Concurrency and Lookup Safety
- **Serialization:** Migration 0005/0006 implements a transaction-scoped advisory lock that serializes concurrent bootstrap attempts, ensuring two processes cannot execute the check-then-insert flow simultaneously.
- **No RPC Writes on Ambiguity:** If the script detects `AUTH_USER_NOT_FOUND` (0 matches) or `MULTIPLE_AUTH_MATCHES` (>1 match), it stops execution immediately and does NOT call the RPC database write function.
- **Rerun Safety:** Running the bootstrap operation on an already completed setup returns `ALREADY_PROVISIONED` safely without duplicate insertions or modifications.

## Manual Sequencing

> [!NOTE]
> **Initial Bootstrap Scope:** The historical legacy staging bootstrap completed (`CREATED`). The manual sequence below is documented for setting up a genuinely new isolated environment or an explicitly approved same-identity recovery. It is restricted to the first administrator and is not an additional-user onboarding procedure. Revalidate current target identity and state before authorization.

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
   In your local terminal session, configure the required process environment variables. Note that **independent acknowledgements** are required:
   - Environment variable `CAPSTONE_BOOTSTRAP_CONFIRM=LINK_EXISTING_STAGING_ADMIN` is required by the script input validator.
   - Staging mutation confirmation variable `CAPSTONE_STAGING_MUTATION_CONFIRMATION` (e.g. `capstone-admin-cms-staging-v2-2026`) is required by the staging execution guard and must match the `--confirm-staging=<label>` CLI flag.
   - Target environment variable `CAPSTONE_RUNTIME_ENV=staging` (exact value `staging`) and `CAPSTONE_EXPECTED_SUPABASE_HOST` are required by the execution guard.

   **Bash:**
   ```bash
   export CAPSTONE_RUNTIME_ENV=staging
   export CAPSTONE_EXPECTED_SUPABASE_HOST=app-staging.supabase.co
   export CAPSTONE_STAGING_MUTATION_CONFIRMATION=capstone-admin-cms-staging-v2-2026
   export CAPSTONE_BOOTSTRAP_ADMIN_EMAIL="admin@example.com"
   export CAPSTONE_BOOTSTRAP_ADMIN_FULL_NAME="Initial Admin"
   export CAPSTONE_BOOTSTRAP_CONFIRM=LINK_EXISTING_STAGING_ADMIN
   ```

   **PowerShell:**
   ```powershell
   $env:CAPSTONE_RUNTIME_ENV = "staging"
   $env:CAPSTONE_EXPECTED_SUPABASE_HOST = "app-staging.supabase.co"
   $env:CAPSTONE_STAGING_MUTATION_CONFIRMATION = "capstone-admin-cms-staging-v2-2026"
   $env:CAPSTONE_BOOTSTRAP_ADMIN_EMAIL = "admin@example.com"
   $env:CAPSTONE_BOOTSTRAP_ADMIN_FULL_NAME = "Initial Admin"
   $env:CAPSTONE_BOOTSTRAP_CONFIRM = "LINK_EXISTING_STAGING_ADMIN"
   ```

   *Note: `CAPSTONE_BOOTSTRAP_CONFIRM` must equal `LINK_EXISTING_STAGING_ADMIN`. Do NOT assign the project target confirmation phrase (`capstone-admin-cms-staging-v2-2026`) to this environment variable.*

3. **Run linking script with CLI mutation guard flags**:
   From the repository root directory, execute the link script passing the CLI double-acknowledgment flags (`--apply` and `--confirm-staging=capstone-admin-cms-staging-v2-2026`):
   ```bash
   npm run link:admin-staging -- --apply --confirm-staging=capstone-admin-cms-staging-v2-2026
   ```
   Or inside `apps/admin-cms`:
   ```bash
   npm run link:staging-admin -- --apply --confirm-staging=capstone-admin-cms-staging-v2-2026
   ```

4. **Clean up variables**:
   Immediately clear the temporary process variables from your session environment:

   **Bash:**
   ```bash
   unset CAPSTONE_STAGING_MUTATION_CONFIRMATION
   unset CAPSTONE_BOOTSTRAP_ADMIN_EMAIL
   unset CAPSTONE_BOOTSTRAP_ADMIN_FULL_NAME
   unset CAPSTONE_BOOTSTRAP_CONFIRM
   ```

   **PowerShell:**
   ```powershell
   Remove-Item Env:CAPSTONE_STAGING_MUTATION_CONFIRMATION
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

## Incident History & Resolution

- **First Bootstrap Attempt (Incident Resolved)**:
  - **Original Failed Attempt:** The first live bootstrap attempt matched exactly one invited Supabase Auth user (`auth_match_count=1`), invoked the RPC function (`rpc_called=YES`), produced no administrator or role rows (0 rows verified by `npm run check:admin-auth`), and returned `DATABASE_BOOTSTRAP_FAILURE`.
  - **Root Cause & Fix:** Migration 0005 specified `pg_catalog.trim(...)` which does not exist in `pg_catalog` (unlike standard `pg_catalog.btrim`). Corrective migration `0006_fix_initial_admin_bootstrap_runtime.sql` was created and applied.
  - **Successful Execution & Incident Closure:** Migration 0006 was applied to live staging, post-migration verification passed, the guarded bootstrap script ran successfully returning `CREATED` (`provisioned=1`), `npm run check:admin-auth` confirmed readiness, and manual browser login/logout testing succeeded in Edge. The incident is operationally resolved.

- **Auth User Deletion**: Never delete the Supabase Auth user automatically.
- **Migration History**: Never rerun migration history destructively.
- **Idempotency**: Running the bootstrap operation on an already completed setup returns `ALREADY_PROVISIONED` safely without modifications.
- **Recovery of Role**: If the profile exists but lacks roles, running the bootstrap script returns `ROLE_REPAIRED` to restore the `admin` role.
- **Ambiguous States**: Any other state or mismatch (e.g. multiple profiles, mismatched UUIDs) will raise a controlled exception and block operations, requiring manual database review.
