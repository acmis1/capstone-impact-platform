# Implementation Backlog

This document maps out the completed project baseline, foundations present, and prioritized delivery backlog for the Capstone Impact Platform.

---

## 1. Current Completed/Verified Baseline
*   **Prototype Recovery**: Successful database recovery (10 project records, 6 public-feed records) and poster repairs completed.
*   **Render Deployment**: Prototype web service successfully deployed from `main` branch to Render and confirmed Live.
*   **Duda Test-Site Verification**: Client-side listing and detail rendering manually verified on the Duda test-site.
*   **Admin CMS Foundation**: Modular Next.js app structure, TypeScript domain models, and migrations `0001` - `0013`. Migration `0010` (`20260810090000_atomic_browser_import_metadata_stage.sql`) introduced atomic, service-role-only browser import metadata staging and idempotency transaction; Migration `0011` (`20260810120000_atomic_browser_import_media_stage.sql`) introduced `media_assets` idempotency uniqueness, a `browser_import_media_commits` ledger, and an atomic `finalize_browser_import_media_stage` RPC that uploads selected packages' poster/PDF/snapshot media into the private draft bucket, registers `media_assets` rows, and transitions an import batch from `metadata_staged` to `completed` (projects remain `draft`; nothing is made public). Migration `0012` (`20260810150000_atomic_import_batch_review_submit.sql`) introduced the `submit_for_review` audit action and an atomic `submit_import_projects_for_review` RPC that transitions eligible imported projects (`draft`/`changes_requested`) into `submitted`, gated by `projects.edit` (a preparation/editing action, distinct from reviewer `projects.review` approve/request-changes/archive actions). Migration `0013` (`20260810180000_participant_preview_links.sql`) introduced the `participant_previews` table and three service-role-only RPCs (`generate_participant_preview`, `revoke_participant_preview`, `resolve_participant_preview`) implementing secure, token-protected, time-limited participant preview links for `approved` projects — see the "Secure Participant Preview" entry below. Migrations `0001` - `0009` remain unchanged, and migrations `0007` - `0013` are unapplied to hosted staging.
*   **Secure Participant Preview**: After a project reaches `approved`, authorized staff (the existing `projects.review` permission — admin/reviewer) can generate a private, token-protected, time-limited (7-day default) participant preview link from the project detail page, and revoke it. The raw preview token is a server-generated 256-bit value returned exactly once at generation time; only its SHA-256 hash is ever persisted. At most one active preview exists per project at a time (enforced by a DB partial unique index, not only application logic); staff must explicitly revoke before reissuing. Generation captures an immutable, server-derived snapshot of the participant-facing project fields and private media references — later edits to the project never change an already-issued preview. Participants open `/participant-preview/[token]` without any Admin/CMS session; the route hashes the supplied token, resolves only an exact active/unexpired/unrevoked match, and renders the frozen snapshot with short-lived (5-minute) signed URLs for the referenced private draft-bucket media only. Every invalid/expired/revoked/unknown token renders the identical generic "unavailable" response, and the route sends `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`, and a `no-referrer` policy. Nothing is published; no participant confirmation, correction, or reissue workflow exists yet.
*   **Initial Admin Authentication Activation (Staging)**: Initial administrator authentication operationally verified in isolated staging (`capstone-admin-cms-staging-2026`).
*   **Transactional Review Actions**: Atomic PostgreSQL RPC function `public.perform_project_review_action` (Migration 0008), repository integration, API route handler, static contract tests, and comprehensive local atomicity/rollback verifications implemented and merged into `main` via PR #36 (verified locally on Windows with Docker Desktop; migrations `0007` and `0008` remain unapplied to hosted staging; macOS, Linux, and independent human verification remain pending).
*   **Import Batch Review Readiness & Submit-to-Review**: Server-authoritative readiness derivation (required metadata, program/discipline/industry-category relationships, blocking validation errors, staged private media consistency) surfaced on an upgraded multi-project `/admin/imports/[batchId]` review surface and on the project detail page. Authorized preparation staff (`projects.edit`) can select one or more ready projects from a `completed` import batch and atomically submit them for administrative review (`draft`/`changes_requested` → `submitted`), with one auditable `approval_records` entry per actual transition. Nothing is made public; existing reviewer actions (approve/request_changes/archive) become available once a project reaches `submitted`. The workflow sequence is now: browser folder selection → preview → commit intent → atomic metadata staging → private media staging → completed import batch → review readiness / submit for review → existing reviewer workflow → **secure participant preview** → future participant confirmation/corrections → future publication (not yet implemented).

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
*   **Participant Preview Link** *(foundation implemented — see "Secure Participant Preview" in Section 1)*: Generate token-based, private, secure preview URLs for participant groups, with preview-token expiry and revocation rules. Remaining: participant confirmation, correction requests, admin resolution, and reissue are not yet implemented.
*   **Email Notification**: Send automated preview emails containing preview links to participant group contact addresses.
*   **Reminder Scheduling**: Schedule automated email reminders to groups if confirmation is pending, tracking reminder history.
*   **Review Workflows**: Bulk review and cross-check metadata manually before preview generation.
*   **Participant Response Handling**:
    *   *Participant Confirmation*: Record an explicit participant confirmation and timestamp (auditable final sign-off).
    *   *Correction Requests*: Record correction-request comments, status, and timestamps.
    *   *Admin Resolution*: Admin resolution of participant corrections, triggering regenerated/reissued previews and participant re-notification.
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
*   **Approval Gate**: Controlled editing of approved/published database records. Changes require revalidation and, where appropriate, reapproval before republishing.
*   **Staged Publication**: Compiling eligible approved and published records into `capstones-latest.json` and uploading it to public Supabase Storage, with safe publication failure handling.
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
