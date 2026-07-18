# Project Architecture and Constraints

This document defines the core architecture, data flows, and immutable technical boundaries governing the Capstone Impact Platform.

---

## 1. Purpose and Status
*   **Status**: `CONFIRMED` / `IMPLEMENTED FOUNDATION`
*   **Purpose**: Establish the architectural framework to bridge school-managed project data with the public Duda showcase. The foundation for the standalone admin system has been implemented, and the feasibility prototype has been successfully verified.

---

## 2. System Context
The platform is designed to support at least **100 projects per year** and remain operational for **5–10 years**. The primary administrative users are non-technical school staff. Account and recovery ownership must remain institutional rather than tied to any individual student.

---

## 3. Architecture Components
*   **Duda Public Showcase Layer** (`VERIFIED PROTOTYPE`): Acts strictly as a responsive, public-facing presentation shell.
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
   └── Generate Student Preview & Send Preview Email
   └── Email Reminder Scheduling
   └── Student Confirmation / Correction Request (Student Preview)
   └── Human Administrative Review & Approval (Staging status update)
   └── Compilation (Administrative data stripped)
   └── Approved-Only Public Feed JSON Publish
   └── Duda Client-side Listing & Detail Rendering
   └── Post-Publishing: Archive / Unpublish / Failure Recovery
```

---

## 5. Environment and Repository Isolation
*   **Prototype Isolation**: The Prototype is isolated historical/feasibility evidence. It resides under `/Prototype` and must never share code or helper modules with `/apps/admin-cms`.
*   **Supabase Project Isolation**: The Prototype recovery project uses its own Supabase instance. The production-oriented Admin/CMS must use the separate `capstone-impact-staging` environment and must **never** connect to or use the Prototype recovery Supabase project.

---

## 6. Duda Constraints
*   **No Duda Upgrade**: Upgrading the Duda account subscription or site plan is permanently out of scope.
*   **Dynamic Rendering**: Since Duda dynamic pages/collections are unsupported under the active plan, all dynamic grids are rendered inside the listing root `#capstone-showcase-root` (generating the grid structure at `#capstone-project-grid`), and detail sections are rendered at `#project-detail` via JavaScript (`bodyend.html`) in Duda's footer. These integration-specific IDs are current Prototype Duda integration details, not permanent public API promises.
*   **Verification Boundary**: The team currently has access only to an authenticated Duda test site. The official RMIT production website was not provided or verified.

---

## 7. Data Privacy and Accessibility Constraints
*   **Media Separation**: Intermediate student drafts and Excel templates containing sensitive student contact details must be stored in secure, private storage buckets with restricted access.
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
*   **Handover Criteria**: Graduation or transition of student development groups must not impact system availability or administrative access.

---

## 10. Current Verified State
*   The `main` branch is the repository source of truth (HEAD: `4a3b0d0aa7f7a4cabe70808db8306ec98b2a685f`).
*   The Render Prototype service is verified Live with HTTP 200, serving 10 internal projects and 6 public-feed projects.
*   The Duda authenticated test-site listing and detail pages have been manually verified by the user as functional.

---

## 11. Mandatory versus Optional Capabilities

### A. Mandatory Capabilities
*   **Bulk Folder/Excel Ingestion**: Importing a standard project folder/package structure with `project-details.xlsx` via a bulk import workflow.
*   **Rules-First Validation**: Automated validation checks on image dimensions, file size limits, and required fields.
*   **Admin Excel Cross-Check**: Matching Excel metadata columns against structured PostgreSQL tables.
*   **OCR-Assisted Extraction**: Extracting poster text automatically to create reviewed text alternatives.
*   **Student Final-Preview Confirmation**: Providing students a preview link, sending notification emails, and scheduling reminders.
*   **Student Correction Requests**: Allowing students to submit specific feedback if data is wrong.
*   **Human Administrative Approval**: A school staff member must review and approve records before publishing.
*   **Approved-Only Public Feed**: Stripping administrative metadata and updating the stable JSON feed.
*   **Search & Dynamic Filters**: Custom frontend search and metadata filtering (Year, Program, Discipline, Industry).
*   **Archive/Unpublish Flows**: Safe archival of database records and removal of projects from the public feed.
*   **Measurement Metrics**: Demonstrating at least a **50% publishing time or manpower reduction** compared to manual Duda page creation.

### B. Optional Capabilities
*   **Community Voting**: Public student voting or feedback modules (Voting must remain optional and outside the critical publishing path).

---

## 12. Remaining Open Institutional Decisions
*   **AI/OCR API Vendor & Privacy Terms**: Approval of the third-party LLM/OCR endpoint.
*   **Retention Period**: Policy regarding how many semesters of data are kept in storage before archiving.
*   **Institutional SMTP Arrangement**: SMTP server credentials for sending student preview emails.
*   **Handover Owner**: The designated school administrator who will own repository and cloud credentials post-handover.
