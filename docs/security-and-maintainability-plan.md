# Security and Maintainability Plan

This document establishes the security guidelines, trust boundaries, and maintainability rules governing the Capstone Impact Platform's production-oriented architecture.

---

## 1. Purpose and Scope
Ensure that administrative workflows, participant project data, and public showcase assets are protected against unauthorized modification, credential leakage, and data loss.

---

## 2. Target Production Trust Boundaries

```
[Participant Packages] ─► [HTTPS Upload (Target)] ─► [CMS Admin UI] ── (Server-side auth and permission guards) ──► [PostgreSQL & Storage]
                                                                                           │
[Duda Shell (Public UI)] ◄── (HTTPS GET) ◄── [Stable Public JSON Feed] ◄── [Approved Public Feed Storage]
```
*(Note: The complete HTTPS participant-upload workflow is a target design and is not currently operational. The repository-owned `apps/public-layer/duda/` renderer implements and tests the public-feed listing/detail contract, including search and public-URL policy, and is now saved in the authorized Duda TEST editor. Synthetic data-backed acceptance passed through the governed staging feed; no Duda Publish/Republish or live RMIT/Impact publication occurred. Any Admin/CMS-to-production Duda cutover requires separate authorization and verification. The current authorization implementation uses the server-only `requireAdmin` helper, protected admin layout, protected API routes, and permission checks.)*

---

## 3. Current Controls Present in the Admin/CMS Foundation

| Security Control | Scope / Description | Status |
| :--- | :--- | :--- |
| **Auth and schema migrations** | 57 append-only versioned repository-candidate migrations through `20260911120000_gallery_full_text_equivalents`; latest hosted evidence remains 52 | `REPOSITORY_VERIFIED`; Migrations 0053–0057 have no hosted evidence in this patch |
| **Claims/Session Authorization Helper** | Verification of admin roles and permission checks via `requireAdmin` helper | `IMPLEMENTED_AND_TESTED` |
| **Protected Layout & Route guards** | Protected admin layout and API route session validation guards | `IMPLEMENTED_AND_TESTED` |
| **Live Session Verification** | Initial administrator activation is historical evidence; current staging-v2 is a separate target | `HISTORICAL_EVIDENCE` |
| **Service-Role Client Isolation** | Server-only administrative client wrapper (`admin.ts`) with `server-only` guards | `IMPLEMENTED_AND_TESTED` |
| **RLS Policy Definitions** | Restrictive RLS policies and grants in migrations; Gate 4 structurally matched 31 policies in active staging-v2 | `VERIFIED_STAGING` |
| **RLS Role-Matrix Verification** | Real Local Auth, exact Admin/Reviewer/Editor and editor+reviewer union permissions, Data API/RLS mutation denial, and service-only RPC denial | `AUTOMATED LOCAL ACCEPTANCE IMPLEMENTED` |
| **Public Feed Compiler & Validator** | Strips administrative metadata, validates public records, and preserves canonical artifacts/ledger history | `IMPLEMENTED_AND_TESTED` |
| **Private/public media workflow** | Governed private draft intake, approval gates, controlled public-media promotion, and public-feed publication/removal coordination | `IMPLEMENTED_AND_TESTED` |
| **Institutional account handover** | Cloud resource ownership transfer to school-controlled aliases | `REQUIRED` |

---

## 4. Prototype Preservation Rules
*   **Complete Isolation**: Historical Prototype material remains isolated and immutable. The explicitly maintained `apps/public-layer/` Duda presentation package owns the renderer and contract harness; it has no feed-authority or live-publication capability.
*   **No Helper Sharing**: Under no circumstances should `/apps/admin-cms` import helper code or utilities directly from `/Prototype`. Common modules must be built independently within the Next.js app directory.

---

## 5. Authentication and Authorization Status
*   **CMS Authentication**: Initial administrator authentication in `capstone-admin-cms-staging-2026` is historical evidence, not a current staging-v2 acceptance claim. Automated disposable-Local acceptance verifies real Admin/Reviewer/Editor sign-in, exact role and multi-role permission unions, RLS/Data API denial, service-only RPC denial, 3600-second issued-session timing, sign-out browser-session removal, CSRF mutation boundaries, and server-derived audit attribution. Human reviewer/editor UAT, hosted multi-role acceptance, institutional provisioning, and staff handover remain pending.
*   **Environment Lock**: The active Admin/CMS staging stack uses Render service `capstone-admin-cms-staging-v2` with the active Supabase staging-v2 project `capstone-admin-cms-staging-v2-2026`; the old `capstone-admin-cms-staging-2026` activation is historical. The Prototype recovery project **must not be used** for Admin/CMS authentication.
*   **Least Privilege Credentials**: Supabase `service_role` keys are backend-only and their usage is isolated in server-only modules (`import 'server-only'`). Static client bundle scanning confirmed zero service-role keys or secret names exist in frontend assets.
*   **Migration Contract**: The repository candidate contains 57 versioned migrations. Active staging-v2 and its independent Gate 4 evidence remain at the prior 52-migration contract until separately authorized application and fresh evidence. This does not authorize routine migration repair, `db push`, reset, or hosted mutation; repair requires a proven history mismatch and separate authorization.

---

## 6. Data and Media Protection
*   **Media Folder Isolation**: Participant folder uploads containing draft Excel sheets, personal documents, and raw source materials must reside in private buckets. The default configurable bucket names are:
    *   Private drafts: `project-drafts-private`
    *   Public assets: `project-public-assets`
    *   Public feeds: `public-feeds`
*   **Public Assets**: Only approved project media (posters, snapshot images, and PDFs) may be copied to the public approved asset storage. Current video handling is strictly metadata-driven (external video link URL); video binary files are not copied to public storage.
*   **No Real Data Seeding**: No real participant or stakeholder data may be checked into Git or loaded into staging without authorization. All test configurations must use fictional mock data.
*   **Row-Level Security**: Local role-matrix acceptance verifies real role behavior and mutation/RPC denials; Gate 4 structurally verified RLS/policies and grants in active staging-v2. Hosted multi-role human UAT remains required before operational acceptance.

---

## 7. Feed and Duda Public-Layer Protection
*   **Feed Validation Gate**: The feed validation script (`validatePublicFeed.ts`) operates as a security boundary, rejecting any payload containing administrative metadata or unexpected properties.
*   **Output Sanitization and URL Policy**: The repository Duda renderer validates public URLs, rejects private/signed/authenticated Storage paths, token-bearing URLs, unsafe schemes, malformed encodings, and embedded credentials; its Chrome contract harness passed 40 scenarios, with paired browser/server contract cases exercising this boundary. The authorized Duda TEST editor now contains the saved repository renderer and passed bounded synthetic data-backed listing/search/filter/detail/mobile-listing acceptance. This is `VERIFIED_TEST`, not production or institutional acceptance.
*   **Workflow Integrity**:
    *   Participant preview rendering should be isolated from the administrative UI where practical.
    *   Feed publication/removal uses immutable public-feed snapshot/history and a controlled ledger; rollback is tested only in disposable Local execution, not hosted recovery.
    *   Administrative metadata, review, import, publication, and removal operations use implemented atomic database/coordinator boundaries with audit attribution.

---

## 8. Auditability and Transactional Integrity
*   **Staging Actions**: Administrative mapping, review, publication, removal, and archival actions use implemented ledger/audit contracts; hosted human acceptance remains pending.
*   **Atomic Transactions**: Multi-table metadata, review, import, publication, and removal operations are implemented with atomic database/coordinator boundaries and tested repository contracts.

---

## 9. Maintainability Principles
*   **Production Foundation**: The apps directory (`/apps/admin-cms`) is the Next.js production-oriented foundation.
*   **Precedence of Executables**: Current code files, SQL migrations, and Vitest test suites always take precedence over planning prose or legacy documentation.

---

## 10. Backup, Recovery, and Ownership
*   **Institutional Handover**: RMIT/School staff must have full ownership of Render hosting billing, Supabase cloud billing, and GitHub repository admin rights. Participant groups must not own active production keys. Institutional incident-response and recovery ownership is mandatory.
*   **Backups**: An institutionally approved backup cadence, documented retention policy, and periodic restore testing must be aligned with the selected Supabase/service plan.

---

## 11. Prioritized Unresolved Risks
*   **Lack of Staging Key Rotation**: Staging credentials must be rotated immediately if exposed in command logs.
*   **Hosting Performance Latency**: Server availability and cold-start performance must be measured under the selected hosting plan. Unacceptable latency must be addressed before production acceptance.

---

## 12. Security Acceptance Criteria
*   Only authenticated school administrators can perform write requests on the Admin/CMS.
*   The public JSON feed strictly contains approved project data and has zero references to deleted projects or internal notes.
*   All public-facing media URLs use HTTPS and are served from approved storage buckets or approved external media hosts for supported external video links.
