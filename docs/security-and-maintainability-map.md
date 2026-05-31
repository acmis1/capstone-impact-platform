# Security and Maintainability Map: Prototype v2

This document provides a read-only audit and threat model of **Prototype v2** for the Capstone Impact Platform. The purpose of this mapping is to discover and document security considerations, technical debt, and architectural patterns to guide the Part 2 planning phase.

> [!NOTE]
> **Accuracy Note & Planning Focus**
> This map is a planning risk register. It identifies potential risks and hardening needs based on the initial codebase of Prototype v2. It should not be read as a claim that every risk is currently exploitable in the exact stated form. In accordance with break constraints, no code changes, staging database adjustments, or active security patches are to be implemented during the semester break.

---

## 1. Overview
Prototype v2 successfully demonstrated the feasibility of the decoupled hybrid publishing architecture: a standalone Node/Express server and React/Vite frontend managing projects, parsing metadata spreadsheets (`project-details.xlsx`), and publishing validated approved-only JSON feeds to a stable Supabase public storage bucket.

Because the prototype was built to demonstrate visual feasibility and core workflow viability, security hardening and modular maintainability are planned as key objectives for the Part 2 production development. This document registers endpoints, data flows, and code structures to establish a robust backlog for the upcoming production phase.

---

## 2. Endpoint and Data-Flow Map

The following map outlines the functional endpoints and operational data flows within the Prototype v2 codebase, tracing inputs, processing logic, and potential areas for hardening.

| Area / Endpoint or File | Input Source | Processing / Logic Performed | Output or Side Effect | Security Consideration | Production Recommendation (Part 2) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`GET /api/projects`** | Public network request. | Queries all project records from the Supabase `projects` database table. | Returns the full raw project JSON array. | **Data Exposure**: Internal metadata, admin flags, and staff notes are visible to client queries. | Return a restricted public view; implement session authentication to view raw admin fields. |
| **`POST /api/import-folder`** | `multer` multipart upload (folder structure). | Receives multipart folder-upload files and a relative-path manifest. Parses XLSX/CSV/JSON metadata where present. ZIP import is not the current primary workflow. | Writes assets to Supabase Storage; inserts intermediate project draft records. | **Resource Utilization**: Large file uploads buffer in memory; folder structures processed synchronously. | Enforce direct-to-storage pre-signed client uploads; process imports asynchronously in a queue. |
| **`POST /api/publish-cloud-feed`** | API request with admin key header validation. | Compiles approved/published records, generates feed file, and pushes it to Supabase Storage. | Overwrites public `capstones-latest.json` on Supabase Storage; updates status to 'published'. | **Access Verification**: Bypassing admin access key configuration allows unauthenticated publishing triggers. | Require administrative signatures and robust session verification before running feed sync. |
| **`DELETE /api/projects/:id`** | API request with ID parameter (Safe Delete). | Enforces safety checks to verify that the imported CMS review record is not public or approved, then deletes it. | Hard delete of targeted CMS project review records that match safety criteria. | **Validation Bypass**: Bypassing delete blocker checks could delete active draft metadata. | Implement soft-delete workflows (e.g. `archived_at` flags); enforce robust authentication checks. |
| **`DELETE /api/projects/:id/permanent-delete`** | API request with ID parameter (Permanent Delete). | Verifies status is draft or archived, ensures it is not in the public feed, then deletes record. | Hard delete of archived or draft CMS project records. | **Accidental Loss**: Permanent delete lacks a temporary trash recovery flow. | Transition to logical deletion; implement admin-only restore capabilities. |
| **Duda Body-End Script (`bodyend.html`)** | Static CDN or Duda footer injection. | Fetches the public JSON feed; parses URL query parameters; generates DOM elements dynamically. | Updates the Duda site DOM with student showcase layouts. | **Residual DOM Injection / Unsafe URL Risk**: Potential script execution or media link hijacking if feed values are malformed. | Sanitize incoming JSON fields before DOM creation; enforce strict feed-level validation before publish. |

---

## 3. Security Risk Map

The table below catalogs specific security considerations in the Prototype v2 codebase, rating severity and detailing recommendations.

| Risk | Current Prototype Evidence | Severity | Why It Matters | Production Recommendation (Part 2) | Fix Before Staging? |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Service Role Key Usage** | `projectStore.js` uses `SUPABASE_SERVICE_ROLE_KEY` for database queries. | **High** | Bypasses Row-Level Security (RLS). A compromise of the backend server yields full access to the database. | Restrict database connections to standard authenticated client roles; enforce strict RLS policies. | **Yes** |
| **Authentication & Authorization** | Simple `adminAuth` middleware validates `ADMIN_ACCESS_KEY` via `x-admin-key`. | **Medium** | If the key is unconfigured in the environment, the server allows all requests for local development convenience. | Implement production-grade authenticated sessions, role-based access control, and server-side authorization. | **Yes** |
| **Path Traversal Handling** | `server.js` normalizes paths and rejects absolute, drive-letter, `.` or `..` segments. | **Low** | Basic protection exists; however, hardening is required to prevent bypasses on edge-case path inputs. | Perform canonical path validation using standard system modules; enforce strict filename sanitation rules. | **Yes** |
| **Upload File Type Validation** | Checks files using basic case-insensitive extension matching (e.g., `.png`, `.jpg`). | **Medium** | Relies on extensions; users could spoof file types to upload arbitrary HTML scripts disguised as images. | Implement binary signature (magic number) verification to detect the true file formats. | **Yes** |
| **Upload File Size Limits** | `multer` is configured with a `fileSize` limit of 100MB and `files: 250`. | Low | The prototype also has a 50MB warning threshold. Production still needs stricter per-asset-type limits and possibly an aggregate batch-size policy for free-tier operation. | Configure strict per-file and per-file-type size limits (e.g., posters < 5MB) tailored for free-tier storage. | **Yes** |
| **Public/Private Separation** | Imported media assets are uploaded before final publication. | **Medium** | Public/private asset separation is not production-hardened, potentially exposing intermediate media. | Separate draft/private media from approved public media; ensure only approved public URLs enter the Duda feed. | **Yes** |
| **XSS / HTML Injection** | Duda script escapes many text fields using `escapeHTML()`, but builds strings via `innerHTML`. | **Medium** | Residual DOM injection or unsafe URL risks remain for image sources, URL fields, and links. | Use safe client DOM construction where practical; enforce rigorous feed-level schema validation. | **Yes** |
| **CORS Configuration** | Backend uses default permissive CORS configuration via `app.use(cors())`. | Medium | Enables cross-origin scripts to access local endpoints if authorization keys are not active. | Restrict allowed origins to the verified admin frontend/public integration domains. | **Yes** |
| **Plain localPreview Wrapper** | Frontend preview loads layout presets inside raw div elements in the CMS. | **Medium** | Student-supplied CSS styles can bleed into the admin console, altering the dashboard UI. | Sand-box the draft previews inside an `<iframe>` with strict `sandbox` permissions active. | **Yes** |
| **Hard Database Deletion** | Safe and permanent delete endpoints perform SQL deletes. | **Medium** | Accidental administrative clicks lead to non-recoverable database losses without backup restoration. | Transition to a soft-delete status pattern (e.g., `deleted_at`) with trash bin recovery options. | **Yes** |
| **Lack of Audit Logs** | Actions (e.g., publishing feed updates) lack persistent identity logs in the database. | **Medium** | Prevents staff from auditing who performed edits or approved submissions. | Implement a dedicated `audit_logs` table tracking the administrator ID, action, and timestamps. | **No** |

---

## 4. Maintainability Risk Map

The table below catalogs technical debt and structural maintainability considerations identified in the codebase.

| Area | Current Issue | Impact | Recommended Part 2 Action |
| :--- | :--- | :--- | :--- |
| **Monolithic React App** | `src/App.jsx` exceeds 196 KB (4,000+ lines), mixing forms, layout templates, CSS, and states. | High developer cognitive load; complex to refactor or unit test. | Split the monolith into modular directories (e.g., `/components`, `/pages`, `/hooks`). |
| **Hashing Logic Duplication** | FNV-1a deterministic hashing logic is duplicated between `App.jsx` and `server.js`. | Synchronization bugs if one hashing helper is modified while the other remains unchanged. | Extract hashing and slug sanitizers into a shared utility file accessible by both client and server. |
| **Documentation Duplication** | Duplicate files (e.g., `duda-integration-plan.md`) exist in `/docs` and `/Prototype/docs`. | Developer confusion regarding the active project plan. | Lock `/Prototype/docs` as historical prototype evidence; declare root `/docs` as the single active source. |
| **Flexible JSON Column** | Supabase table stores full project schema in a single JSONB database column. | Incomplete inputs can insert without strict constraint failures, breaking frontends later. | Enforce rigid backend JSON Schema Validation (e.g., using `Ajv`) before database write triggers. |
| **Monolithic server.js** | Single backend file handles routing, CSV/XLSX decoding, asset management, and Supabase integration. | Difficult to maintain and write unit tests for. | Decouple backend routes into an MVC pattern: routers, controllers, validators, and core services. |

---

## 5. Safe Part 2 Recommendations

When the academic break concludes and the Part 2 phase officially launches in July 2026, the team should execute these safety steps (do *not* implement these now):

1.  **Introduce Authentication & Role-Based Access Control**:
    Integrate Supabase Auth on the Express backend, blocking all API endpoints behind token validation middleware. Assign strict roles (`coordinator`, `reviewer`) to distinguish administrative capabilities.
2.  **Design Production Database Schema**:
    Introduce strict PostgreSQL table constraints on critical columns (e.g. ID patterns, status enums) to prevent database pollution.
3.  **Establish Media Handling and Public/Private Asset Separation**:
    Separate data storage paths: intermediate review drafts are written to private buckets, while fully approved showcase images are made available through approved public asset URLs.
4.  **Enforce Strict Public Feed Schema**:
    Integrate an automated JSON Schema validation gate in the publishing transaction loop. If a feed fails the 19-field validation, halt the sync.
5.  **Decouple and Modularize the Codebase**:
    *   Split the massive `App.jsx` into standalone React pages and reusable components.
    *   Migrate the single `server.js` into modular routes and services (e.g., `/routes/import.js`, `/services/xlsxParser.js`).
6.  **Implement Safe Sandbox Previews**:
    Load student local layout previews exclusively within sandboxed `<iframe>` tags in the CMS frontend.
7.  **Establish Backup and Rollback Procedures**:
    Establish database backup, feed snapshot, and rollback procedures; keep hosting performance/cold-start evaluation as a separate deployment concern to be verified later.

---

## 6. Do-Not-Do List for the Break

To protect the integrity of the project during the academic break, the following actions are strictly prohibited:

*   **Do NOT patch production logic**: Keep all codebase changes documentation-only and fully reversible.
*   **Do NOT deploy code**: Do not deploy code or push schema migrations to staging or production environments.
*   **Do NOT modify Duda settings**: Keep the live showcase presentation completely isolated.
*   **Do NOT alter Supabase configurations**: Do not add keys, change database RLS, or adjust bucket structures in the online dashboard.
*   **Do NOT lock final vendors**: Keep final hosting options, OCR/AI providers, and email providers open and free-tier first until July confirmations.
