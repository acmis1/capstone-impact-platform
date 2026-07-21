# Staging Authentication Activation & Verification Evidence

This document records the sanitized operational verification evidence for the initial administrator authentication activation in the isolated staging environment.

---

## 1. Environment & Scope Verification

*   **Verification Date:** 2026-07-21
*   **Target Environment:** Isolated Admin/CMS Staging (`capstone-admin-cms-staging-2026`)
*   **Region:** Singapore
*   **Isolation Guarantee:** Completely separate from Prototype recovery project; zero connection to production Duda.
*   **Privacy & Security Invariant:** Zero passwords, tokens, API keys, credentials, emails, full names, or UUIDs are recorded or stored in this document.

---

## 2. Corrective Migration 0006 Application

*   **Migration File:** `infra/supabase/migrations/0006_fix_initial_admin_bootstrap_runtime.sql`
*   **Application Method:** Manually applied exactly once by the authorized operator via Supabase Dashboard SQL Editor.
*   **Application Result:** `APPLIED_ONCE`
*   **Post-Migration SQL Verification Results:**
    *   Function `public.bootstrap_initial_admin(uuid, text, text)` present: `true`
    *   Function owner `postgres`: `true`
    *   `SECURITY DEFINER`: `true`
    *   Empty `search_path = ''`: `true`
    *   `pg_catalog.btrim` present: `true`
    *   Invalid `pg_catalog.trim` absent: `true`
    *   Advisory transaction lock (`pg_catalog.pg_advisory_xact_lock`) retained: `true`
    *   Execution denied to `PUBLIC`: `true`
    *   Execution denied to `anon`: `true`
    *   Execution denied to `authenticated`: `true`
    *   Execution granted exclusively to `service_role`: `true`
    *   Pre-bootstrap `admin_users` row count: `0`
    *   Pre-bootstrap `user_roles` row count: `0`

---

## 3. Guarded Initial Administrator Bootstrap

*   **Execution Method:** Executed once by the authorized operator via `npm run link:admin-staging` (`linkExistingStagingAdmin.ts`).
*   **Sanitized Summary Result:**
    *   Classification: `CREATED`
    *   Provisioned: `1`
    *   Auth Match Count: `1`
    *   Pages Read: `2`
    *   RPC Called: `YES`
    *   Process Exit Code: `0`
    *   Environment Variable Cleanup: Temporary process variables cleared immediately after execution.

---

## 4. SELECT-Only Readiness Checker Audit

*   **Execution Command:** `npm run check:admin-auth`
*   **Process Exit Code:** `0`
*   **Audit Results:**
    *   Migration Status (`0003`): `PRESENT`
    *   Total Administrator Rows: `1`
    *   Linked Administrators: `1`
    *   Unlinked Administrators: `0`
    *   Recognized Role Assignments: `1` (`admin`)
    *   Invalid Role Assignments: `0`
    *   Linked Administrators Lacking Role: `0`
    *   Readiness Status: `READY_FOR_MANUAL_LOGIN_TEST`

---

## 5. Automated Validation & Security Scanning

*   **Vitest Unit Suite:** 16 test files passed, 218 tests passed cleanly (`npm run test:admin`).
*   **TypeScript Compiler:** `tsc --noEmit` passed with 0 errors (`npm run typecheck:admin`).
*   **Next.js Production Build:** `next build` succeeded under Next.js version 16.2.6 Turbopack (`npm run build:admin`).
*   **Lint Check:** ESLint passed on changed files (`✔ No ESLint warnings or errors`).
*   **Git Formatting:** `git diff --check` passed with 0 warnings/errors.
*   **Client Bundle Isolation Scan:**
    *   Administrative client (`admin.ts`) uses `import 'server-only'`: `true`
    *   Zero frontend client components (`'use client'`) import administrative client modules: `true`
    *   Zero `SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_SECRET_KEY` literals exist in static client build output (`.next/static`): `true`
    *   Zero secret key credential patterns exist in tracked application files: `true`

---

## 6. Manual Browser Acceptance (Microsoft Edge)

*   **GET `/login`:** Unauthenticated request loaded clean login page (HTTP 200).
*   **GET `/admin`:** Unauthenticated request redirected to `/login?redirectTo=/admin` (HTTP 307).
*   **GET `/admin/imports`:** Unauthenticated request redirected to `/login?redirectTo=/admin` (HTTP 307).
*   **GET `/api/projects`:** Unauthenticated request returned HTTP 401 with sanitized body `{"success":false,"error":"Authentication required."}` (no stack traces, no SQL details, no environment values).
*   **GET `/api/health`:** Unauthenticated request returned HTTP 200 exposing safe configuration status classifications only.
*   **Authenticated Login:** Submitting valid credentials authenticated successfully and redirected to `/admin`.
*   **Authenticated Dashboard:** `/admin` loaded, displaying the header with user identity representation and `ADMIN` role badge.
*   **Authenticated Sub-Routes:** `/admin/imports` loaded successfully without re-prompting for credentials.
*   **Authenticated API Access:** `GET /api/projects` returned HTTP 200 with project records array.
*   **Project Detail Test:** **Skipped** because zero project records currently exist in the staging database.
*   **Session Logout:** Clicking **Log Out** signed out the session and redirected to `/login`.
*   **Post-Logout Re-verification:** Re-navigating to `/admin` redirected to `/login?redirectTo=/admin`, and `GET /api/projects` returned HTTP 401.

---

## 7. Remaining Untested Areas

The following advanced capabilities are scheduled for subsequent UAT phases and were not part of initial admin auth activation:

1. **CSRF Mutation Validation:** Cross-origin POST mutation rejections on project review actions.
2. **Multi-Role RBAC Matrix:** Permission enforcement across `reviewer` and `editor` role profiles.
3. **Audit Record Attribution:** Verifying `admin_users.id` tracking on project status transitions.
4. **Session Expiry Governance:** Automatic session timeout and refresh token behavior under extended inactivity.
5. **Full RLS Policy Matrix:** Direct database row-level security policy evaluation across non-admin roles.
6. **Non-Technical Staff UAT:** Usability testing with school administrative coordinators.
7. **Production Cutover:** Connection to production Duda shell or live public feed publication.

---

## 8. Privacy & Security Statement

All testing was conducted strictly using authorized, isolated staging configuration. No credentials, tokens, passwords, emails, full names, or UUIDs are recorded in repository files or documentation.
