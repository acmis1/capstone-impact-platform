# Public Feed Contract: Stable Showcase JSON

This document defines the draft data contract consumed by the Duda Showcase Layer. The Admin/CMS compiler enforces these parameters when compiling and publishing showcase updates.

> [!WARNING]
> **Planning Draft Only**
> This contract is a planning draft designed for architectural discussion. It is *not* a finalized API specification and must remain flexible until the formal confirmation session in July 2026. The final contract may be a stable subset of the fields documented below. Do not implement final validation locks based on this draft during the break. Upgrading the Duda platform plan remains permanently out of scope.

---

## 1. Purpose and Stable Feed Principle
*   **Public Layer Only**: To bypass Duda's database and subscription constraints, Duda operates strictly as a public presentation shell. It does *not* host native dynamic data collections or act as the operational database.
*   **Stable Feed URL**: Duda pulls all project grids and detail pages from a single, stable public JSON feed URL (fronted by a CDN or served through approved public asset URLs).
*   **Zero-Maintenance Design**: The Duda site template should not require manual editing when new semesters or projects are published. All listing updates, search filters, and detail views are parsed dynamically at runtime from this single feed file.

---

## 2. Feed Compilation Rules
*   **Approved Records Only**: Only records with `status = 'approved'` or `status = 'published'` are selected for public feed compilation.
*   **Internal Sanitization (Zero Leakage)**: The compiler must strictly strip all administrative data, private notes, and validation logs to protect student privacy and internal workflows.
*   **No Schema Breaks**: Changes to internal database models must never break the stable fields expected by the Duda dynamic script (`bodyend.html`).

---

## 3. Prototype-Supported Public Fields

Prototype v2 and its feed validator script (`validate-feed.js`) support or expect the following fields in the public JSON payload:

*   `id` — Deterministic integer ID
*   `title` — Public title string
*   `summary` — Card display description
*   `background` — Context description
*   `solution` — Impact description
*   `year` — Project calendar year (string)
*   `program` — Academic study program name
*   `studyProgram` — Duplicate/fallback program representation matching XLSX format
*   `discipline` — Primary technical discipline
*   `disciplines` — Technical disciplines list (array)
*   `industry` — Target sector tag
*   `industryPartner` — Industry company name
*   `academicSupervisor` — Staff supervisor
*   `groupName` — Student team group identifier
*   `teamMembers` — Roster of student names (array)
*   `poster` — HTTPS URL to poster image preview
*   `posterPdf` — HTTPS URL to poster PDF file
*   `posterText` — Reviewed public poster text content
*   `accessibilityText` — Reviewed public accessibility description
*   `snapshots` — HTTPS URLs array for snapshot preview sliders
*   `videoUrl` — Dynamic demo video link
*   `demoUrl` — Running prototype link
*   `repositoryUrl` — Git code repository link
*   `externalLinks` — Standard web links array
*   `citations` — References and citations list (array)
*   `layoutConfig` — Visual preset configurations (template ID, featured media, section order)

---

## 4. Public-Safe Field Classifications (MoSCoW Schema)

To accommodate projects with different media packages and technical deliverables, fields are classified into required, recommended, and optional tiers. Optional fields are *never* forced to exist for every project record.

### A. Required Public Fields for Minimum Duda Rendering
These fields must exist for every compiled project record to avoid layout rendering failures on Duda.

| Field Name | Type | Purpose |
| :--- | :--- | :--- |
| `id` | `integer` | Unique deterministic identifier. |
| `title` | `string` | Public title. |
| `summary` | `string` | Brief description for listing cards. |
| `year` | `string` | Calendar year (e.g. `"2026"`). |
| `program` | `string` | Study program name (e.g., `"Information Technology"`). |
| `studyProgram` | `string` | Study program fallback. |
| `discipline` | `string` | Primary discipline. |
| `groupName` | `string` | Student group identifier. |
| `teamMembers` | `array of strings` | Array of student names. |
| `poster` | `string` | HTTPS URL to the public poster image. |
| `posterPdf` | `string` | HTTPS URL to the public poster PDF. |
| `layoutConfig` | `object` | Visual presets (`templateId`, `featuredMedia`, `sectionOrder`). |

### B. Recommended Public Fields for Accessibility and Search
These fields are highly recommended to ensure compliance with accessibility criteria and robust showcase search indexing.

| Field Name | Type | Purpose |
| :--- | :--- | :--- |
| `background` | `string` | Problem context description. |
| `solution` | `string` | Solution/impact description. |
| `accessibilityText` | `string` | Reviewed public accessibility text describing poster elements. |
| `posterText` | `string` | Reviewed public poster text content for text search indexing. |
| `academicSupervisor` | `string` | Supervisor name. |
| `industryPartner` | `string` | Corporate partner company. |
| `industry` | `string` | Industry sector categorization. |
| `disciplines` | `array of strings` | Set of relevant disciplines. |

### C. Optional Public Fields for Richer Showcase Rendering
These fields are completely optional and should only be rendered when supplied. The Duda layout scripts must check for their existence and handle missing properties gracefully.

| Field Name | Type | Purpose |
| :--- | :--- | :--- |
| `snapshots` | `array of strings` | List of public showcase snapshot image URLs. |
| `videoUrl` | `string` | HTTPS URL to YouTube, Vimeo, or a public demo file. |
| `demoUrl` | `string` | HTTPS URL to a running prototype. |
| `repositoryUrl` | `string` | HTTPS URL to git code repository. |
| `externalLinks` | `array of objects` | Web links array (label and target). |
| `citations` | `array of strings` | Roster of citations and bibliography notes. |

---

## 5. Forbidden Internal Fields
If any of these fields are detected in the compiled public feed output, the validation check must fail the sync instantly:
*   `status` (internal workflow status)
*   `internalNotes` / `internal_staff_notes`
*   `reviewNotes` / `private_review_comments`
*   `missingItems`
*   `validationFlags` / `validationErrors` / `validationWarnings`
*   `adminId` / `admin_id`
*   `importBatchId` / `import_batch_id`
*   `sourceFolder`
*   `pendingRemovalFromPublic`
*   `publicRemovalCompletedAt`
*   `archivedAt` / `archiveReason`
*   Raw administrative file paths (e.g. `imports/...`)

---

## 6. Feed Validation Gates
To guarantee stability, the Admin/CMS publishing loop must run the compiled payload against these rules before writing to the public storage:
1.  **JSON Structural Integrity**: Ensure the output is a valid JSON array of objects.
2.  **Warn on Zero Records**: The feed may be empty during staging or before final publication. Production publishing should warn if zero records are present, but this should not constitute a blocking schema error unless stakeholders explicitly confirm in July.
3.  **Strict Field Allow-Listing**: Unknown fields should be rejected from the public feed by default unless explicitly allowed in the public contract. Internal fields must always fail validation if present.
4.  **Type Safety Verification**:
    *   Verify that `id` is a valid integer.
    *   Verify that `snapshots` and `teamMembers` are arrays of strings.
5.  **Allowed Visual Layouts**: Enforce that `templateId` strictly matches one of the three verified layout presets: `poster_showcase`, `technical_detail`, or `media_rich`.

---

## 7. Public Asset URL Rules
*   **HTTPS Only**: All media URLs (`poster`, `posterPdf`, `snapshots`) must use secure `https://` schemas. Unsecure HTTP links are rejected to satisfy browser sandbox rules.
*   **Approved Public Asset URLs**: All uploaded files are strictly hosted in secure cloud locations, made available through approved public asset URLs. The system must verify that these URLs are reachable.
*   **Permanent Feed Paths**: The compilation writes to the exact same file path (e.g. `capstones-latest.json`) to prevent breaking Duda connection references.

---

## 8. Versioning & Rollback Strategy
*   **Snapshot Compilations**: The Admin/CMS should save every successful compiled public JSON feed with a timestamped file name (e.g. `capstones-backup-20260601.json`) in a private history bucket.
*   **One-Click Rollback**: If a published feed contains a critical error, administrators can select a previous backup snapshot and overwrite the active `capstones-latest.json` instantly through the dashboard.
*   **Cache Invalidation**: Implement immediate cache busting query parameters (e.g., adding `?v=timestamp` at fetch time) inside Duda's body-end script to ensure client browsers render feed overrides instantly.

---

## 9. Open Questions for July Confirmation
*   *CDN Feed Caching*: Will the public feed JSON and assets be served directly from public Supabase Storage buckets, or is a CDN configuration required to handle dynamic bandwidth spikes during high-volume showcase events?
*   *Duda Cache Policy*: How often does Duda check for updates? Should Duda client requests pull the feed on every page view, or cache it in session storage to reduce database reads?
*   *Language Localization*: Is there a future requirement to translate the feed or host separate regional showcase listings?
