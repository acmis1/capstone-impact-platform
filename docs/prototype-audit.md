# Prototype Audit & Code Review

This document provides a comprehensive audit of the **Prototype v2** codebase, evaluating its components, identifying structural and security gaps, and determining the reuse strategy for the production-ready Part 2 deployment.

---

## 1. Prototype Component Audit

The table below outlines each functional area of Prototype v2, evaluates the current code evidence, determines the reuse classification, details gaps, and highlights outstanding risks.

### Reuse Labels Definitions
*   `keep concept`: The architectural approach is excellent and should be reimplemented/followed, but the specific prototype code should be written from scratch or heavily adapted.
*   `reusable with caution`: The code is mostly functional but requires hardening, security updates, or minor refactoring before production.
*   `prototype-only`: The code is a hardcoded mock or a temporary scaffold and must be entirely replaced in production.
*   `needs redesign`: The logic or architecture has fundamental flaws that must be redesigned for security, performance, or operational reliability.

| Area | Current Prototype Evidence | Reuse Decision | Production Gap | Risk |
| :--- | :--- | :--- | :--- | :--- |
| **React/Vite frontend** | Monolithic Single-Page App (`src/App.jsx`) containing dashboard, list, forms, and imports. | `needs redesign` | Needs component modularization, state management (e.g., Context/Zustand), styling optimization, routing, and access control. | High. Maintaining a single 4,000+ line JSX file is unsustainable and highly error-prone. |
| **Node/Express backend** | Single `server.js` orchestrating file uploads, Excel parsing, API routes, and database triggers. | `needs redesign` | Needs standard MVC structure, route authorization middleware, standard validation layers, and separation of services. | High. Lacks basic authentication, making administrative API endpoints completely exposed. |
| **Supabase project table storing flexible JSON data** | Database table storing projects with structured IDs and an unstructured `data` JSONB column. | `keep concept` | Requires stricter check constraints on core JSON fields (like status) to prevent invalid values. | Low. Excellent design for handling semester-by-semester schema variations. |
| **Supabase Storage media upload** | Single bucket upload helper in `utils/projectStore.js` using service role keys. | `reusable with caution` | Needs transition to client-side pre-signed URLs or proper Row-Level Security (RLS) policies instead of relying on the administrative service role key on the backend. | Medium. Service role keys bypass all security; compromise of the backend compromises the entire Supabase instance. |
| **folder import** | Form uploads supporting full project folders with nested files. | `reusable with caution` | Needs direct-to-storage chunked or pre-signed uploads instead of buffering entire files in Express memory. | Medium. Uploading very large files can crash Express server instances due to memory exhaust. |
| **batch import** | Backend loop processing multiple ZIP/folder packages simultaneously. | `reusable with caution` | Needs asynchronous queue processing (e.g., job queues) instead of blocking the main Express event loop. | High. A large batch import blocks the single-threaded Node server, causing timeout errors for other active users. |
| **XLSX metadata parsing** | Ingestion of metadata using the `xlsx` library in `server.js` with structured mappings. | `reusable with caution` | Needs rigorous cell type checks, missing sheet handling, and user-friendly parsing error report generation. | Medium. A malformed Excel sheet can throw uncaught runtime exceptions, crashing the backend. |
| **path safety checks** | Basic regex checking for directory traversal or malicious characters in file names. | `reusable with caution` | Needs production-grade sanitation libraries (e.g., `path` module resolution checks) to prevent relative path escapes. | High. Inadequate directory traversal checks can allow arbitrary file writes or execution. |
| **file type/size checks** | Hardcoded size checks (e.g., PDF size limit) and basic MIME type filters during import. | `reusable with caution` | Move hardcoded file sizes to environment configuration; utilize strict magic-number file signature validation. | Low. Basic checks are present but easily bypassed by changing file extensions. |
| **validation warnings/errors** | Rules-based list of checks stored in project record metadata (e.g., warning if snapshot counts < 2). | `keep concept` | Needs translation into a formalized, reusable validation engine in the backend shared with frontend. | Low. Conception is solid; validation feedback is crucial for staff review. |
| **edit/review workspace** | Direct metadata editing form in React dashboard with status updates. | `reusable with caution` | Form needs modularization into tabs; auto-saving, and change conflict prevention when multiple staff edit a record. | Medium. Simultaneous edits will overwrite each other silently without lock mechanics. |
| **bulk approval** | Interactive workflow allowing selection and state transition of approved items to published. | `reusable with caution` | Needs single-transaction database execution for batch operations to prevent partial failures. | Medium. Network drops can leave some projects marked "Approved" and others "Published". |
| **safe deletion** | Action menu triggers that delete project records from the table. | `keep concept` | Needs a soft-delete mechanism (e.g., setting `deleted_at`) rather than hard database deletes. | High. Accidental database deletion results in permanent loss of metadata and uploaded files. |
| **archive/unpublish** | Status toggles to move active projects to the "Archived" state, stripping them from the public feed. | `keep concept` | Needs strict audit logging to record who archived the project and why, and immediate cache invalidation. | Low. Core workflow logic is correct. |
| **local preview** | Renders HTML markup inside the Admin CMS using local project state. | `reusable with caution` | Needs sandboxed `<iframe>` wrapper to prevent student custom HTML/CSS injections from running scripts in the admin context. | High. Potential Cross-Site Scripting (XSS) vulnerability if student project details contain malicious `<script>` tags. |
| **layout presets** | CSS/HTML options mapped to data structures (e.g., Single Poster, Snapshot Slider). | `keep concept` | Needs strict schema definition so that layout changes in the feed are parsed gracefully by Duda. | Low. The aesthetic concept is correct. |
| **public feed generation** | Backend endpoint filtering database for approved/published records and stripping internal fields. | `keep concept` | Needs automated schema enforcement (e.g., JSON Schema validator) prior to output generation. | Low. The implementation concept is highly secure as it filters internal notes. |
| **feed schema validation** | Node script (`scripts/validate-feed.js`) checking output against schema requirements. | `reusable with caution` | Integrate directly into the CI/CD pipeline and the publishing transaction loop instead of a manual script. | Low. Script is effective but should be automated. |
| **Duda bodyend.html rendering** | Injected JavaScript that intercepts the page and renders elements dynamically. | `keep concept` | Script must be modularized, minified, and optimized for SEO crawler execution (e.g., pre-rendering fallback). | Medium. Performance latency at runtime on slower devices due to dynamic DOM injection. |
| **stable Duda feed URL** | Hardcoded Supabase public bucket URL inside `bodyend.html`. | `reusable with caution` | Feed URL must be easily configured via a CDN or DNS redirect to avoid site updates if hosting changes. | Medium. Changes in Supabase hosting would require manual body-end edits on Duda side. |
| **root `/docs` vs `/Prototype/docs` duplication** | Duplicate versions of design decisions and workflows exist in both locations. | `needs redesign` | Establish `/docs` at the root as the master source of truth. Leave `/Prototype/docs` intact as history. | Low. Minor developer confusion, resolved by explicitly declaring `/docs` as master. |

---

## 2. Documentation Duplication & Conflict Analysis

An analysis of the repository reveals documentation folder structures are split between `/docs` and `/Prototype/docs`. 

*   **Identified Duplications**:
    *   `duda-integration-plan.md` resides in both directories. The `/docs/duda-integration-plan.md` represents a slightly older draft compared to the detailed script steps inside `/Prototype/docs/duda-integration-plan.md`.
    *   `prototype-notes.md` is duplicated, with `/Prototype/docs/prototype-notes.md` containing more detailed setup and demo script guidelines.
*   **Resolution Strategy**:
    *   **Strict Preservation**: Under no circumstances will documents in `/Prototype/docs/` be deleted. They serve as immutable evidence of Prototype v2 feasibility (which is feasibility evidence only, not the production baseline) presented to stakeholders and academic advisors.
    *   **Unified Master Directory**: Moving forward, the `/docs/` folder in the root of the repository is declared the **master source of truth** for all architectural, constraints, planning, and backlog documentation.
    *   **Conflict Documentation**: This audit file explicitly records these duplications so developers in Part 2 understand that root `/docs/` holds the active plans while `/Prototype/docs/` contains archive records of the initial prototype build.
    *   **Safety Lock Policy**: **No Duda-facing changes should be made during the break; current Duda prototype evidence must be preserved and reconfirmed in July.** All break work is strictly reversible and free-tier first.
