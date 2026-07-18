# Public Feed Contract

This document details the public JSON schema contract used to distribute approved showcase data from the Admin/CMS to the Duda frontend layer.

---

## 1. Authoritative Implementation Sources
The schema constraints, field mappings, and filters defined here are implemented directly in:
*   [apps/admin-cms/src/domain/publicFeed.ts](../apps/admin-cms/src/domain/publicFeed.ts)
*   [apps/admin-cms/src/feed/compilePublicFeed.ts](../apps/admin-cms/src/feed/compilePublicFeed.ts)
*   [apps/admin-cms/src/feed/validatePublicFeed.ts](../apps/admin-cms/src/feed/validatePublicFeed.ts)
*   `apps/admin-cms/src/feed/*.test.ts` (Automated feed compilation and validation test suites)

---

## 2. Purpose
Ensure structural compatibility between the compiled JSON feed and Duda's client-side rendering script. Any mismatch will cause rendering failures on Duda.

---

## 3. Publication Eligibility
Only project records with the following status configuration are eligible to be compiled into the public feed:
*   **Workflow Status**: `PUBLISHED` (meaning they have passed admin review and been approved).

The following statuses are strictly **excluded** from compilation:
*   `DRAFT`
*   `SUBMITTED`
*   `IN_REVIEW`
*   `CHANGES_REQUESTED`
*   `ARCHIVED`
*   `DELETED`

---

## 4. Required Validator Fields
Every compiled project object must contain the following required fields to pass validation:
*   `id` — Deterministic integer ID
*   `publicId` — Unique public string identifier (UUID or stable hash)
*   `title` — Public title string
*   `summary` — Display description for listing cards
*   `year` — Project calendar year (string)
*   `program` — Study program name
*   `studyProgram` — Fallback program string matching XLSX structure
*   `discipline` — Primary technical discipline
*   `groupName` — Student group code or identifier
*   `teamMembers` — Roster of student names (array of strings)
*   `poster` — HTTPS URL to public poster image preview
*   `posterPdf` — HTTPS URL to public poster PDF file
*   `layoutConfig` — Visual preset settings object containing:
    *   `templateId` (Must match a verified layout)
    *   `featuredMedia`
    *   `sectionOrder`

---

## 5. Compiler-Emitted Public Fields
The compiler matches and maps the database projects table schema directly to public fields defined in [publicFeed.ts](../apps/admin-cms/src/domain/publicFeed.ts). These include:
*   `id`, `publicId`, `title`, `summary`, `background`, `solution`, `year`, `program`, `studyProgram`, `discipline`, `disciplines`, `industry`, `industryPartner`, `academicSupervisor`, `groupName`, `teamMembers`, `poster`, `posterPdf`, `posterText`, `accessibilityText`, `snapshots`, `videoUrl`, `demoUrl`, `repositoryUrl`, `externalLinks`, `citations`, `layoutConfig`.

---

## 6. Optional Conditionally Emitted Fields
The following fields are optional and are only emitted in the JSON element when they have non-empty values:
*   `background`, `solution`, `disciplines` (array), `industry`, `industryPartner`, `academicSupervisor`, `posterText`, `accessibilityText`, `snapshots` (array of snapshot image URLs), `videoUrl` (H.264 video file or streaming url), `demoUrl`, `repositoryUrl` (GitHub/GitLab url), `externalLinks` (label-URL object array), `citations` (string array).

---

## 7. Layout Configuration
The `layoutConfig.templateId` property must map to one of the three verified layout presets:
1.  **`poster_showcase`**: High-focus poster layout.
2.  **`technical_detail`**: Structured content-first layout.
3.  **`media_rich`**: Media-first layout rendering snapshot sliders or video heroes.

---

## 8. Forbidden Internal Fields
To protect student privacy and staff workflows, the following administrative fields are strictly stripped by `compilePublicFeed.ts` and will fail validation if present:
*   `status` (internal workflow enum)
*   `internalNotes` / `internal_staff_notes`
*   `reviewNotes` / `private_review_comments`
*   `validationFlags` / `validationErrors` / `validationWarnings`
*   `adminId` / `admin_id`
*   `importBatchId` / `import_batch_id`
*   `sourceFolder`
*   `pendingRemovalFromPublic`
*   `publicRemovalCompletedAt`
*   `archivedAt` / `archiveReason`
*   Raw administrative file paths or internal Supabase tokens
*   Any unknown fields not explicitly allow-listed in the domain schema (e.g. metadata warnings are rejected).

---

## 9. Validation Behavior

### A. Currently Enforced (Code-Backed)
*   Check that all 13 required fields exist.
*   Enforce correct types (e.g., `id` is an integer, `teamMembers` is an array of strings).
*   Enforce visual layout preset IDs match allowed templates.
*   Reject forbidden internal fields.

### B. Nonblocking Warnings
*   Missing recommended metadata (e.g., `accessibilityText` or `posterText`) triggers validation warnings during ingestion but does not block public feed compilation once marked approved by an admin.

---

## 10. Stable Path and Duda Compatibility
*   **Filename**: `capstones-latest.json`
*   **Location**: Written directly to the root of the public Supabase Storage bucket `feeds`.
*   **Caching**: Query variables (`capstones-latest.json?v=<timestamp>`) are used inside Duda's `bodyend.html` to invalidate client browser caches and ensure immediate updates.

---

## 11. Known Current Limitations
*   **String Formatting**: The validator currently accepts empty strings (`""`) for required text fields if they are technically present.
*   **URL Verification**: The system verifies string structure but does not hit media URLs to verify hosting reachability in real-time.
*   **No Multi-Tenant Isolation**: The feed compiler processes all published records into a single global array.

---

## 12. Future Hardening Requirements
The following validations are planned as future improvements:
*   **Non-empty Constraint**: Enforcing length rules on required string parameters.
*   **URL Protocol Checking**: Enforcing secure `https://` schemas and file type checks on poster images.
*   **Unique Public ID Validation**: Enforcing that `publicId` contains no duplicates in the compiled feed.
*   **Transaction Lock**: Wrapping compile-and-publish commands in atomic SQL transactions.
*   **Feed Rollback Registry**: Creating a database table to catalog historical feed snapshots and support one-click rollbacks.
