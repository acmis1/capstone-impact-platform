# Controlled Staging Authentication & Authorization Runbook

This guide outlines the manual verification checklist to audit and validate the Next.js Admin/CMS authentication and Role-Based Access Control (RBAC) gates in the isolated staging environment.

---

## Phase A: Read-Only Preflight

1. **Staging Environment Confirmation**: Confirm that the active project in the Supabase Dashboard is the isolated `capstone-impact-staging` environment.
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

1. Navigate to **Authentication** > **Users** in the staging Supabase Dashboard.
2. Click **Add User** > **Create User**.
3. Create a fictional test user with a reserved address:
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
2. Enter `auth-test-admin@example.com` and your temporary password.
3. **Verification Objectives**:
   * Sign-in to Supabase succeeds, but access to the Admin/CMS is denied.
   * The page displays a generic `Access denied.` error.
   * The application automatically signs the user out of the Supabase Auth session to prevent stale cookies.
   * No raw database stack traces or internal SQL error messages are exposed.

---

## Phase E: Manual Administrator Linkage

The operator manually connects the fictional Auth user UUID to the administrative schema:

1. Open the SQL Editor in the Dashboard and run the following command (replacing `<AUTH_USER_UUID>` with your copied Auth UID):
   ```sql
   -- Link the user profile
   UPDATE admin_users 
   SET auth_user_id = '<AUTH_USER_UUID>'
   WHERE email = 'test.admin@example.local';
   ```
2. Rerun the preflight check script:
   ```bash
   npm run check:admin-auth
   ```
3. Verify that the output lists `Migration Status: PRESENT`, `Linked Administrators: 1`, `Readiness Status: READY_FOR_MANUAL_LOGIN_TEST`, and exits with code `0`.

---

## Phase F: Browser Session Verification

1. **Guarded Path Redirection**: Attempt to directly navigate to `/admin`. Verify that you are immediately redirected to `/login?redirectTo=/admin`.
2. **Invalid Sign-In Attempt**: Enter incorrect credentials. Confirm that the page displays the generic message: `Invalid email or password.` (do not reveal if the email exists).
3. **Valid Staging Access**: Log in using the test account. Confirm that `/admin` loads and presents the header showing the user email and roles.
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

To verify audit tracking, the operator must execute a test workflow transition. **This step modifies staging data and must only be performed after explicit approvals.**

1. Ensure a mock project has been seeded to staging (e.g. status `submitted`).
2. Log in using the test administrator account.
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

Role permission checks must be manually verified using the test administrator profile:

1. **Procedural Guideline**: Role modifications must be performed manually in the Table Editor/SQL. The operator must log out and log back in to refresh the active session claims and context.
2. **Permission Matrix Audit**:
   * **`admin`**: Verify access to all projects, review workflows, archiving actions, and import batch pages.
   * **`reviewer`**: Verify access to projects and review actions. Confirm that attempts to archive or edit return `403`.
   * **`editor`**: Verify access to edit metadata fields. Confirm that attempts to approve, request changes, or archive return `403`.

---

## Phase J: Verification Evidence Log Template

Use the template below to document the test outcomes. Do not embed credentials or personal identifiers in the logs.

| Test ID | Test Date | Environment | Expected Outcome | Actual Outcome | Pass/Fail | Evidence Reference | Notes / Operator |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **VAL-001** | | Staging | Preflight exits 2 (missing column) | | | | |
| **VAL-002** | | Staging | Preflight exits 2 (missing user) | | | | |
| **VAL-003** | | Staging | Preflight exits 0 (admin linked) | | | | |
| **VAL-004** | | Staging | Unprovisioned Auth user receives 403 | | | | |
| **VAL-005** | | Staging | Authenticated session loads /admin | | | | |
| **VAL-006** | | Staging | Unauthenticated GET /api/projects: 401 | | | | |
| **VAL-007** | | Staging | Missing/Cross-Origin POST mutation: 403 | | | | |
| **VAL-008** | | Staging | Malformed comments/body payload: 400 | | | | |
| **VAL-009** | | Staging | Audit record tracks admin_users.id | | | | |
| **VAL-010** | | Staging | RBAC permission restrictions enforced | | | | |
