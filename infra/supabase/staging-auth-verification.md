# Controlled Staging Authentication & Authorization Runbook

This guide outlines the manual verification checklist to audit and validate the Next.js Admin/CMS authentication and Role-Based Access Control (RBAC) gates in the isolated staging environment.

---

## ⚠️ Staging Mutation Checkpoints

The following operations are **staging database mutations** that require explicit operator approval before execution:
*   Applying database schema migration `0003` (Phase B);
*   Creating the fictional test account in Supabase Auth (Phase C);
*   Inserting/updating the `admin_users` record and linking the identity UUID (Phase E);
*   Assigning or modifying administrative roles in `user_roles` (Phase E & Phase I);
*   Executing project review actions or workflow transitions (Phase H).

The `npm run check:admin-auth` script is strictly SELECT-only and remains safe to run at any time without these mutations.

---

## Phase A: Read-Only Preflight

1. **Staging Environment Confirmation**: Confirm that the active project in the Supabase Dashboard is exactly the isolated staging database.
2. **No Production Data Ingress**: Ensure that no real RMIT stakeholder details, student profiles, or actual email addresses are present in the database.
3. **Execution Checklist**: Run the read-only check script from the repository root:
   ```bash
   npm run check:admin-auth
   ```
4. **Expected Output Profiles**:
   * **Migration Missing**: Exit code `2` with `MIGRATION_0003_MISSING` error.
   * **No Provisioned Admin**: Exit code `2` with `NO_LINKED_ADMIN` error.
   * **Fully Provisioned Fictional Admin**: Exit code `0` with `READY_FOR_MANUAL_LOGIN_TEST`.

---

## Phase B: Manual Migration Checkpoint

*This step is a staging mutation and requires explicit operator approval.*

Do not run migrations automatically. The operator must apply the database migration manually:

1. Copy the SQL content from the idempotent migration:
   [0003_admin_auth_identity.sql](../../infra/supabase/migrations/0003_admin_auth_identity.sql)
2. Execute the script within the **SQL Editor** in the Supabase Dashboard.
3. **Post-Migration Verification Checklist**:
   * Navigate to Table Editor > `admin_users` and verify that the `auth_user_id` column exists.
   * Confirm the foreign key references `auth.users(id)` with `ON DELETE CASCADE`.
   * Verify that unique index constraints prevent duplicate non-null `auth_user_id` UUID values.
   * Ensure existing administrator profiles with null `auth_user_id` values remain unchanged.

---

## Phase C: Fictional Auth Account Provisioning

*This step is a staging mutation and requires explicit operator approval.*

1. Navigate to **Authentication** > **Users** in the staging Supabase Dashboard.
2. Click **Add User** > **Create User**.
3. Create a fictional test user with the canonical reserved email:
   ```text
   auth-test-admin@example.com
   ```
4. **Security Rule**: The operator must enter a unique temporary password directly into the Dashboard input. Do not store or share this password in Git, configuration profiles, environment variables, or markdown files.
5. Set **Auto-confirm User?** to `true` and click **Create User**.
6. Copy the generated **User UID (UUID)** for the next steps.

---

## Phase D: Unprovisioned-User Authentication Check

Before linking the test Auth account to any database administrator profiles:

1. Open the Admin/CMS login page in your browser.
2. Enter the canonical fictional email `auth-test-admin@example.com` and your temporary password.
3. **Verification Objectives**:
   * Valid Supabase credentials authenticate successfully;
   * The account is immediately denied Admin/CMS access;
   * A generic access-denied message is displayed;
   * The active Supabase session is signed out immediately;
   * Attempting to navigate directly to `/admin` afterward redirects back to login;
   * No raw database stack traces or internal SQL error messages are exposed.

---

## Phase E: Manual Administrator Linkage

*This step is a staging mutation and requires explicit operator approval.*

To link your newly created Auth user UUID to the administrative schema, execute the guarded, idempotent provisioning SQL block documented in the [Staging User Provisioning Guide](../supabase/manual-apply-guide.md#👥-administrative-user-provisioning-in-staging).

After executing the provisioning SQL block, perform the following verification checks:

1. **Read-Only Preflight Verification**:
   Rerun the preflight check script from the repository root:
   ```bash
   npm run check:admin-auth
   ```
   **Expected Verification Output**:
   * **Migration Status**: `PRESENT`
   * **Linked Administrators**: `at least 1`
   * **Linked Admins Lacking Role**: `0`
   * **Invalid Role Assignments**: `0`
   * **Readiness Status**: `READY_FOR_MANUAL_LOGIN_TEST`
   * **Process exit code**: `0` (Successful readiness status).

2. **Database Aggregate Count Verification**:
   Run the following query in the SQL Editor to confirm profile linkage and role assignment. It returns only aggregate metrics and boolean statuses, keeping sensitive identifiers and UUIDs out of logs:
   ```sql
   SELECT 
       COUNT(*) AS total_canonical_admin_rows,
       COUNT(auth_user_id) AS linked_canonical_admin_rows,
       EXISTS (
           SELECT 1 
           FROM user_roles 
           WHERE role = 'admin' 
             AND user_id = (SELECT id FROM admin_users WHERE email = 'auth-test-admin@example.com')
       ) AS canonical_has_admin_role
   FROM admin_users 
   WHERE email = 'auth-test-admin@example.com';
   ```

---

## Phase F: Browser Session Verification

Using the local Admin/CMS:

1. **Guarded Path Redirection**: Attempt to directly navigate to `/admin`. Verify that you are immediately redirected to `/login?redirectTo=/admin`.
2. **Invalid Sign-In Attempt**: Enter incorrect credentials. Confirm that the page displays the generic message: `Invalid email or password.` (do not reveal if the email exists).
3. **Valid Staging Access**: Log in using the canonical fictional account `auth-test-admin@example.com`. Confirm that `/admin` loads and presents the header showing the user email and roles.
4. **Sub-Route Inheritance**: Verify that `/admin/projects` and `/admin/imports` load successfully without re-requesting credentials.
5. **API Authentication Gates**:
   * Make a request to `GET /api/projects` in the authenticated browser. Verify that the JSON response returns status code `200` with the project records.
   * Attempt to request `GET /api/projects` from an unauthenticated browser session (e.g. private window). Verify that it returns status code `401` with error `Authentication required.`.
6. **Session Sign-Out**: Click **Log Out**. Confirm that the browser is redirected to `/login`, and attempting to revisit `/admin` results in a redirect back to `/login`.
7. **Client Token Security**: Inspect the browser console, sessionStorage, localStorage, and page source. Confirm that no Supabase service-role keys or raw access/refresh tokens are stored or rendered in client-visible code.

---

## Phase G: CSRF Mutation Validation

The browser project review action utilizes cookie authentication, requiring Origin verification:

1. **Same-Origin Allowed**: A standard POST mutation request sent from the Admin console same-origin is allowed (returns `200` or validation error codes).
2. **Cross-Origin Rejected**: A POST mutation sent with an Origin header differing from `request.nextUrl.origin` is rejected with `403` and `Access denied.`.
3. **Missing Origin Rejected**: A POST request with no Origin header is rejected with `403`.
4. **Malformed Payload Rejected**: A request containing primitive body types, null values, or `comments: null` is rejected with `400` and `Validation failed.` before any repository read or write occurs.

---

## Phase H: Audit Attribution Checkpoint

*This step is a staging mutation and requires explicit operator approval.*

To verify audit tracking, the operator must execute a test workflow transition:

1. Ensure a mock project has been seeded to staging (e.g. status `submitted`).
2. Log in using the canonical fictional test administrator account.
3. Submit an approval action (e.g. transition `submitted` to `approved`).
4. Run a query in the SQL Editor to audit the result:
   ```sql
   SELECT admin_id FROM approval_records ORDER BY created_at DESC LIMIT 1;
   ```
5. **Validation Invariants**:
   * Verify `admin_id` equals the UUID of the `admin_users` record, **not** the Supabase Auth UUID or `null`.
   * Confirm that no administrator UUID, email, or name is written into public showcase JSON feeds.

---

## Phase I: Role Permission Verification Plan

*This step is a staging mutation and requires explicit operator approval.*

Role permission checks must be manually verified using the test administrator profile:

1. **Procedural Guideline**: Role modifications must be performed manually in the Table Editor/SQL. The operator must log out and log back in to refresh the active session claims and context.
2. **Permission Matrix Audit**:
   * **`admin`**: Verify access to all projects, review workflows, archiving actions, and import batch pages.
   * **`reviewer`**: Verify access to projects and review actions. Confirm that attempts to archive or edit return `403`.
   * **`editor`**: Verify access to edit metadata fields. Confirm that attempts to approve, request changes, or archive return `403`.

Expected permission matrix:
*   **admin**: `projects.read`, `projects.review`, `projects.archive`, `projects.edit`
*   **reviewer**: `projects.read`, `projects.review`
*   **editor**: `projects.read`, `projects.edit`

---

## Phase J: Verification Evidence Log Template

Use the template below to document the test outcomes. Do not embed credentials or personal identifiers in the logs.

| Test ID | Test Date | Environment | Expected Outcome | Actual Outcome | Pass/Fail | Evidence Reference | Notes / Operator |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **VAL-001** | | Staging | Preflight exits 2 (missing column) | | | | |
| **VAL-002** | | Staging | Preflight exits 2 (missing user) | | | | |
| **VAL-003** | | Staging | Preflight exits 0 (admin linked) | | | | |
| **VAL-004** | | Staging | Unprovisioned Auth user is denied, signed out and shown a generic message | | | | |
| **VAL-005** | | Staging | Authenticated session loads /admin | | | | |
| **VAL-006** | | Staging | Unauthenticated GET /api/projects: 401 | | | | |
| **VAL-007** | | Staging | Missing/Cross-Origin POST mutation: 403 | | | | |
| **VAL-008** | | Staging | Malformed comments/body payload: 400 | | | | |
| **VAL-009** | | Staging | Audit record tracks admin_users.id | | | | |
| **VAL-010** | | Staging | RBAC permission restrictions enforced | | | | |
