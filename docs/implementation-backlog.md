# Implementation Backlog

This document maps out the completed project baseline, foundations present, and prioritized delivery backlog for the Capstone Impact Platform.

---

## 1. Current Completed/Verified Baseline
*   **Prototype Recovery**: Successful database recovery (10 project records, 6 public-feed records) and poster repairs completed.
*   **Render Deployment**: Prototype web service successfully deployed from `main` branch to Render and confirmed Live.
*   **Duda Test-Site Verification**: Client-side listing and detail rendering manually verified on the Duda test-site.
*   **Admin CMS Foundation**: Modular Next.js app structure, TypeScript domain models, and migrations `0001` - `0019`. Migration `0010` (`20260810090000_atomic_browser_import_metadata_stage.sql`) introduced atomic, service-role-only browser import metadata staging and idempotency transaction; Migration `0011` (`20260810120000_atomic_browser_import_media_stage.sql`) introduced `media_assets` idempotency uniqueness, a `browser_import_media_commits` ledger, and an atomic `finalize_browser_import_media_stage` RPC that uploads selected packages' poster/PDF/snapshot media into the private draft bucket, registers `media_assets` rows, and transitions an import batch from `metadata_staged` to `completed` (projects remain `draft`; nothing is made public). Migration `0012` (`20260810150000_atomic_import_batch_review_submit.sql`) introduced the `submit_for_review` audit action and an atomic `submit_import_projects_for_review` RPC that transitions eligible imported projects (`draft`/`changes_requested`) into `submitted`, gated by `projects.edit`. Migration `0013` (`20260810180000_participant_preview_links.sql`) introduced the `participant_previews` table and three service-role-only RPCs (`generate_participant_preview`, `revoke_participant_preview`, `resolve_participant_preview`) implementing secure, token-protected, time-limited participant preview links for `approved` projects. Migration `0014` (`20260811090000_participant_preview_confirmations.sql`) introduced the `participant_preview_confirmations` table and `confirm_participant_preview` RPC. Migration `0015` (`20260811120000_participant_preview_correction_requests.sql`) introduced `participant_preview_correction_requests` and `request_participant_preview_correction`. Migration `0016` (`20260811130000_participant_preview_correction_resolution.sql`) introduced `start_participant_preview_correction_resolution` and controlled preview reissuance for correction resolution — see Section 3 below. Migration `0017` (`20260811150000_publication_readiness_gate.sql`) introduced `get_project_publication_readiness` and hardened public feed compilation to `published` projects only — see "Publication Readiness Gate" entry below. Migration `0018` (`20260811160000_approval_edit_gate.sql`) blocks direct metadata edits for approved and published projects and requires the existing review/correction workflow to reopen approved work. Migration `0019` (`20260812120000_controlled_publication_execution.sql`) introduces the durable, globally serialized publication-attempt ledger, active-attempt mutation freeze, and service-role-only begin/finalize/failure RPCs used by the Local Supabase controlled execution foundation. Migrations `0001` - `0018` remain unchanged, and migrations `0007` - `0019` are unapplied to hosted staging.
*   **Secure Participant Preview**: After a project reaches `approved`, authorized staff (the existing `projects.review` permission — admin/reviewer) can generate a private, token-protected, time-limited (7-day default) participant preview link from the project detail page, and revoke it.
*   **Participant Confirmation**: Beneath the rendered preview, a participant may explicitly confirm — via a plain same-origin POST form — that the project information shown in this exact preview version is correct.
*   **Participant Correction Requests**: As the mutually exclusive alternative to confirmation, a participant may instead submit a plain-text correction request describing what needs to change about the exact preview version shown.
*   **Admin Correction Resolution & Controlled Preview Reissue**: Authorized staff holding combined `projects.edit` AND `projects.review` authority can start administrative resolution on an `open` participant correction request via the service-role-only `start_participant_preview_correction_resolution` RPC (Migration 0016). Starting resolution atomically revokes Preview A, transitions project status from `approved` to `changes_requested`, records an auditable `approval_records` entry, and sets request status to `in_progress`. When edits are ready and project status is reapproved, staff reissues a preview (`isCorrectionReissue = true`), capturing a fresh snapshot for Preview B and transactionally setting correction status to `resolved` with `replacement_preview_id` referencing Preview B.
*   **Publication Readiness Gate**: Service-role-only `get_project_publication_readiness` RPC (Migration 0017) evaluates authoritative publication eligibility. A project is publication-ready ONLY IF status is `approved`, exactly one active preview exists, that exact preview is confirmed by the participant, has ZERO unresolved or open correction requests, and current canonical participant-facing project metadata and authoritative private media match the confirmed preview snapshots (order-independent media comparison). `compilePublicFeed` is hardened to include `published` projects ONLY (`approved` projects are no longer feed-eligible). Readiness is rendered read-only on the project detail page. Actual publication, Duda upload, and public storage writes are not performed.
*   **Publication Preparation Plan**: Admin-only, server-authoritative dry-run preparation verifies fresh publication readiness, resolves deterministic final public-media URLs, compiles existing published projects plus one exact READY approved candidate through the public allow-list, validates the proposed artifact, and reports deterministic count/hash with exact confirmation evidence. The UI remains plan-only and performs no publication write.
*   **Controlled Publication Execution Foundation**: A server/core coordinator, exercised only by a disposable Local Supabase runtime verifier, binds fresh readiness and final artifact evidence to a durable globally exclusive attempt; promotes verified private media without deleting its source; protects/restores the prior canonical feed around verified upload; and atomically commits project status, public media mappings, one `publish` audit, one snapshot, and the completed attempt. Sequential/concurrent retry and failure compensation are fail-closed. No user-facing Publish control, hosted rollout, Duda action, email, long-term feed history, or administrative rollback is included.
*   **Initial Admin Authentication Activation (Staging)**: Initial administrator authentication operationally verified in isolated staging (`capstone-admin-cms-staging-2026`).
*   **Transactional Review Actions**: Atomic PostgreSQL RPC function `public.perform_project_review_action` (Migration 0008), repository integration, API route handler, static contract tests, and comprehensive local atomicity/rollback verifications implemented and merged into `main` via PR #36.
*   **Import Batch Review Readiness & Submit-to-Review**: Server-authoritative readiness derivation surfaced on `/admin/imports/[batchId]` and project detail page. Authorized preparation staff (`projects.edit`) can select ready projects and submit them for administrative review (`draft`/`changes_requested` → `submitted`).

---

## 2. Priority 0 — Remaining Auth, Roles, and Governance Work
*   **School-Approved Identity Provisioning**: Design, implement and verify a separately approved multi-user administrator provisioning workflow for additional school staff. The existing `bootstrap_initial_admin` operation is restricted to the first administrator and same-identity idempotent recovery.
*   **Role Acceptance Testing**: Verify reviewer and editor role matrices, RLS policies, and mutation permissions.
*   **Session Governance**: Test session-expiry timing, CSRF protection, and audit record attribution during project mutations.
*   **Staff UAT & Handover**: Conduct non-technical staff usability testing and transfer project ownership.

---

## 3. Priority 1 — Submission, Cross-Check, Preview, and Participant Confirmation
*   **Folder Ingestion**: Bulk folder uploads reading project structure and asset packages.
*   **Excel Cross-Check**: Build the administrative parser matching column headers in `project-details.xlsx` against database fields.
*   **Participant Preview Link** *(implemented — see "Secure Participant Preview" in Section 1)*: Generate token-based, private, secure preview URLs for participant groups, with preview-token expiry and revocation rules.
*   **Email Notification**: Send automated preview emails containing preview links to participant group contact addresses.
*   **Reminder Scheduling**: Schedule automated email reminders to groups if confirmation is pending, tracking reminder history.
*   **Review Workflows**: Bulk review and cross-check metadata manually before preview generation.
*   **Participant Response Handling**:
    *   *Participant Confirmation* *(implemented — see "Participant Confirmation" in Section 1)*: Record an explicit participant confirmation and timestamp (auditable final sign-off), keyed to the exact preview version.
    *   *Correction Requests* *(implemented — see "Participant Correction Requests" in Section 1)*: Record correction-request comments, status, and timestamps, keyed to the exact preview version and mutually exclusive with confirmation.
*   **Admin Correction Resolution & Controlled Preview Reissue**: Authorized staff holding combined `projects.edit` AND `projects.review` authority (admin role, or dual editor+reviewer staff) can start administrative resolution on an `open` participant correction request via the service-role-only `start_participant_preview_correction_resolution` RPC (Migration 0016). Starting resolution atomically revokes the active Preview A (if its ID matches target Preview A), transitions the project from `approved` to `changes_requested`, records an auditable `approval_records` entry (`request_changes`), and marks the correction request as `in_progress`. If resolution is already `in_progress`, calling the start RPC again is idempotent and returns `ALREADY_IN_PROGRESS`. Attempting to start resolution when a conflicting active preview exists for another version of the project fails closed (`CONFLICTING_ACTIVE_PREVIEW`) without mutating project state or audit records. While `in_progress`, staff may perform required project metadata updates; ordinary preview generation remains blocked (`CORRECTION_RESOLUTION_REQUIRED`). When edits are ready, staff issue a controlled preview reissue by passing `isCorrectionReissue = true` to `POST /api/projects/[publicId]/participant-preview` (which independently enforces combined edit+review permissions at the application boundary). The 6-argument `generate_participant_preview` RPC validates that exactly one `in_progress` correction exists (failing closed with `AMBIGUOUS_CORRECTION_REQUEST` if multiple exist), captures a fresh immutable snapshot for Preview B, marks Preview B as `active`, and completes the resolution transactionally by setting the correction request status to `resolved` and setting its `replacement_preview_id` to Preview B's ID. Reissuing Preview B requires project status to be reapproved (`approved`); reapproval, email notification, and automated reminders are not included.
*   **Admin Audit Trail**: Record administrative changes and participant confirmations in logs.

---

## 4. Priority 2 — AI/OCR and Accessibility Workflow
*   **OCR Poster-Text Extraction**: Extract text from poster PDF files to pre-fill metadata fields.
*   **Full-Text Accessibility Alternatives**: Generate complete reviewed text descriptions for images and posters.
*   **Spelling and Grammar**: Spelling and grammar assistance on extracted or manual text.
*   **Title and Formatting Consistency**: Highlight mismatches between the spreadsheet metadata title and poster title.
*   **Image/Text Consistency Assistance**: Flag mismatched media files or missing elements.
*   **Formatting Checks**: Automated text formatting validation (e.g., string lengths and character constraints).
*   **Asset Constraints Validation**: Automated validation checks on asset constraints such as image dimensions, file size limits, MIME types, and folder/package structures.
*   **Duplicate Detection**: Check project IDs and directories to block duplicate imports.
*   **Deterministic Fallback**: Ensure the system remains fully functional via manual entry if OCR/AI endpoints fail.
*   **Privacy & Cost Controls**: Limit OCR/AI token counts and process files locally where possible.
*   **Mandatory Human Review**: Prevent any OCR/AI output from auto-approving or auto-publishing without staff review.

---

## 5. Priority 3 — Approval, Publication, Archive, History, and Rollback
*   **Approval/Edit Gate** *(implemented)*: Migration 0018 blocks direct metadata changes to approved records until an authorized Request changes action reopens them, revoking the sole active participant preview atomically while preserving historical evidence. Published records are immutable pending a future controlled revision/republish workflow.
*   **Staged Publication** (foundation implemented; production control still pending): controlled Local Supabase execution now covers public-feed write, authoritative `published` transition, durable snapshot/audit, failure compensation, deterministic public-media promotion, and post-publication convergence. A reviewed production-facing control and hosted rollout remain future work.
    * **Publication Preparation Plan — implemented in this slice**: admin-only dry-run preparation evaluates the published baseline plus one READY approved target, with fresh readiness and deterministic artifact evidence.
    * **Controlled Publication Execution Foundation — implemented in this slice**: Migration 0019 and the server/core coordinator implement a durable two-phase protocol — a global reservation is taken before any global publication baseline is observed, then the exact artifact, previous-feed evidence and public-media ownership baseline are bound to that reservation, then storage is written, then a single atomic transaction converges the database. Expired-attempt recovery is restricted to the original owning admin with execution-token rotation, and compensation ownership of public media is durable so it survives process death. Verified by 39 explicit disposable Local Supabase scenarios. There is deliberately no Publish button or production-triggerable endpoint.
*   **Archive and Unpublish**: Mark projects as archived, removing them from the public feed compilation while preserving history in PostgreSQL.
*   **Public-Removal Verification**: Ensure public-removal verification: publishing completion, fresh-feed retrieval, cache-busting or refresh verification, confirmation that the archived item is absent from Duda listing/detail rendering, and public-removal completion timestamp/audit record.
*   **Feed History & Rollback**: Save timestamped backup copies of the feed and implement controlled, authorized rollback (checksum verification, selected snapshot restoration, post-rollback feed and Duda verification, audit attribution, failure handling). A dashboard control may be a future interface, but instant restoration must not be promised.
*   **Audit and Retry**: Audit attribution for all publication status transitions, with idempotent retry behavior.

---

## 6. Priority 4 — UAT, Performance, Staff Handover, and Success Measurement
*   **Accessibility Compliance Check**: Perform accessibility keyboard and screen-reader tests on Duda and Admin UI.
*   **Performance & Scaling Verification**: Load-test database queries and file storage bandwidth under a target of at least **100 projects per year**.
*   **Non-technical Staff UAT**: Conduct usability testing with school administrative staff.
*   **Documentation & Training**: Deliver a complete administrator user guide.
*   **Institutional Handover**: Execute the transfer of school-controlled accounts:
    *   GitHub repository admin rights
    *   Supabase database and storage project ownership
    *   Render hosting account and billing
    *   Duda editor access and publishing authority
    *   Email / SMTP server account
    *   AI/OCR provider account and billing
    *   Domain / subdomain ownership
    *   Backup and incident-response ownership
*   **Success Measurement**: Verify that the publishing workflow demonstrates at least a **50% time or manpower reduction** compared to manual Duda page creation.

---

## 7. Optional Enhancements
*   **Community Voting**: Embed optional participant and visitor voting widgets on Duda pages (must not block the core publishing path).

---

## 8. Open Institutional Decisions
*   **Long-Term Operational Owner**: Handover target alias.
*   **Data and Public-Asset Retention**: Policy regarding how many semesters of data are kept in storage before archiving.
*   **Approved Email Delivery Arrangement**: Approved university mail server / SMTP endpoint.
*   **Approved AI/OCR Provider & Privacy Terms**: Privacy-compliant cloud extraction API and terms approval.
*   **Official Production Duda Access**: Production publishing authority and site access.
*   **Recovery and Incident-Response Owner**: Designated support contact.

---

## 9. Definition of Done
A backlog item is defined as done when it meets the following criteria.

### Universal Completion Requirements
1.  Acceptance criteria met.
2.  Documentation is updated.
3.  No unresolved blocking defects.
4.  Relevant security and privacy reviews completed.
5.  Verified in the appropriate environment.
6.  Evidence of completion recorded.

### Additional Requirements (Where Applicable)
*(Note: "Where applicable" applies only to requirements genuinely relevant to the specific backlog item, not to the universal definition of done).*
1.  Typed Next.js/TypeScript implementation.
2.  PostgreSQL database migrations applied to `capstone-admin-cms-staging-2026`.
3.  Unit and integration tests pass (Vitest).
4.  Accessibility compliance testing.
5.  Administrative staff UAT and staging acceptance signed off.
6.  Rollback and recovery verification completed.
7.  Institutional ownership and handover complete.
