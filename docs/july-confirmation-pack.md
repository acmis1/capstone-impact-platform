# July Confirmation Pack: Stakeholder & Advisor Alignment

This document serves as the official meeting agenda, checklist, and decision register for the Part 2 alignment session in July 2026. It is designed to bridge the planning work completed during the academic break and the active implementation phase.

> [!IMPORTANT]
> **Planning Resource Only**
> This pack organizes open questions and proposed paths into a structured agenda. It does *not* constitute a finalized system specification and will be revised post-meeting based on coordinator and advisor sign-offs.

---

## 1. Purpose
The purpose of the July confirmation meeting is to review the architectural constraints, proposed database models, and operational workflows of the Capstone Impact Platform. Aligning on these items prior to coding ensures that the development team (**RuntimeError**) builds a secure, compliant, and highly maintainable production system matching both academic standards and school staff capabilities.

---

## 2. What is Already Confirmed
The following architectural parameters and constraints have been verified and remain immutable:
*   **No Duda Upgrade**: Upgrading the public showcase Duda subscription is permanently out of scope.
*   **Duda Public Layer Only**: Duda operates strictly as a responsive, public-facing showcase container (public layer only). It does *not* host native databases or dynamic collections.
*   **CMS as Source of Truth**: The custom standalone School-owned Admin/CMS is the absolute operational source of truth.
*   **Approved-Only Public Feed**: Data flows from the Admin/CMS outward to a stable public JSON feed URL, ensuring unapproved drafts or private notes never leak.
*   **Prototype v2 Status**: Prototype v2 represents feasibility evidence only, not the production baseline.
*   **Operational Budget**: Staging and initial deliverables assume a completely free-tier hosting option to be verified later, keeping all break work strictly reversible.

---

## 3. Decisions That Must Be Confirmed Before Implementation

The following table tracks structural decisions that must be resolved in July before the development team writes any production code.

| Decision Area | Proposed Direction | Why It Matters | Who Should Confirm | Risk If Not Confirmed |
| :--- | :--- | :--- | :--- | :--- |
| **Production Schema** | Relational PostgreSQL schema mapping separating projects, media, flags, and approvals. | Enforces data integrity; prevents database corruption compared to Prototype v2 flexible JSON columns. | Academic Advisors | Schema changes during sprints cause complex migrations and lag. |
| **Public Feed Fields** | Adopt the MoSCoW fields schema dividing public fields into required, recommended, and optional groups. | Ensures Duda rendering scripts do not fail when optional media (videos, 3D assets) is missing. | Advisors & Staff | Dynamic showcase pages fail to render, crashing detail layouts. |
| **Poster File Rules** | Require both a public poster preview image (JPG/PNG) and a full poster download file (PDF). | Enhances public loading speeds while preserving high-res academic download options. | Academic Staff | Grid listings become sluggish due to loading oversized raw PDF previews. |
| **Folder Structure** | Ingest standardized project packages: Excel metadata, a `snapshots/` folder, and poster files. | Enables clean, rules-first validation and path parsing logic in the backend. | Academic Staff | Custom student file configurations break the automated parser. |
| **XLSX Template Fields** | Enforce a master spreadsheet template `project-details.xlsx` with strict sheet/column matching. | Staff are familiar with Excel; standardizing columns prevents raw text alignment errors. | Academic Staff | Column updates by coordinators crash the ingestion engine. |
| **Archive & Deletion** | Logical soft-deletion (`deleted_at`) and archived status flags; physical deletes are restricted. | Preserves historical metadata for school audits and grading records, preventing accidental losses. | Advisors & Staff | Accidental clicks permanently destroy student project histories. |
| **Student Confirmation** | Conceptual preview links sent to group emails. Student sign-offs remain optional for MVP. | Decides whether the CMS requires a dedicated student auth portal or basic token links. | Academic Staff | High development overhead if a student login portal is built. |
| **OCR/AI Scope** | OCR text extraction from posters acts as optional, assistive form-fill support only. | Ensures the core publishing engine is deterministic and rules-first, never blocked by AI errors. | Academic Advisors | AI hallucination errors insert invalid metadata into public feeds. |
| **Media Size Limits** | Enforce strict file caps (e.g. posters < 5MB, snapshots < 2MB, videos < 20MB). | Protects free-tier storage limits and ensures the CMS remains responsive on lower bandwidth. | Academic Advisors | Ingestion of massive video files crashes the server and storage. |
| **Public/Private Storage** | Intermediate uploads belong to private buckets; fully approved URLs are public-safe. | Keeps raw details crawlable by search engines secure, satisfying data privacy policies. | Academic Advisors | Sensitive student contact details leak into the public showcase. |
| **Auth & Admin Roles** | Supabase Auth with discrete administrator roles (`coordinator`, `reviewer`). | Prevents unauthorized public agents from deleting records or altering live showcase pages. | Advisors & Staff | Exploits on unsecured routes permit global feed manipulation. |
| **Hosting & Staging** | Select free-tier database and server providers, keeping choices open for future upgrades. | Decides how the team manages free-tier caps (500MB DB caps, cold start mitigation). | Academic Advisors | Early locking blocks migration if the school designates other servers. |
| **Handover Expectations** | Documented codebase handover; modular React/Express code matching school IT systems. | Long-term ownership determines code complexity and developer training deliverables. | School IT / Coordinators | System becomes unmaintainable and legacy post-graduation. |

---

## 4. Advisor-Specific Technical Questions
Academic advisors evaluate architectural resilience, design validation, and software engineering best practices.
*   **Why not use Duda-native collections?**
    *   *Answer*: Implementing dynamic collections natively inside Duda requires a premium subscription plan, which is permanently out of scope. The hybrid JS-payload approach operates at zero additional licensing cost.
*   **Why not use WordPress or a headless CMS?**
    *   *Answer*: Setting up a school-monitored WordPress environment requires substantial IT department hosting clearances and setup delays. A custom Express/React CMS operates within free-tier bounds and is tailored specifically to RMIT's metadata template format.
*   **How will the system avoid exposing internal fields?**
    *   *Answer*: The public feed generator uses a strict compilation routine. It queries the database, strips away all internal properties (staff notes, admin IDs, validation logs), and validation-checks the payload against the 19 public contract schema rules before publishing.
*   **How will access control be handled?**
    *   *Answer*: We will implement Supabase Auth. All administration APIs will require JWT cookie verification, and Supabase database tables will be protected by strict Row-Level Security (RLS) policies.
*   **How will the team test 100+ records?**
    *   *Answer*: We will write Playwright scripts to run headless integration runs, validating listing pages and search loads under heavy feed payloads.
*   **How will the team prove the 50% staff-effort reduction target?**
    *   *Answer*: By logging upload-to-validation time metrics in testing. Parsing an Excel spreadsheet and running instant validation rules replaces copy-pasting 20+ fields manually for every student group.
*   **How will rollback work if the public feed breaks?**
    *   *Answer*: The Admin/CMS archives timestamped snapshots of compiled feeds. If a feed breaks, administrators can perform a one-click rollback from the dashboard to overwrite `capstones-latest.json` with a previous, valid snapshot.
*   **What is prototype-only vs. production-ready?**
    *   *Answer*: Prototype v2 is a single-file Visual proof-of-concept using local JSON storage and unsecured endpoints. Production-ready Part 2 implements MVC modular routing, RLS security, real session auth, logical deletion, and strict JSON Schema validators.

---

## 5. Stakeholder-Specific Workflow Questions
School administrators and coordinators focus on staff workflows, metadata accuracy, and academic policies.
*   **What fields must staff collect?**
    *   Do we require external links (demoUrl, repositoryUrl) for every project, or are they strictly optional?
*   **What files are realistically available from students?**
    *   Can we guarantee that student groups will supply both a poster image (JPG/PNG) and a full-size PDF poster file?
*   **Who approves publication?**
    *   Is publication a batch action run by the course coordinator, or does individual supervisor approval trigger live showcase updates?
*   **Who can archive/unpublish?**
    *   Can both coordinators and reviewers archive public projects, or is archiving restricted to coordinators?
*   **Is student confirmation mandatory or optional?**
    *   Should publication be blocked until students confirm their preview, or can coordinators bypass confirmation to hit showcase deadlines?
*   **What accessibility text should be required?**
    *   Should `accessibilityText` be a mandatory column in the Excel template, throwing a validation warning if missing?
*   **What is acceptable if OCR/AI is not accurate or not approved?**
    *   If AI is restricted or inaccurate, is staff comfortable relying exclusively on the Excel template ingestion model?
*   **How should older projects be migrated?**
    *   Should historical projects be converted into the new Excel format and parsed, or seeded directly into the database?

---

## 6. Proposed Part 2 MVP Boundary

To guarantee delivery within the semester timeframe, the project boundaries are strictly defined:

### Core MVP Deliverables (Must Have)
1.  **Ingestion**: Standard folder import parsing `project-details.xlsx` metadata.
2.  **Asset Management**: Direct, sanitized uploads of posters and snapshots to Supabase.
3.  **Validation**: Rules-first backend checks logging blocking errors and warnings.
4.  **Review Workspace**: Tabbed Admin panel form to edit metadata and correct warnings.
5.  **Approval Loop**: Transitioning verified drafts to "Approved".
6.  **CDN Compilation**: Generates clean public-safe JSON feeds to a stable storage bucket.
7.  **Duda Integration**: Footer script (`bodyend.html`) dynamically rendering listings and detail cards.
8.  **Archival**: Logical unpublishing and soft-deletion.
9.  **Handover**: Clean developer documentation and standard operations guides.

### Excluded / Future Deliverables (Out of Scope for MVP)
*   **Public Voting**: Student or visitor upvoting, likes, or commenting feeds.
*   **Advanced AI/OCR**: Automated PDF parsing and LLM auto-fills (remains conceptual only).
*   **Student Portal**: Interactive student-facing login dashboards.
*   **Automated Email Systems**: Third-party mail client integrations (replaces with message copy-templates in CMS).
*   **3D Assets / 3D Model Rendering**: Showcase interactive WebGL viewers (handled as custom iframe links).
*   **Full Business Analytics**: Statistics reporting panels in the CMS.

---

## 7. July Meeting Agenda
A proposed 50-minute structured agenda to resolve all blockers:

*   **00 - 05 min**: Recap confirmed constraints (No Duda upgrade, CMS as source of truth).
*   **05 - 15 min**: Confirm workflow lifecycle, admin roles, and unpublishing rules.
*   **15 - 25 min**: Confirm database schema entities and public feed allowed fields.
*   **25 - 35 min**: Confirm student folder rules, XLSX columns, and media size limits.
*   **35 - 45 min**: Confirm MVP boundaries, exclude advanced OCR/voting, and review risks.
*   **45 - 50 min**: Agree on Sprint 1 priorities and lock the confirmation packs.
