# Project Architecture and Constraints

This document defines the core architecture, data flows, and immutable technical boundaries governing the Capstone Impact Platform.

---

## 1. Purpose and Status
*   **Status**: `CONFIRMED` / `IMPLEMENTED FOUNDATION`
*   **Purpose**: Establish the architectural framework to bridge school-managed project data with the public Duda showcase. Schema, repository, storage, validation, publication/removal, and public-renderer foundations are implemented and tested. Active staging-v2 has verified 52-migration structural evidence and a bounded exact-SHA application smoke. The authorized Duda TEST editor now has the repository renderer saved and has passed bounded synthetic data-backed acceptance; hosted multi-role human UAT, recovery, monitoring, institutional ownership, Duda cutover, and production acceptance remain pending.

---

## 2. System Context
The platform is designed to support at least **100 projects per year** and remain operational for **5–10 years**. The primary administrative users are non-technical school staff. Account and recovery ownership must remain institutional rather than tied to any individual participant.

---

## 3. Architecture Components
*   **Duda Public Showcase Layer** (`VERIFIED_TEST` / `TEST_SITE_DATA_BACKED_ACCEPTANCE`): The maintained `apps/public-layer/duda/` renderer is a responsive public presentation shell with tested listing/detail/search behavior. The synthetic acceptance used the governed staging feed; live Duda/Impact publication was not performed.
*   **School-Owned Admin/CMS** (`IMPLEMENTED FOUNDATION` under `apps/admin-cms`): A standalone Next.js and TypeScript application which serves as the absolute operational source of truth.
*   **Supabase Database & Storage** (`IMPLEMENTED FOUNDATION`): PostgreSQL database storing admin records and public assets.
*   **Approved-Only Public Feed** (`IMPLEMENTED FOUNDATION`): A schema-validated JSON payload (`capstones-latest.json`) compiled and written to a stable public Storage bucket.

---

## 4. Data and Publication Flow
The overall data lifecycle is structured as follows:

```
Standard Project Package / Excel
   └── Ingestion & Parsing
   └── Rules-First Deterministic Validation
   └── Assistive OCR and AI Metadata Extraction
   └── Admin Excel Cross-Check & Review (CMS Dashboard)
   └── Generate Participant Preview & Send Preview Email
   └── Email Reminder Scheduling
   └── Participant Confirmation / Correction Request (Participant Preview)
   └── Human Administrative Review & Approval (Staging status update)
   └── Compilation (Administrative data stripped)
   └── Approved-Only Public Feed JSON Publish
   └── Duda Client-side Listing & Detail Rendering
   └── Post-Publishing: Archive / Unpublish / Failure Recovery
```

---

## 5. Environment and Repository Isolation
*   **Prototype Isolation**: Historical/feasibility material under `/Prototype` is isolated and immutable for current public-layer work. The maintained Duda renderer and contract harness live under `/apps/public-layer`; it must not share code or helper modules with `/apps/admin-cms`.
*   **Supabase Project Isolation**: The Prototype recovery project uses its own Supabase instance. The Admin/CMS active staging target is `capstone-admin-cms-staging-v2-2026` and must **never** connect to or use the Prototype recovery Supabase project.

---

## 6. Duda Constraints
*   **Duda Configuration and Arrangements**: No Duda upgrade has been approved. Duda native collections cannot be relied upon for the required scale of 100+ projects per year under the available arrangement. The repository solution uses an external approved-only JSON feed and client-side listing/detail rendering, including tested Year, Program, Discipline, Industry Sector, and public-field search. The authorized Duda TEST editor now has the saved search renderer and passed bounded synthetic acceptance; production/live Duda cutover remains unperformed. These integration-specific IDs are implementation details, not permanent public API promises.
*   **Verification Boundary**: The team currently has access only to an authenticated Duda TEST site. The official RMIT production website was not provided or verified, and no live Duda publication is claimed.

---

## 7. Data Privacy and Accessibility Constraints
*   **Media Separation**: Intermediate participant drafts and Excel templates containing sensitive participant contact details must be stored in secure, private storage buckets with restricted access.
*   **Public Assets**: Only fully validated, approved project assets (posters, snapshot images, PDFs) may be written to public storage buckets and made available through approved public URLs.
*   **Administrative Stripping**: The public JSON feed must strictly omit validation logs, internal comments, draft status flags, or raw folder structures.

---

## 8. AI/OCR Operating Principles
*   **Assistive Only**: AI-assisted validation and OCR poster-text extraction are mandatory capabilities. However, their output is strictly assistive and **must never** bypass human administrative review.
*   **Mandatory AI-Assisted Validation Capabilities**: The platform must explicitly support AI-assisted validation and OCR poster-text extraction, including: duplicate detection, spelling and grammar assistance, formatting validation, title consistency, image/text consistency assistance, OCR poster-text extraction, reviewed full-text accessibility alternatives, deterministic/manual fallback, and mandatory human review.
*   **Deterministic Fallback**: If the AI/OCR engine is slow, offline, or returns errors, the CMS must remain fully functional via deterministic rules and manual staff entry.
*   **Institutional Governance**: The use of AI APIs must respect institutional data residency, budget limits, and privacy policies.

---

## 9. Operational Ownership and Handover
*   **Institutional Control**: System credentials, API tokens, Supabase database access, and Render hosting accounts must belong to institutional email aliases managed by RMIT/School staff.
*   **Handover Criteria**: Graduation or transition of participant development groups must not impact system availability or administrative access.

---

## 10. Current Verified State
*   The `main` branch is the repository source of truth. Verified deployment commits and historical promotion SHAs are recorded in the Prototype recovery/deployment runbooks and Git history.
*   The latest verified Admin/CMS Render staging application baseline (2026-09-08) is deployment `dep-dafimfn9l3cc73c8blog` at deployed commit `50d02632f4403f3acb5620d6b9a2e482e8ac5688`; bounded read-only health/readiness checks passed, readiness was `READY`, the canonical feed was `[]`, and the publication gate was restored to disabled. Later documentation-only repository commits do not by themselves change this deployed application baseline. This is not production, recovery, monitoring, or human-acceptance evidence.
*   Duda TEST has `TEST_SITE_DATA_BACKED_ACCEPTANCE` for one synthetic project: listing, public-field search, all four facets, reusable detail navigation, and populated-listing mobile no-overflow passed; governed cleanup removed the project from the TEST presentation. The detail screenshot proves navigation only, not mobile detail accessibility.
*   Initial administrator authentication (`auth.users` -> `admin_users`), `bootstrap_initial_admin` execution (`CREATED`), `npm run check:admin-auth` (`READY_FOR_MANUAL_LOGIN_TEST`), and dashboard login/logout on `capstone-admin-cms-staging-2026` are historical activation evidence. The active target is staging-v2.

---

## 11. Mandatory versus Optional Capabilities

### A. Mandatory Capabilities
*   **Bulk Folder/Excel Ingestion**: Importing a standard project folder/package structure with `project-details.xlsx` via a bulk import workflow.
*   **Rules-First Validation**: Automated validation checks on image dimensions, file size limits, and required fields.
*   **Admin Excel Cross-Check**: Matching Excel metadata columns against structured PostgreSQL tables.
*   **OCR-Assisted Extraction**: Extracting poster text automatically to create reviewed text alternatives.
*   **Participant Final-Preview Confirmation**: Providing participants a preview link, sending notification emails, and scheduling reminders.
*   **Participant Correction Requests**: Allowing participants to submit specific feedback if data is wrong.
*   **Human Administrative Approval**: A school staff member must review and approve records before publishing.
*   **Approved-Only Public Feed**: Stripping administrative metadata and updating the stable JSON feed.
*   **Search & Dynamic Filters**: Repository public-renderer search plus metadata filtering (Year, Program, Discipline, Industry) is implemented and tested; the authorized Duda TEST configuration passed bounded synthetic acceptance, while production/live cutover remains pending.
*   **Archive/Unpublish Flows**: Safe archival of database records and removal of projects from the public feed.
*   **Measurement Metrics**: Demonstrating, on the same comparable cohort, at least a **50% end-to-end elapsed publishing-time reduction and at least a 50% human-manpower reduction measured in total person-hours** compared with the current manual workflow. Both independent thresholds must pass; neither result may compensate for the other. The [manual efficiency instrument](templates/release-evaluation-manual-efficiency.md) is currently unfilled, so BRIEF-SC01 remains `NOT MEASURED`.

### B. Optional Capabilities
*   **Community Voting**: Public participant voting or feedback modules (Voting must remain optional and outside the critical publishing path).

---

## 12. Remaining Open Institutional Decisions
*   **AI/OCR API Vendor & Privacy Terms**: Approval of the third-party LLM/OCR endpoint.
*   **Retention Period**: Policy regarding how many semesters of data are kept in storage before archiving.
*   **Institutional SMTP Arrangement**: SMTP server credentials for sending participant preview emails.
*   **Handover Owner**: The designated school administrator who will own repository and cloud credentials post-handover.
