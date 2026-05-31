# Security and Maintainability Map: Prototype v2

This document provides a read-only audit and threat model of **Prototype v2** for the Capstone Impact Platform. The purpose of this mapping is to discover and document security vulnerabilities, technical debt, and architectural risks to guide the Part 2 planning phase. 

> [!IMPORTANT]
> **Read-Only Audit Scope**
> This map is for planning and audit purposes only. In accordance with break constraints, no code changes, staging database adjustments, or active security patches are to be implemented during the semester break.

---

## 1. Overview
Prototype v2 successfully demonstrated the core hybrid publishing architecture: a decoupled Node/Express server and React/Vite frontend managing projects, parsing metadata spreadsheets (`project-details.xlsx`), and publishing clean, approved-only JSON feeds to a stable Supabase public storage bucket.

However, because the prototype was built to demonstrate visual feasibility and core workflow viability, security and modular maintainability were secondary priorities. This document registers all endpoints, data flows, and code structures to establish a robust hardening backlog for the Part 2 production development.

---

## 2. Endpoint and Data-Flow Map

The following map outlines every functional endpoint and operational data flow within Prototype v2, tracing inputs, processing logic, and potential security vulnerabilities.

| Area / Endpoint or File | Input Source | Processing / Logic Performed | Output or Side Effect | Security Concern | Production Recommendation (Part 2) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`GET /api/projects`** | Public network request. | Queries all project records from the Supabase `projects` database table. | Returns full raw project JSON array. | **Data Leakage**: Exposes internal admin notes, supervisor flags, and workflow audit histories to the public. | Return restricted public view; implement token-based session auth to view raw admin data. |
| **`POST /api/import`** | `multer` multipart upload (ZIP/folders). | Decodes uploaded ZIPs/folders, parses XLSX metadata defensively, reads media paths, runs rules-first validation checks. | Writes assets to public Supabase Storage bucket; inserts intermediate project draft records. | **Denial of Service (DoS) & Traversal**: Buffers large files directly in memory; vulnerable to relative path bypasses. | Enforce direct-to-storage pre-signed client uploads; process imports inside an asynchronous job queue. |
| **`POST /api/publish`** | Public API call. | Queries approved records, strips internal fields, updates statuses, pushes updated JSON feed to public storage. | Overwrites public `capstones-latest.json` on Supabase Storage. | **Unauthorized Publishing**: Anyone can trigger a global showcase sync, potentially publishing unapproved drafts or deleting feed data. | Require administrative signatures and authenticated route sessions before running feed compilation. |
| **`DELETE /api/projects/:id`** | Public network request with ID parameter. | Performs a hard database delete of the target ID record in Supabase. | Permanent deletion of project database records and referenced assets. | **Accidental/Malicious Loss**: Bypasses any confirmation or trash collection; open to arbitrary parameter manipulation. | Implement soft-delete flow (e.g. `archived_at` flags); enforce strict administrative credential checks. |
| **Duda Body-End Script (`bodyend.html`)** | Static CDN or Duda footer inject. | Runtime fetch of the public JSON URL; client-side route routing; dynamic DOM generation of details/listing grids. | Updates the Duda site DOM with dynamic student showcase assets. | **DOM Manipulation / XSS**: Student-supplied text (HTML/JS) rendered dynamic on the showcase domain. | Sanitize all incoming JSON string cells prior to dynamic element creation; use secure text node builders. |
| **`GET /api/published-feed-status`** | Public API call. | Fetches metadata about the last feed compile. | Details the current public hash and template counts. | **Information Disclosure**: Exposes internal build variables to unauthenticated agents. | Restrict endpoint behind administration authorization guards. |

---

## 3. Security Risk Map

The table below catalogs specific security vulnerabilities detected in the Prototype v2 codebase, rating severity and detailing recommendations.

| Risk | Current Prototype Evidence | Severity | Why It Matters | Production Recommendation (Part 2) | Fix Before Staging? |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Service Role Key Usage** | `projectStore.js` uses `SUPABASE_SERVICE_ROLE_KEY` for all database query runs. | **High** | Bypasses all Row-Level Security (RLS) policies. Compromise of the server leads to total control over the database. | Restrict database connection clients to normal authenticated roles; enforce RLS policies. | **Yes** |
| **Missing Authentication** | Express APIs have zero route authentication middleware or session headers. | **High** | Anyone on the web can create, update, delete, or publish projects. | Implement JWT cookie authorization using Supabase Auth. | **Yes** |
| **Path Traversal Bypass** | `server.js` uses manual string check: `parts.some(p => p === '..' || p === '.')`. | **Medium** | Path parsing can be bypassed by double URL encoding or OS-specific paths (e.g. backslashes on Linux). | Standardize path sanitation using Node's native `path` module with strict character filters. | **Yes** |
| **Unrestricted File Types** | Checks files using simple extension mappings in `server.js` matching `.jpg`, `.png`, etc. | **High** | Students can rename executable scripts (e.g. `.js`, `.html`) to bypass filters, creating XSS vectors. | Enforce file magic-number binary signature checks to identify true MIME types. | **Yes** |
| **Unrestricted File Sizes** | Enforces a non-blocking warning rather than a strict hard limit during file parsing. | **Medium** | High-res image/video floods can exceed storage limits and consume free-tier bandwidth caps. | Reject files that exceed strict operational limits (e.g. posters > 5MB, snapshots > 2MB) at the router level. | **Yes** |
| **Public/Private Asset Separation** | Raw student details and administrative draft flags are uploaded directly to public buckets. | **High** | Sensitive student contact details or draft data may become crawlable by search engines. | Isolate drafts and metadata strictly in private, RLS-backed buckets; public CDN hosts approved files only. | **Yes** |
| **XSS / HTML Injection** | `bodyend.html` inserts text using dynamic string concatenations into innerHTML elements. | **High** | If a student uploads a title or description containing `<script>`, it executes on the Duda showcase domain. | Use safe client element selectors, static DOM placeholders, and `textContent` to populate student cells. | **Yes** |
| **CORS Configuration** | Backend uses wildcards `cors({ origin: '*' })` on administrative routes. | **Medium** | Allows cross-origin scripts from malicious sites to trigger administrative commands. | Restrict CORS access exclusively to the verified administration panel domain. | **Yes** |
| **Plain localPreview Wrapper** | Frontend preview loads un-sanitized layout presets inside raw div elements in the CMS. | **Medium** | Malicious CSS/HTML in student drafts can execute scripts inside the admin session, stealing keys. | Enforce preview sandboxing inside a secure `<iframe>` with strict `sandbox` permissions. | **Yes** |
| **Hard database deletion** | Admin panel sends direct delete requests to Supabase table. | **Medium** | Accidental click results in permanent data loss with no way to recover without full backups. | Replace hard deletes with soft-deletes (`deleted_at` flags) and admin-only trash restore views. | **Yes** |
| **Lack of Audit Logs** | State changes (e.g., Draft to Published) occur without logging administrative identities. | **Medium** | No accountability or history logs exist to track who approved or edited sensitive project data. | Implement an `audit_logs` table recording timestamps, user IDs, previous status, and new status. | **No** |

---

## 4. Maintainability Risk Map

The table below catalogs technical debt and structural maintainability risks identified in the codebase.

| Area | Current Issue | Impact | Recommended Part 2 Action |
| :--- | :--- | :--- | :--- |
| **Monolithic React App** | `src/App.jsx` exceeds 4,000 lines, mixing layouts, data forms, state sync, and custom CSS sheets. | High developer cognitive load; easy to introduce regressions when editing minor components. | Refactor frontend into a modular directory structure (e.g. `/components`, `/hooks`, `/pages`). |
| **Hashing Logic Duplication** | FNV-1a deterministic hashing logic is duplicated between `App.jsx` and `server.js`. | Code duplication leads to syncing bugs if one helper is adjusted while the other is neglected. | Extract hashing and slug sanitizers into a shared utility file loaded by both client and server layers. |
| **Documentation Duplication** | Duplicate files (e.g., `duda-integration-plan.md`) exist in `/docs` and `/Prototype/docs`. | Creates confusion for developers on which document is current. | Explicitly lock `/Prototype/docs` as historical evidence only, declaring `/docs` as the single source of truth. |
| **Flexible JSON Column** | Schema validation is performed dynamically at runtime inside Express rather than structured SQL cells. | Invalid schema variables can insert silently, leading to rendering failures in Duda. | Implement a strict backend JSON Schema Validator (e.g. `Ajv`) to validate inputs before database writes. |
| **Monolithic server.js** | Single backend file handles routing, CSV/XLSX decoding, asset management, and Supabase integration. | Difficult to unit test; small route changes can destabilize core ingestion services. | Decouple backend routes into an MVC pattern: routers, controllers, validators, and core services. |

---

## 5. Safe Part 2 Recommendations

When the academic break concludes and the Part 2 phase officially launches in July 2026, the team should execute these safety steps (do *not* implement these now):

1.  **Introduce Authentication & Role-Based Access Control**:
    Integrate Supabase Auth on the Express backend, blocking all API endpoints behind token validation middleware. Assign strict roles (`coordinator`, `reviewer`) to distinguish administrative capabilities.
2.  **Design Production Database Schema**:
    Introduce strict PostgreSQL table constraints on critical columns (e.g. ID patterns, status enums) to prevent database pollution.
3.  **Establish Media Handling and Public/Private Asset Separation**:
    Separate data storage paths: intermediate review drafts are written to private buckets, while fully approved showcase images are mirrored to public buckets.
4.  **Enforce Strict Public Feed Schema**:
    Integrate an automated JSON Schema validation gate in the publishing transaction loop. If a feed fails the 19-field validation, halt the sync.
5.  **Decouple and Modularize the Codebase**:
    *   Split the massive `App.jsx` into standalone React pages and reusable components.
    *   Migrate the single `server.js` into modular routes and services (e.g., `/routes/import.js`, `/services/xlsxParser.js`).
6.  **Implement Safe Sandbox Previews**:
    Load student local layout previews exclusively within sandboxed `<iframe>` tags in the CMS frontend.
7.  **Establish Backup and Rollback Procedures**:
    Build an automated database state restore utility (`adminStateBackup.js`) to sync with private Supabase buckets, mitigating free-tier service cold-start delays.

---

## 6. Do-Not-Do List for the Break

To protect the integrity of the project during the academic break, the following actions are strictly prohibited:

*   **Do NOT patch production logic**: Keep all codebase changes documentation-only and fully reversible.
*   **Do NOT deploy code**: Do not deploy code or push schema migrations to staging or production environments.
*   **Do NOT modify Duda settings**: Keep the live showcase presentation completely isolated.
*   **Do NOT alter Supabase configurations**: Do not add keys, change database RLS, or adjust bucket structures in the online dashboard.
*   **Do NOT lock final vendors**: Keep final hosting options, OCR/AI providers, and email providers open and free-tier first until July confirmations.
