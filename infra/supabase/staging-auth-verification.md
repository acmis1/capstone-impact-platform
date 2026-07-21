# Controlled Staging Authentication & Authorization Runbook

This guide outlines the manual verification checklist to audit and validate the Next.js Admin/CMS authentication and Role-Based Access Control (RBAC) gates in the isolated staging environment (`capstone-admin-cms-staging-2026`).

---

## ⚠️ Staging Mutation Checkpoints

The following operations are **staging database mutations** that require explicit operator approval before execution:
*   Applying database schema migrations (Phase B);
*   Sending/processing an authorized user invitation in Supabase Auth (Phase C);
*   Running the guarded bootstrap script (`npm run link:admin-staging`) to link an Auth user to `admin_users` and `user_roles` (Phase E);
*   Assigning or modifying administrative roles in `user_roles` via an approved role-provisioning workflow (Phase E & Phase I);
*   Executing project review actions or workflow transitions (Phase H).

The `npm run check:admin-auth` script is strictly SELECT-only and remains safe to run at any time without these mutations.

---

## Phase A: Read-Only Preflight

1. **Staging Environment Confirmation**: Confirm that the active project in the Supabase Dashboard is exactly the isolated staging database (`capstone-admin-cms-staging-2026`).
2. **Data Isolation & Privacy**: Ensure that no real RMIT student records or stakeholder directories are loaded. One authorized administrator identity exists for controlled staging authentication. Identity values must never be printed, logged, or committed.
3. **Execution Checklist**: Run the read-only check script from the repository root:
   ```bash
   npm run check:admin-auth
   ```
4. **Expected Output Profiles**:
   * **Migration Missing**: Exit code `2` with `MIGRATION_0003_MISSING` error.
   * **No Provisioned Admin**: Exit code `2` with `NO_LINKED_ADMIN` error.
   * **Fully Provisioned Admin**: Exit code `0` with `READY_FOR_MANUAL_LOGIN_TEST`.

---

## Phase B: Manual Migration Guidance (Historical & Setup)

*Note for Current Staging:* The active staging environment (`capstone-admin-cms-staging-2026`) already has migrations `0001` through `0006` applied. Do not rerun migrations on current staging. Refer to [manual-apply-guide.md](./manual-apply-guide.md) when setting up a genuinely new isolated environment.

---

## Phase C: Authorized User Invitation & Setup

1. Self-registration remains strictly disabled.
2. The authorized operator sends/uses the approved Supabase invitation.
3. The recipient completes the two-step invitation acceptance flow (`/auth/confirm` -> `/auth/confirm/accept`).
4. The recipient privately sets a password on `/auth/set-password`.
5. No password, token, UUID, email, or identity value is disclosed to agents or committed.
6. See [auth-invitation-setup.md](./auth-invitation-setup.md) for full protocol details.
7. *Note:* For the current staging environment, initial administrator Auth setup is already complete; do not create another invitation for the initial administrator.

---

## Phase D: Unprovisioned-User Authentication Check (NOT EXECUTED / PENDING)

*Status:* **Pending / Not Executed**.

This test verifies that a valid Supabase Auth account that is **not** linked to `admin_users` is denied access upon login.

*Execution Requirement:* Requires a separately approved fictional Auth identity that is authenticated in Supabase Auth but intentionally not linked to `admin_users`. Note that invitation-session sign-out is part of the standard password setup flow and is not evidence of unprovisioned-user access denial.

---

## Phase E: Guarded Administrator Linkage

To link an authenticated Supabase Auth user to the administrative schema in a new setup:

1. Privately set temporary process variables:
   ```powershell
   $env:CAPSTONE_BOOTSTRAP_ADMIN_EMAIL = "admin@example.com"
   $env:CAPSTONE_BOOTSTRAP_ADMIN_FULL_NAME = "Initial Admin"
   $env:CAPSTONE_BOOTSTRAP_CONFIRM = "LINK_EXISTING_STAGING_ADMIN"
   ```
2. Execute `npm run link:admin-staging` only after explicit operator approval.
3. Clear temporary process variables immediately.
4. Run `npm run check:admin-auth` to confirm readiness status `READY_FOR_MANUAL_LOGIN_TEST`.
5. **Security Invariant:** Never paste Auth UUIDs into SQL queries or manually modify administrator/role rows directly in the database.
6. See [staging-admin-bootstrap.md](./staging-admin-bootstrap.md).
7. *Note for Current Staging:* Initial administrator linkage has already completed (`CREATED`, 1 linked admin, 1 recognized role) and should not be rerun.

---

## Phase F: Protected Route & Session Verification

Testing is divided between automated unauthenticated HTTP checks and manual authenticated Edge acceptance:

1. **Automated Unauthenticated HTTP Checks**:
   * `GET /login`: Returns HTTP 200 OK.
   * `GET /admin`: Returns HTTP 307 redirect to `/login?redirectTo=/admin`.
   * `GET /admin/imports`: Returns HTTP 307 redirect to `/login?redirectTo=/admin`.
   * `GET /admin/projects/{publicId}`: Returns HTTP 307 redirect to `/login?redirectTo=/admin`. (Note: Protected project detail routes use `/admin/projects/{publicId}`; no standalone `/admin/projects` index route exists).
   * `GET /api/projects`: Returns HTTP 401 Unauthorized with sanitized response `{"success":false,"error":"Authentication required."}` (no stack traces or SQL details).
   * `GET /api/health`: Returns HTTP 200 exposing safe configuration status classifications only.

2. **Manual Authenticated Edge Session Test**:
   * Log in via Microsoft Edge at `/login`.
   * Confirm successful authentication and redirection to `/admin`.
   * Confirm dashboard header renders administrator identity representation and `ADMIN` role badge.
   * Confirm sub-route `/admin/imports` loads successfully while authenticated.
   * Confirm `GET /api/projects` returns HTTP 200 with JSON response and `count: 0`.
   * *Project-Detail Route Test:* **Skipped** because zero project records currently exist in the staging database.
   * Click **Log Out**: Confirm browser redirects to `/login`.
   * Post-logout re-verification: Confirm `/admin` redirects to `/login?redirectTo=/admin` and `GET /api/projects` returns HTTP 401.

---

## Phase G: CSRF Mutation Validation (PENDING)

*Status:* **Pending / Not Executed**. Requires active project rows and reviewer/editor role fixtures.

---

## Phase H: Audit Attribution Checkpoint (PENDING)

*Status:* **Pending / Not Executed**. Requires active project rows and workflow transitions.

---

## Phase I: Role Permission Verification Plan (PENDING)

*Status:* **Pending / Not Executed**.

*Guidelines:*
- Reviewer and editor role matrix tests remain pending.
- Testing requires a separately reviewed, approved role-fixture and provisioning workflow.
- Do not modify current administrator roles directly using SQL or Table Editor.
- Do not repurpose the initial administrator profile during this closure task.

---

## Phase J: Verification Evidence Log

The initial administrator authentication verification was executed against isolated staging (`capstone-admin-cms-staging-2026`) on **2026-07-21**:

| Test ID | Test Date | Environment | Expected Outcome | Actual Outcome | Pass/Fail | Evidence Reference | Notes / Operator |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **VAL-001** | *Historical* | Staging | Preflight exits 2 when migration 0003 is missing | *Not Executed* (Migration 0003 already applied on staging) | **NOT EXECUTED** | `checkStagingAuth.ts` | Setup historical baseline |
| **VAL-002** | 2026-07-21 | Staging | Preflight exits 2 when no admin is linked | Exit code 2 (`NO_LINKED_ADMIN`) returned before bootstrap | **PASS** | `checkStagingAuth.ts` | Pre-bootstrap baseline |
| **VAL-003** | 2026-07-21 | Staging | Preflight exits 0 (`READY_FOR_MANUAL_LOGIN_TEST`) | Exit code 0, 1 linked admin, 1 recognized role | **PASS** | `staging-auth-activation-evidence.md` | Post-bootstrap verification |
| **VAL-004** | *Pending* | Staging | Unprovisioned Auth user is denied access upon login | *Pending* (Requires separately approved unlinked Auth user) | **PENDING** | | Not executed in initial activation |
| **VAL-005** | 2026-07-21 | Staging | Authenticated Edge session loads `/admin` & `/admin/imports` | `/admin` and `/admin/imports` loaded; header rendered ADMIN role | **PASS** | Edge browser verification | Project detail `/admin/projects/{publicId}` skipped (0 project rows) |
| **VAL-005b**| 2026-07-21 | Staging | Session logout & post-logout denial | Logged out to `/login`; `/admin` redirected to `/login?redirectTo=/admin` | **PASS** | Edge browser verification | Manual logout test |
| **VAL-006** | 2026-07-21 | Staging | Unauthenticated `GET /api/projects`: 401 | Status HTTP 401 `Authentication required.` returned | **PASS** | Automated HTTP checks | Sanitized response |
| **VAL-007** | *Pending* | Staging | Missing/Cross-Origin POST mutation: 403 | *Pending multi-role mutation UAT* | **PENDING** | | Requires project row |
| **VAL-008** | *Pending* | Staging | Malformed comments/body payload: 400 | *Pending multi-role mutation UAT* | **PENDING** | | Requires project row |
| **VAL-009** | *Pending* | Staging | Audit record tracks `admin_users.id` | *Pending multi-role mutation UAT* | **PENDING** | | Requires project row |
| **VAL-010** | *Pending* | Staging | RBAC permission restrictions enforced | *Pending multi-role mutation UAT* | **PENDING** | | Requires reviewer/editor roles |
