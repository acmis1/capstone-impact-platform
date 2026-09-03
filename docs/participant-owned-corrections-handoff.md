# Participant-owned correction integration

Local integration of PR #255 with current main, the PDF interaction correction from #257, the #259 evidence-only reconciliation boundary, and participant-owned complete correction packages. No hosted operation or publication is part of this work. Final UAT and stakeholder sign-off remain required.

## Advisor concern and ownership

Project teams author submitted public content. Staff assess technical completeness, request a corrected source package, review an exact immutable revision, and retain approval and publication authority. Ordinary staff content editing and assistive apply paths are disabled at both the UI and server-action boundary.

| Owner | Fields and actions |
| --- | --- |
| Project team | Title, summary, background, solution, year, submitted program/study program and classifications, industry partner, supervisor, group, team names, contact email, poster full text, accessibility description, image descriptions, ordered media files, controlled video/demo/repository URLs, package layout selection. Corrections arrive through the complete source package. |
| Staff/system | Review comments and dispositions, technical checks, lifecycle state, approval, publication/removal authority, reference datasets and reconciliation evidence, canonical catalogue administration, audit identities, storage identities, imports, timestamps, preview issuance/revocation and notification scheduling. |
| Historical evidence | Preview snapshots, confirmations, original correction comments and audit evidence are immutable. Existing request/preview lifecycle fields record revocation, review start and corrected-preview reissue. Legacy generic external links/citations are preserved; this package contract does not expose an editor for them. |

## Pre-preview package replacement

Before the first participant preview, authenticated staff with combined edit/review authority can transport a complete corrected package supplied by the project team. The project detail page offers **Replace project-team package** for `draft`, `submitted`, `in_review`, and `changes_requested` projects. An incomplete import, any historical preview, archived/published/approved state, or active publication/removal operation closes this path. Project identity comes from the selected existing project, never the workbook or an extra form field.

This reuses the participant package parser, immutable reservations, private Storage, exact comparison and acceptance transaction. The bounded source discriminator is `staff_pre_preview` versus `participant_capability`; the staff transport actor is distinct from project-team content authorship. Three distinct reservations are allowed per current project revision, including failed uploads. Begin review freezes the selected package and pauses approval/uploads. Acceptance preserves the current review state. Returning the package changes no content and releases the freeze, including when separate governance changes have made the frozen base stale. Staff then perform normal checks and approval before issuing the first preview.

## Validation history

The project revision includes all validation flag rows. Acceptance locks them and captures their full prior state. Only known deterministic `validateImportPackage` rule/field pairs that passed revalidation of the exact new package receive `resolved`, actor and time. The old row is retained in immutable recovery evidence tied to the submission, hash and acceptance actor. Existing resolved rows, unknown/governance rules, mismatched fields and recommendations still present in the replacement remain unchanged. No validation flag is deleted. The read-only comparison shows which findings will resolve and which remain open.

The disposable initial-review scenario proves a corrected missing-image-description error resolves, an unknown governance error still blocks review evidence, mismatched rule identity remains unresolved and historical resolved evidence is unchanged. Separate explicit staff governance resolution is required before that scenario finishes normal approval.

## Participant correction flow

An approved project's active, unexpired, unconfirmed preview accepts a correction comment. The same capability then offers a plain same-origin multipart form: one project-details XLSX workbook, one poster image, one poster PDF and up to ten numbered supporting images. No participant account, JavaScript editor, CMS access, bucket name, project selector or content override is required.

The server reparses the workbook and validates actual media bytes. Each distinct package is durably reserved, privately uploaded and completed before it becomes a submitted candidate. Submission never changes authoritative project content. The exact same package can retry safely; a later completed package supersedes an earlier candidate until review begins. Three distinct reservations per correction request bound abandoned uploads as well as successful submissions.

Staff compare current and proposed metadata, canonical classifications, file identities, descriptions, omissions and validation warnings. **Begin review of this revision** freezes one exact candidate, revokes Preview A and moves the project to changes requested. Uploads and confirmation through A then fail closed. **Accept this participant revision** applies the frozen revision; **Return this revision** preserves the draft. After either decision, staff perform normal checks and reapproval. A corrected preview is generated, the project team confirms its exact content, and publication readiness may become READY. Neither acceptance nor participant confirmation publishes or sends email.

## Security boundaries

- Preview capability: 256 random bits encoded as 64 hex characters; only its SHA-256 hash is persisted. Uniform unavailable responses cover revoked, expired, unknown, confirmed and frozen capabilities.
- Exact same-origin checks precede body parsing; no forwarding-header authority. Private no-store/noindex responses and strict-origin referrers keep token paths out of outgoing referrers. External links use isolated opener/referrer semantics. Development request logging omits participant preview paths.
- Actual request bytes are bounded at 33 MiB, with 32 MiB of files, 13 file parts, 8 KiB per part header and a 120-second body deadline. Workbook/image/PDF limits are 5/5/20 MiB. One parser/upload runs per Node process; concurrent requests receive a bounded rejection.
- XLSX validation bounds ZIP entries and expansion, worksheets, rows, columns, XML elements, cell ranges and defined-name expansion before ExcelJS allocation. Unsafe paths, macros, entities and external non-hyperlink relationships fail. Ordinary web hyperlinks are treated as text and never fetched.
- Filenames, extensions, MIME, signatures, file sizes, controlled URLs, required fields and supporting-image descriptions are validated. No raw JSON or caller-authored metadata is accepted from the participant or staff decision endpoint.
- Staff decisions require authenticated combined edit/review authority and only action, submission UUID, package hash and expected full project revision. Service-only RPC grants and RLS repeat authority at the database boundary.
- Production participant images remain HTTPS-only. Development permits HTTP solely at the configured loopback Storage origin; scripts and embeds remain blocked.

## Database and Storage

Migration **0051**, `20260903130000_participant_owned_corrections.sql`, includes both package origins. It was revised while local and unmerged; earlier migrations remain byte-identical in this follow-up. The application inventory contains 51 migrations and includes four new private tables: `participant_correction_submissions`, `participant_correction_prior_revisions`, `participant_correction_recovery_rows` and `participant_correction_events`. Six service-only RPCs provide project revision hashing, participant/staff context, reservation, completion and staff review. The obsolete staff-authored resolution-start RPC now rejects that path.

Source packages use `participant-corrections-private`. Accepted media is prepared at unique immutable paths in `project-drafts-private`; copy reuse requires exact bytes. Both private buckets are included in the recovery inventory. There is no Storage deletion path in correction submission or acceptance.

The authoritative acceptance transaction locks the project/correction/candidate, compares the frozen whole-project revision, checks lifecycle and private media, and captures the complete previous project plus every media/mapping row. Recovery rows retain original identities and all row data, joined to an immutable acceptance header containing project, request, submission, candidate hash, expected revision, staff actor and operation time. Submission identity is the unique acceptance operation.

Only omitted rows belonging to that exact project and old revision are retired: `media_assets`, `project_disciplines`, and `project_industry_categories`. Shared `programs`, `disciplines` and `industry_categories` catalogue rows are never deleted. Metadata application, mapping/media replacement, recovery evidence and decision audit share one database transaction. Any error rolls all database effects back. Old Storage objects remain intact. Bounded newly prepared objects remain reserved for exact retry if upload or transaction completion fails; no cleanup guesses at an uncertain commit. Replayed accepted decisions return the existing receipt without reapplying content or retiring rows again.

## Direct staff edit audit

| Former path | Final status |
| --- | --- |
| Project information editor / saveProjectMetadataAction | Read-only ownership guidance; the actual server action rejects content writes before creating any database client. |
| Gallery/snapshot alt editor / saveSnapshotAltTextAction | Descriptions remain visible in order; no input/save control. The actual server action rejects direct writes. |
| Authorized metadata and snapshot-alt service wrappers | Reject direct admin/editor content mutation. Historical lower-level implementation remains available only to internal code/tests; no ordinary staff action calls it. |
| OCR title and language suggestion apply controls | Removed. Run/cancel checks, copy suggestions and staff review dispositions remain. |
| Old correction-resolution start endpoint/RPC | Replaced by strict exact-revision decisions; the legacy RPC cannot open an editable draft. |
| Browser import metadata/media staging | Initial participant package intake remains. The server reparses authoritative source files; existing public IDs and conflicting media identities fail. It is not an existing-project correction editor. |
| Admin reference reconciliation | Read-only comparison/evidence; does not author participant metadata or silently remap taxonomy. |
| Legacy createProject/uploadDraftMediaAsset helpers and local scripts | No ordinary staff UI/API call sites. Local fixture/import scripts remain operator tooling, outside the ordinary content-edit workflow. |
| Review, technical findings, preview operations and publication controls | Retained as staff/system governance. Acceptance does not call publication or email code. |

## Verification and handoff

The repository runtime verifier is `apps/admin-cms/src/scripts/verifyParticipantOwnedCorrectionsRuntime.ts`. It requires a proven-owned disposable stack identity and cannot fall back to the primary or hosted stack. It covers real changed image/PDF bytes, exact gallery and mapping removal, shared catalogue retention, complete recovery, historical evidence, partial Storage failure, forced database retirement failure, duplicate/concurrent acceptance, competing uploads, quota, stale/cross-project/public-state denial, return and repeated correction cycles, normal reapproval, Preview B, fresh confirmation and post-confirmation link staleness.

The external local handoff contains the exact final test totals, Edge desktop/mobile/keyboard evidence, cleanup proof, final commit/tree, changed-file blob manifest and cumulative patch checksum. It is the evidence for this integration candidate; this document records the ongoing workflow and recovery contract. No advisor acceptance or hosted deployment is claimed.
