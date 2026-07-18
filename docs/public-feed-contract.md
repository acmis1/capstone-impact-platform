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
Only project records with the following exact lowercase workflow status values are eligible to be compiled into the public feed:

*   **Eligible**:
    *   `approved`
    *   `published`

The following statuses are strictly **excluded** from compilation:
*   `draft`
*   `submitted`
*   `in_review`
*   `changes_requested`
*   `archived`
*   `deleted`

---

## 4. Required Validator Fields
Every compiled project object must contain the following required fields to pass validation:
*   `id` — Deterministic integer ID
*   `publicId` — A required stable public string identifier
*   `title` — Public title string
*   `summary` — Display description for listing cards
*   `year` — Project calendar year (string)
*   `program` — Study program name
*   `studyProgram` — Fallback program string matching XLSX structure
*   `discipline` — Primary technical discipline
*   `groupName` — Student group code or identifier
*   `teamMembers` — Roster of student names (array)
*   `poster` — Public poster image preview URL
*   `posterPdf` — Public poster PDF file URL
*   `layoutConfig` — Visual preset settings object containing `templateId`.

### Runtime Validator Field Rules
The runtime validator behaves as follows:
*   Requires the above 13 fields to be present and non-null.
*   Checks `id` is an integer.
*   Checks `teamMembers` is an array (does not currently check if every element inside the array is a string).
*   Checks `layoutConfig` is an object.
*   Checks `layoutConfig.templateId` is one of: `poster_showcase`, `technical_detail`, `media_rich`.
*   Does not require or type-check `featuredMedia` or `sectionOrder` at runtime (these are TypeScript domain-level properties only).

---

## 5. Compiler-Emitted Public Fields
The compiler matches and maps database projects directly to public fields.

### A. Always Emitted (using empty strings, empty arrays, or defaults when missing)
*   `id`, `publicId`, `title`, `summary`, `background`, `solution`, `year`, `program`, `studyProgram`, `discipline`, `disciplines`, `industry`, `industryPartner`, `academicSupervisor`, `groupName`, `teamMembers`, `poster`, `posterPdf`, `posterText`, `accessibilityText`, `snapshots`, `layoutConfig`

### B. Conditionally Emitted (only when populated with non-empty values)
*   `videoUrl`, `demoUrl`, `repositoryUrl`, `externalLinks`, `citations`

---

## 6. Layout Configuration
The `layoutConfig.templateId` property must map to one of the three verified layout presets:
1.  **`poster_showcase`**: High-focus poster layout.
2.  **`technical_detail`**: Structured content-first layout.
3.  **`media_rich`**: Media-first layout rendering snapshot sliders or video heroes.

---

## 7. Internal-Field Handling
To protect student privacy and staff workflows, the following administrative fields are strictly handled:

### A. Compiler-Stripped Fields
The compiler (`compilePublicFeed.ts`) automatically strips these fields:
*   `status`, `importBatchId`, `sourceFolder`, `internalStaffNotes`, `privateReviewComments`, `validationFlags`, `validationErrors`, `validationWarnings`, `pendingRemovalFromPublic`, `publicRemovalCompletedAt`, `archivedAt`, `archivedFromStatus`, `archiveReason`, `created_at`, `updated_at`

### B. Explicit Validator Forbidden Set
If any of these fields are present in the payload sent to the validator (`validatePublicFeed.ts`), it triggers an validation error:
*   `status`, `importBatchId`, `sourceFolder`, `internalStaffNotes`, `privateReviewComments`, `validationFlags`, `packageValidation`, `pendingRemovalFromPublic`, `publicRemovalCompletedAt`, `archivedAt`, `archivedFromStatus`, `archiveReason`, `created_at`, `updated_at`

### C. Validation Error and Warning Handling
*   `validationErrors` and `validationWarnings` are stripped by the compiler. If manually supplied to the runtime validator, they are rejected as unknown fields since they are not allow-listed.
*   Aliases such as `internal_notes` or `admin_id` are not current domain fields; they are rejected as unknown rather than explicitly forbidden.

---

## 8. Validation Behavior
*   **Empty Feed**: An empty feed array is technically valid but returns a validation warning.
*   **Unknown or Forbidden Keys**: Triggers validation errors.
*   **Missing/Null Required Fields**: Triggers validation errors.
*   **Type Constraints**: `id` must be an integer, `teamMembers` must be an array, `templateId` must match one of the allowed template strings. Array elements are not checked.
*   **Feed Validation Warnings**: Recommended fields (e.g., `accessibilityText` or `posterText`) generate non-blocking feed-validation warnings if missing, which do not make `validation.valid` false.
*   **No Active URL Audits**: The validator does not check URL structures, protocols, or network reachability.

---

## 9. Stable Path and Duda Compatibility
*   **Filename**: `capstones-latest.json`
*   **Bucket Names**: The Admin/CMS storage bucket names are configuration-driven. Defaults:
    *   Public Feeds: `public-feeds`
    *   Public Assets: `project-public-assets`
    *   Private Drafts: `project-drafts-private`
*   **Prototype Environment Note**: The Prototype recovery environment uses separate hardcoded bucket names (`feeds`, `project-assets`, `project-drafts`) and must not be treated as the Admin/CMS staging environment.
*   **Caching**: `bodyend.html` appends a timestamp query parameter and uses `cache: no-store` to bypass client browser cache.

---

## 10. Known Current Limitations
*   **Empty Strings**: Empty strings (`""`) can pass required-field presence checks.
*   **Lack of Deep Type Checking**: Array elements (like `teamMembers` elements) are not type-checked at runtime.
*   **No Media Verification**: URL protocols, media types, and reachability are not validated.
*   **No Layout Verification**: `featuredMedia` and `sectionOrder` are emitted by the compiler but not independently validated at runtime.
*   **No Duplicate Check**: Duplicate `publicId` values are not checked.
*   **Non-Atomic Publication**: Writing the feed JSON and recording the publication snapshot in the database are not executed as a single atomic database transaction.
*   **Warning-Only Empty Feed**: An empty array feed does not block publishing.

---

## 11. Future Hardening Requirements
The following validations are planned as future improvements:
*   **Non-empty Constraint**: Enforcing length rules on required string parameters.
*   **URL Protocol Checking**: Enforcing secure `https://` schemas and file type checks on poster images.
*   **Unique Public ID Validation**: Enforcing that `publicId` contains no duplicates in the compiled feed.
*   **Transaction Lock**: Wrapping compile-and-publish commands in atomic SQL transactions.
*   **Feed Rollback Registry**: Creating a database table to catalog historical feed snapshots and support one-click rollbacks.
