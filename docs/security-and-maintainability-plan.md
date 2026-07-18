# Security and Maintainability Plan

This document establishes the security guidelines, trust boundaries, and maintainability rules governing the Capstone Impact Platform's production-oriented architecture.

---

## 1. Purpose and Scope
Ensure that administrative workflows, student project data, and public showcase assets are protected against unauthorized modification, credential leakage, and data loss.

---

## 2. Trust Boundaries

```
[Student Packages] ─► [HTTPS Upload] ─► [CMS Admin UI] ── (Admin Auth Middleware) ──► [PostgreSQL & Storage]
                                                                                           │
[Duda Shell (Public UI)] ◄── (HTTPS GET) ◄── [Stable Public JSON Feed] ◄── [Staging Buckets (Public)]
```

---

## 3. Current Controls Present in the Admin/CMS Foundation

| Security Control | Scope / Description | Status |
| :--- | :--- | :--- |
| **Admin Auth Migrations** | Supabase authentication schema and admin users role tables | `IMPLEMENTED` |
| **JWT Claims Check** | Verification of admin roles in middleware and routes | `SCAFFOLDED` |
| **Admin Route Lock** | Restricting Next.js admin routes behind session validation | `PENDING ACTIVATION` |
| **Row-Level Security** | Supabase database policies blocking unauthorized reads/writes | `IMPLEMENTED` |
| **Public Feed Compilation** | Automated stripping of administrative and private fields | `IMPLEMENTED` |
| **Private/Public Media Separation** | Storing drafts in private buckets and approved posters in public buckets | `REQUIRED` |
| **Institutional Key Handover** | Account ownership mapped to school-controlled email aliases | `REQUIRED` |

---

## 4. Prototype Preservation Rules
*   **Complete Isolation**: The feasibility prototype located in `/Prototype` is preserved purely as historical evidence and must remain completely isolated.
*   **No Helper Sharing**: Under no circumstances should `/apps/admin-cms` import helper code or utilities directly from `/Prototype`. Common modules must be built independently within the Next.js app directory.

---

## 5. Authentication and Authorization Status
*   **CMS Authentication**: Administrative authentication and Role-Based Access Control (RBAC) schemas have been created in Supabase PostgreSQL migrations. However, active route validation and staging auth checks are `PENDING ACTIVATION`.
*   **Environment Lock**: Staging auth verification and session checks must be executed against the separate `capstone-impact-staging` environment. The Prototype recovery project **must never** be used for admin authentication.
*   **Least Privilege Credentials**: Supabase `service_role` keys are backend-only. Under no circumstances may they be exposed in client bundles or public repositories.

---

## 6. Data and Media Protection
*   **Media Folder Isolation**: Student folder uploads containing draft Excel sheets, personal documents, and raw source materials must reside in private buckets.
*   **Public Assets**: Only approved project media (posters, snapshot images, and videos) may be copied to the public `feeds` and `project-assets` buckets.
*   **No Real Data Seeding**: No real student or stakeholder data may be checked into Git or loaded into staging without authorization. All test configurations must use fictional mock data.

---

## 7. Feed and Duda Public-Layer Protection
*   **Feed Validation Gate**: The feed validation script (`validatePublicFeed.ts`) operates as a security boundary, rejecting any payload containing administrative metadata or unexpected properties.
*   **Output Sanitization**: The Duda dynamic script (`bodyend.html`) must sanitize and escape all project strings (especially HTML and markdown text fields) before inserting them into the DOM to prevent Cross-Site Scripting (XSS).

---

## 8. Auditability and Transactional Integrity
*   **Staging Actions**: Administrative actions (mapping batches, updating project statuses, and archiving) should generate immutable audit logs in a dedicated database table.
*   **Atomic Transactions**: Multi-table updates must be executed as atomic database transactions to ensure consistency.

---

## 9. Maintainability Principles
*   **Production Foundation**: The apps directory (`/apps/admin-cms`) is the Next.js production-oriented foundation.
*   **Precedence of Executables**: Current code files, SQL migrations, and Vitest test suites always take precedence over planning prose or legacy documentation.

---

## 10. Backup, Recovery, and Ownership
*   **Institutional Handover**: RMIT/School staff must have full ownership of Render hosting billing, Supabase cloud billing, and GitHub repository admin rights. Student groups must not own active production keys.
*   **Backup Schedule**: Automated daily database backups must be configured in the Supabase production dashboard.

---

## 11. Prioritized Unresolved Risks
*   **Lack of Staging Key Rotation**: Staging credentials must be rotated immediately if exposed in command logs.
*   **Cold Start Latency**: Free-tier hosting on Render can introduce a 50+ second delay. A production deployment strategy must resolve server wake-up thresholds.

---

## 12. Security Acceptance Criteria
*   Only authenticated school administrators can perform write requests on the Admin/CMS.
*   The public JSON feed strictly contains approved project data and has zero references to deleted projects or internal notes.
*   All public-facing media URLs use HTTPS and are served from approved storage buckets.
