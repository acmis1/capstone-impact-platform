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
*   [infra/supabase/migrations/20260825030000_public_feed_taxonomy_operation_guard.sql](../infra/supabase/migrations/20260825030000_public_feed_taxonomy_operation_guard.sql)
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

### Deployment reconciliation authority

Lifecycle `published` status alone is never sufficient authority to deploy. Normal publication proves `get_project_publication_readiness`, which is a strictly pre-publication authority: it requires `approved` status and pristine, unpromoted private media. That gate is not reused, relaxed, or reinterpreted for reconciliation.

Reconciliation instead proves a separate, dedicated database authority, `get_project_reconciliation_readiness`, which requires the target to be lifecycle `published` and re-derives participant authority from stored preview evidence rather than from project status, the previously served feed, or current public URLs. It fails closed when there is no qualifying preview, no confirmation, ambiguous preview or confirmation state, an unresolved correction request, a malformed stored snapshot, scalar metadata drift, taxonomy or relationship drift, media identity drift, an added or removed snapshot, a gallery reorder, or per-image alt-text drift. Gallery position and per-image alt text are part of the compared evidence, so reordering a gallery or editing one description is drift, not a cosmetic change.

Publication legitimately leaves a target's media rows carrying `public_url`, `public_storage_bucket`, `public_storage_path` and `is_public_approved` while the private source row is preserved. That expected mapping is not classified as drift; it is instead proved coherent, and a mapping that names anything other than the deterministic destination the plan would bind is refused as `PUBLISHED_MEDIA_MAPPING_INVALID`.

That authority is proved twice: once when the operation is reserved and its confirmation evidence (`confirmed_preview_id`, `confirmed_at`) is frozen into immutable operation intent, and again inside `mark_public_feed_write_started` at the final durable boundary immediately before any public side effect. The final check re-establishes admin authority, owner epoch and token currency, that the target is still `published`, that it is still absent from the deployment head, and that the frozen confirmation evidence still matches, rather than trusting an earlier application-side preflight. Once write intent is durable, the mutable drift gate deliberately does not run again, so a later lifecycle edit cannot make recovery converge on a different candidate.

A persistent taxonomy rename after reservation is rejected by that final readiness comparison. The remaining ABA case is closed at its mutation boundary: while a project has an active public-feed operation, `UPDATE` or `DELETE` of a `disciplines` or `industry_categories` row referenced by that project fails with `PUBLIC_FEED_OPERATION_IN_PROGRESS`. Unreferenced lookup rows remain mutable, and creating a new unlinked lookup row remains available. Discipline names are a direct public candidate dependency through the emitted `disciplines` array. Industry-category names are not currently emitted by `toPublicFeedRecord`, but they remain immutable participant-confirmation evidence used by publication and reconciliation readiness.

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
*   `snapshotMedia` — Exact `{ url, altText, galleryPosition }` pairing for every snapshot
*   `layoutConfig` — Visual preset settings object containing `templateId`.

### Runtime Validator Field Rules
The runtime validator behaves as follows:
*   Requires the above fields to be present and non-null.
*   Checks `id` is an integer.
*   Checks `teamMembers` is an array (does not currently check if every element inside the array is a string).
*   Requires non-blank bounded `posterText` and `accessibilityText` values.
*   Checks that each snapshot URL is an absolute HTTP(S), structurally public-safe URL; rejects malformed, relative, non-HTTP(S), private-draft, private-ingestion, signed, and authenticated-storage URLs. It does not perform network reachability checks.
*   Inspects the URL path canonically rather than only in its raw form. A private identifier can survive `URL.pathname` percent-encoded, so the validator matches its markers against the raw path and against a bounded number of decoded forms (at most three passes). Malformed percent-encoding, and encoding that cannot be resolved inside that budget, fail closed. The decoder is deliberately bounded rather than recursive.
*   Requires unique snapshot URLs and an exact one-to-one correspondence with `snapshotMedia`; each media item has only `url`, non-blank bounded `altText`, and an authoritative integer `galleryPosition` from 1 through 10. Entries must follow strictly increasing gallery order and align with `snapshots` at the same index.
*   Does **not** require `galleryPosition` values to be contiguous or to equal an array index. A unique increasing set inside 1 through 10 is valid, so `[2]` and `[2, 5]` are both accepted. Consumers must preserve the authoritative values rather than renumbering them.
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

A durable operation may only be claimed or reused by a request whose complete immutable intent matches it: kind, publication mode, target `publicId`, rollback preparation handle, confirmed preview evidence and confirmation instant, private media bucket, archive reason, requested rollback capability, and canonical bucket/path. A `RECOVERY_REQUIRED` operation additionally requires the operator to name that exact operation. A request carrying materially different intent is refused rather than adopting the durable candidate or rebinding under stale metadata.

### Public media authorization boundary

Public media promotion is split across the durable forward-commit boundary, which is `WRITE_STARTED`:

*   Before the boundary, the operation may still fail safely, so nothing may become publicly readable. The lease is renewed and its result checked, and the bound media manifest is re-read and re-validated — private source bytes must still hash to the value captured at binding, and any existing public destination must already hold identical bytes. A failure here fails the operation closed with zero task-created public objects.
*   `mark_public_feed_write_started` re-validates current administrator permission, current publication readiness against the operation's own confirmed preview evidence, and the owner epoch/token. A stale owner, revoked permission, or stale readiness stops the operation before any public exposure.
*   After the boundary, and only then, bound media is copied into the public assets bucket, followed by the canonical feed write. Promotion is idempotent and replayable, so a crash part-way through is completed forward by a later recovery owner from the same immutable manifest.
*   No path deletes public media. Reverse compensation is deliberately absent: objects that predate an operation are never removed, and a partially promoted manifest converges forward rather than being rolled back.

### Target-specific completion evidence

Membership in the current head answers only whether a `publicId` is currently deployed. The operation, snapshot, and audit identifiers reported for an idempotent retry are resolved from that target's own immutable history:

*   A publication retry reports the most recent publication version naming that target whose deployed record bytes are identical to the record currently at the head. That keeps a rollback honest, because a restored head only matches the publication that actually produced those bytes.
*   A removal retry reports the most recent removal version naming that target, unless a later publication of the same target supersedes it. A removal that legitimately wrote no version — the target was already absent — is evidenced by the completed removal operation whose bound candidate is byte-identical to the current head.
*   When no target-specific evidence explains the current state, no identifier is substituted from the head or from a rollback. Publication returns `NOT_READY` with readiness code `ALREADY_DEPLOYED_UNVERIFIED`; removal executes a genuine target-specific operation instead.
*   `snapshotId` and `auditRecordId` are nullable by contract. Deployment reconciliation writes no approval record, and a no-change removal writes neither, so those results report `null` rather than an empty or borrowed identifier.

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
*   **Snapshot Accessibility**: `bodyend.html` preserves the `snapshots` URL order used by the existing gallery and lightbox, and resolves each rendered image's governed alternative from `snapshotMedia` by exact URL. It never pairs alternatives by independent array index and omits malformed or unpaired entries.
*   **Gallery Positions**: `bodyend.html` carries each authoritative `galleryPosition` through untouched and never fabricates one, so a server-valid non-contiguous gallery such as `[2]` or `[2, 5]` stays visible. It drops an entry only where the server contract also treats it as invalid (out-of-range or contested position, duplicate or unpaired URL, blank alternative) or where rendering it would be unsafe.
*   **Featured Media**: `featuredMedia` is an inert presentation preference. `auto` is a first-class authoritative value emitted by the import mapping, and the renderer resolves it — like any value it does not recognize — through its documented preference order: video, then the governed gallery, then the poster. An unrecognized preference never rejects the public feed.
*   **Public URL Policy**: `bodyend.html` requires every active URL (`poster`, `posterPdf`, `snapshots`, `videoUrl`, `demoUrl`, `repositoryUrl`, `externalLinks[].url`) to be an absolute, credential-free HTTP(S) URL. General external links keep legitimate query strings, so ordinary demo and repository links and YouTube `watch?v=` URLs continue to work. Any URL that identifies Supabase Storage — by host, or by the `/storage/v1/` object API path in any canonical form — is additionally never allowed to expose a signed route, an authenticated route, a private or draft bucket, or token-bearing access, in whichever field it arrives. Path inspection is canonical and bounded on the same rule as the server validator.

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
