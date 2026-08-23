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
Ensure structural compatibility between the compiled JSON feed and Duda's client-side rendering script. Contract mismatches may cause rejected publication, missing content, partial rendering, or public-layer failures.

---

## 3. Publication Eligibility
Ordinary compilation (`compilePublicFeed()`) includes only project records with the exact lowercase `published` status.

During controlled publication, `compilePublicationCandidateFeed()` may include one exact `approved` target alongside the published baseline in a durable candidate artifact. That target joins the ordinary feed only after finalization changes its status to `published`.

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
*   `id` — Required integer identifier (deterministic generation is a current domain convention, not independently verified by the feed validator)
*   `publicId` — A required stable public string identifier
*   `title` — Public title string
*   `summary` — Display description for listing cards
*   `year` — Project calendar year (string)
*   `program` — Study program name
*   `studyProgram` — Fallback program string matching XLSX structure
*   `discipline` — Primary technical discipline
*   `groupName` — Participant group code or identifier
*   `teamMembers` — Roster of participant names (array)
*   `poster` — Public poster image preview URL
*   `posterPdf` — Public poster PDF file URL
*   `posterText` — Required accessible full text for poster content
*   `accessibilityText` — Required poster text alternative
*   `snapshots` — Public snapshot URL array
*   `snapshotMedia` — Exact `{ url, altText }` pairing for every snapshot
*   `layoutConfig` — Visual preset settings object containing `templateId`.

### Runtime Validator Field Rules
The runtime validator behaves as follows:
*   Requires the above fields to be present and non-null.
*   Checks `id` is an integer.
*   Checks `teamMembers` is an array (does not currently check if every element inside the array is a string).
*   Requires non-blank bounded `posterText` and `accessibilityText` values.
*   Checks that each snapshot URL is an absolute HTTP(S), structurally public-safe URL; rejects malformed, relative, non-HTTP(S), private-draft, private-ingestion, signed, and authenticated-storage URLs. It does not perform network reachability checks.
*   Requires unique snapshot URLs and an exact, order-independent one-to-one correspondence with `snapshotMedia`; each media item has only `url` and non-blank bounded `altText` fields.
*   Checks `layoutConfig` is an object.
*   Checks `layoutConfig.templateId` is one of: `poster_showcase`, `technical_detail`, `media_rich`.
*   Does not require or type-check `featuredMedia` or `sectionOrder` at runtime. They are defined in the TypeScript domain, and `compilePublicFeed` supplies/defaults and emits them inside `layoutConfig`, but `validatePublicFeed` does not independently require or type-check them.

---

## 5. Compiler-Emitted Public Fields
The compiler matches and maps database projects directly to public fields.

### A. Always Emitted (using empty strings, empty arrays, or defaults when missing)
*   `id`, `publicId`, `title`, `summary`, `background`, `solution`, `year`, `program`, `studyProgram`, `discipline`, `disciplines`, `industry`, `industryPartner`, `academicSupervisor`, `groupName`, `teamMembers`, `poster`, `posterPdf`, `posterText`, `accessibilityText`, `snapshots`, `snapshotMedia`, `layoutConfig`

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
To protect participant privacy and staff workflows, the following administrative fields are strictly handled:

### A. Compiler-Stripped Fields
The compiler (`compilePublicFeed.ts`) automatically strips these fields:
*   `status`, `importBatchId`, `sourceFolder`, `internalStaffNotes`, `privateReviewComments`, `validationFlags`, `validationErrors`, `validationWarnings`, `pendingRemovalFromPublic`, `publicRemovalCompletedAt`, `archivedAt`, `archivedFromStatus`, `archiveReason`, `created_at`, `updated_at`

### B. Explicit Validator Forbidden Set
If any of these fields are present in the payload sent to the validator (`validatePublicFeed.ts`), it triggers a validation error:
*   `status`, `importBatchId`, `sourceFolder`, `internalStaffNotes`, `privateReviewComments`, `validationFlags`, `packageValidation`, `pendingRemovalFromPublic`, `publicRemovalCompletedAt`, `archivedAt`, `archivedFromStatus`, `archiveReason`, `created_at`, `updated_at`

### C. Validation Error and Warning Handling
*   `validationErrors` and `validationWarnings` are stripped by the compiler. If manually supplied to the runtime validator, they are rejected as unknown fields since they are not allow-listed.
*   Aliases such as `internal_notes` or `admin_id` are not current domain fields; they are rejected as unknown rather than explicitly forbidden.

---

## 8. Validation Behavior
*   **Empty Feed**: An empty feed array is technically valid but returns a validation warning.
*   **Unknown or Forbidden Keys**: Triggers validation errors.
*   **Missing/Null Required Fields**: Triggers validation errors.
*   **Type Constraints**: `id` must be an integer; `teamMembers`, `snapshots`, and `snapshotMedia` must be arrays; and `templateId` must match one of the allowed template strings. `teamMembers` elements are not checked.
*   **Feed Validation Warnings**: An empty feed is valid with a warning; several optional indexing/display fields can also produce non-blocking warnings. Required accessibility fields are validation errors when missing, blank, or over their bounds.
*   **Snapshot URL/Media Checks**: Snapshot URLs undergo structural public-safety checks and must correspond exactly to `snapshotMedia` entries and their alt text. These checks do not fetch URLs or establish network reachability.

---

## 9. Stable Path and Duda Compatibility
*   **Filename**: `capstones-latest.json`
*   **Bucket Names**: The Admin/CMS storage bucket names are configuration-driven. Defaults:
    *   Public Feeds: `public-feeds`
    *   Public Assets: `project-public-assets`
    *   Private Drafts: `project-drafts-private`
*   **Prototype Environment Note**: The recovered Prototype uses exactly the bucket names `feeds` and `project-assets`. These are separate from the configurable Admin/CMS defaults (`public-feeds`, `project-public-assets`, `project-drafts-private`).
*   **Caching**: `bodyend.html` appends a timestamp query parameter and uses `cache: no-store` to bypass client browser cache.

---

## 10. Known Current Limitations
*   **Empty Strings**: Empty strings (`""`) can pass required-field presence checks.
*   **Lack of Deep Type Checking**: Array elements (like `teamMembers` elements) are not type-checked at runtime.
*   **No Network Media Verification**: Snapshot URL checks are structural only; the validator does not fetch URLs, check reachability, or inspect remote media bytes/types.
*   **No Layout Verification**: `featuredMedia` and `sectionOrder` are emitted by the compiler but not independently validated at runtime.
*   **No Duplicate Check**: Duplicate `publicId` values are not checked.
*   **Cross-System Atomicity Boundary**: Object storage and PostgreSQL are not one physical distributed transaction. Controlled publication instead uses durable attempts, bound artifacts, previous-feed preservation, upload verification, atomic database finalization, recovery, and compensation to manage failures.
*   **Warning-Only Empty Feed**: An empty array feed does not block publishing.

---

## 11. Future Hardening Requirements
The following validations are planned as future improvements:
*   **Non-empty Constraint**: Enforcing length rules on required string parameters.
*   **Unique Public ID Validation**: Enforcing that `publicId` contains no duplicates in the compiled feed.
