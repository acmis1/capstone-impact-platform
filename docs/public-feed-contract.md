# Public Feed Contract

This document details the public JSON schema contract used to distribute approved showcase data from the Admin/CMS to the Duda frontend layer.

---

## 1. Authoritative Implementation Sources
The schema constraints, field mappings, and filters defined here are implemented directly in:
*   [apps/admin-cms/src/domain/publicFeed.ts](../apps/admin-cms/src/domain/publicFeed.ts)
*   [apps/admin-cms/src/feed/compilePublicFeed.ts](../apps/admin-cms/src/feed/compilePublicFeed.ts)
*   [apps/admin-cms/src/feed/validatePublicFeed.ts](../apps/admin-cms/src/feed/validatePublicFeed.ts)
*   [apps/admin-cms/src/feed/publicFeedArtifact.ts](../apps/admin-cms/src/feed/publicFeedArtifact.ts)
*   [apps/admin-cms/src/projects/publicFeedWriterCoordinator.ts](../apps/admin-cms/src/projects/publicFeedWriterCoordinator.ts)
*   [infra/supabase/migrations/20260824180000_public_feed_deployment_ledger.sql](../infra/supabase/migrations/20260824180000_public_feed_deployment_ledger.sql)
*   [infra/supabase/migrations/20260824183000_public_feed_writer_protocol.sql](../infra/supabase/migrations/20260824183000_public_feed_writer_protocol.sql)
*   `apps/admin-cms/src/feed/*.test.ts` (Automated feed compilation and validation test suites)

---

## 2. Purpose
Ensure structural compatibility between the compiled JSON feed and Duda's client-side rendering script. Contract mismatches may cause rejected publication, missing content, partial rendering, or public-layer failures.

---

## 3. Deployment Authority Model

Three related states have deliberately separate authority:

*   **Project lifecycle** is the editorial and business truth in `projects.status` and its related review/audit records.
*   **Public deployment ledger** is the intended public deployment truth. Immutable versions and membership records describe exact historical artifacts, while `public_feed_head` identifies the one current intended deployment.
*   **Storage** is the externally served copy of that deployment head. A completed operation requires its exact bytes, SHA-256 hash, and record count to agree with the head version.

Lifecycle state is not reconstructed from Storage, and deployment membership is not inferred from current lifecycle rows. After a controlled rollback the two may intentionally diverge: the ledger and Storage reflect the restored artifact, while project lifecycle records remain unchanged until explicit later editorial or reconciliation operations.

---

## 4. Exact Artifact Invariant

Every candidate, deployed version, activation baseline, and rollback target passes through the same artifact verifier:

*   The 10 MiB limit is enforced before UTF-8 decoding or JSON parsing.
*   UTF-8 decoding is fatal; BOM-prefixed, malformed, or non-round-tripping bytes are rejected.
*   The payload must be the exact canonical `JSON.stringify(feed, null, 2)` representation. Semantically equivalent but byte-different JSON is rejected.
*   The feed must pass the public contract validator and contain no duplicate `publicId`.
*   The ledger records the SHA-256 hash and byte count of the exact artifact, plus the ordered member manifest and SHA-256 hash of each exact canonical record.
*   Version rows, version-member rows, and operation-event rows are immutable. The deployment head moves only through the controlled writer protocol.

Artifact bodies and provider errors are server-only evidence. History responses expose bounded hashes, counts, actors, states, timestamps, and membership metadata rather than the stored artifact body or credentials.

---

## 5. Publication Eligibility
Ordinary compilation (`compilePublicFeed()`) includes only project records with the exact lowercase `published` status.

During controlled publication, the candidate is composed from the exact current deployment head plus one exact approved target. It is not rebuilt from every lifecycle row. The target joins ordinary lifecycle compilation only after database finalization changes its status to `published`.

Removal similarly starts from the exact current head and removes only the requested `publicId`. If that identifier is already absent, removal may complete without writing a new artifact version. Deployment reconciliation republishes an exact current lifecycle record for a `published` project that is not deployed, without replaying a lifecycle transition or its publication audit.

The following statuses are strictly **excluded** from compilation:
*   `draft`
*   `submitted`
*   `in_review`
*   `changes_requested`
*   `archived`
*   `deleted`

---

## 6. Required Validator Fields
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

## 7. Compiler-Emitted Public Fields
The compiler matches and maps database projects directly to public fields.

### A. Always Emitted (using empty strings, empty arrays, or defaults when missing)
*   `id`, `publicId`, `title`, `summary`, `background`, `solution`, `year`, `program`, `studyProgram`, `discipline`, `disciplines`, `industry`, `industryPartner`, `academicSupervisor`, `groupName`, `teamMembers`, `poster`, `posterPdf`, `posterText`, `accessibilityText`, `snapshots`, `snapshotMedia`, `layoutConfig`

### B. Conditionally Emitted (only when populated with non-empty values)
*   `videoUrl`, `demoUrl`, `repositoryUrl`, `externalLinks`, `citations`

---

## 8. Layout Configuration
The `layoutConfig.templateId` property must map to one of the three verified layout presets:
1.  **`poster_showcase`**: High-focus poster layout.
2.  **`technical_detail`**: Structured content-first layout.
3.  **`media_rich`**: Media-first layout rendering snapshot sliders or video heroes.

---

## 9. Internal-Field Handling
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

## 10. Validation Behavior
*   **Empty Feed**: An empty feed array is technically valid but returns a validation warning.
*   **Unknown or Forbidden Keys**: Triggers validation errors.
*   **Missing/Null Required Fields**: Triggers validation errors.
*   **Type Constraints**: `id` must be an integer; `teamMembers`, `snapshots`, and `snapshotMedia` must be arrays; and `templateId` must match one of the allowed template strings. `teamMembers` elements are not checked.
*   **Feed Validation Warnings**: An empty feed is valid with a warning; several optional indexing/display fields can also produce non-blocking warnings. Required accessibility fields are validation errors when missing, blank, or over their bounds.
*   **Snapshot URL/Media Checks**: Snapshot URLs undergo structural public-safety checks and must correspond exactly to `snapshotMedia` entries and their alt text. These checks do not fetch URLs or establish network reachability.
*   **Duplicate IDs**: The artifact verifier rejects duplicate `publicId` values even though the lower-level structural validator remains reusable independently.

---

## 11. Baseline Activation and Controlled Operations

Deployment history must be activated through the governed writer before publication or removal can use the ledger:

*   If the canonical Storage object exists, its exact verified content must match the current lifecycle projection before it can become the baseline head.
*   If the object is absent, activation succeeds only when the lifecycle projection is the canonical empty feed; a missing non-empty baseline fails closed.
*   Activation records the baseline as an immutable version and establishes the explicit head. It performs no migration-time Storage I/O.

Every later canonical write uses one globally exclusive operation slot, a short lease, an owner-token hash and monotonically increasing owner epoch. The candidate is durably bound before `WRITE_STARTED`. After that transition the system never restores or compensates with the old baseline: retries converge forward on the same immutable candidate. A timeout or ambiguous Storage response is reconciled through an exact read, while uncertainty fencing prevents another worker from immediately overwriting a possibly committed response.

Unexpected Storage bytes, a Storage/head mismatch, or an unresolved post-write state moves the operation to `RECOVERY_REQUIRED`. That durable state blocks all later canonical writers until an authorized operator explicitly claims that exact operation and reconciles its bound candidate. Recovery does not silently choose a different artifact.

---

## 12. Rollback Semantics

Rollback restores public deployment state, not project lifecycle state or the whole database:

*   Preparation is durable, actor-bound, expiring, and identified externally only by an opaque handle. It records the exact current head, target version, membership difference, lifecycle drift, and required acknowledgement.
*   Execution requires the same authorized actor, the unexpired preparation, the exact acknowledgement, and an unchanged baseline.
*   The selected historical artifact is verified again and deployed as a new immutable version whose provenance identifies the restored version. The head advances to the new version; historical rows are never mutated.
*   Project lifecycle and publication audits are not reversed. After rollback, later publication/removal composes from the restored deployment head, so a later publish adds only its explicit target rather than silently reintroducing all lifecycle-`published` projects.
*   Rollback execution is fail-closed outside an explicitly enabled loopback Local/disposable application and a database head whose rollback capability was activated there. Hosted rollback is unavailable.

---

## 13. Canonical Writer Boundary

`PublicFeedStorageBoundary` is private to the unified server-side writer coordinator and is the only production path permitted to replace `capstones-latest.json`. Publication, removal, activation, reconciliation, rollback, and explicit recovery all use that coordinator. Legacy publication/removal writer RPCs fail closed, and the standalone staging-feed publisher is disabled rather than retaining a second canonical writer.

No browser role can execute the privileged ledger protocol. Ledger tables use RLS and explicit grants; privileged functions revoke default `PUBLIC`, `anon`, and `authenticated` execution and grant only the service role.

---

## 14. Stable Path and Duda Compatibility
*   **Filename**: `capstones-latest.json`
*   **Bucket Names**: The Admin/CMS storage bucket names are configuration-driven. Defaults:
    *   Public Feeds: `public-feeds`
    *   Public Assets: `project-public-assets`
    *   Private Drafts: `project-drafts-private`
*   **Prototype Environment Note**: The recovered Prototype uses exactly the bucket names `feeds` and `project-assets`. These are separate from the configurable Admin/CMS defaults (`public-feeds`, `project-public-assets`, `project-drafts-private`).
*   **Caching**: `bodyend.html` appends a timestamp query parameter and uses `cache: no-store` to bypass client browser cache.

---

## 15. Known Current Limitations
*   **Empty Strings**: Empty strings (`""`) can pass required-field presence checks.
*   **Lack of Deep Type Checking**: Array elements (like `teamMembers` elements) are not type-checked at runtime.
*   **No Network Media Verification**: Snapshot URL checks are structural only; the validator does not fetch URLs, check reachability, or inspect remote media bytes/types.
*   **No Layout Verification**: `featuredMedia` and `sectionOrder` are emitted by the compiler but not independently validated at runtime.
*   **Cross-System Atomicity Boundary**: Object storage and PostgreSQL are not one physical distributed transaction. The ledger protocol manages that boundary with a durably bound candidate, exact read-after-write verification, fencing, forward recovery, atomic database finalization, and an explicit deployment head.
*   **Warning-Only Empty Feed**: An empty array feed does not block publishing.

---

## 16. Future Hardening Requirements
The following validations are planned as future improvements:
*   **Non-empty Constraint**: Enforcing length rules on required string parameters.
