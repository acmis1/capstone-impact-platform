# Implementation Backlog

This document maps out the completed project baseline, foundations present, and prioritized delivery backlog for the Capstone Impact Platform.

---

## 1. Current Completed/Verified Baseline
*   **Prototype Recovery**: Successful database recovery (10 project records, 6 public-feed records) and poster repairs completed.
*   **Render Deployment**: Prototype web service successfully deployed from `main` branch to Render and confirmed Live.
*   **Duda Test-Site Verification**: Client-side listing and detail rendering manually verified on the Duda test-site.
*   **Admin CMS Foundation**: Modular Next.js app structure, TypeScript domain models, database migrations (`0001` - `0003`), feed compiler, public schema validator, mock fixtures, and unit tests have been successfully built and verified in `main`.

---

## 2. Foundations Present but Not Operationally Activated
*   **Admin Authentication**: Server-side admin route guards, session validation, permission checks, and auth migrations exist in repository code, but real staging identities, environment activation, and successful manual login verification remain pending.

---

## 3. Priority 0 — Admin Identity and Environment Activation
*   **Staging Activation**: Activate the Admin/CMS against the separate `capstone-impact-staging` environment (never use the Prototype recovery Supabase project).
*   **Identity Provisioning**:
    *   Provision school-approved identities in Supabase Auth, link them to `admin_users`, and assign recognized roles.
    *   Prohibit public self-registration.
    *   Verify real staging sessions without printing credentials.
*   **Staging Verification**: Confirm staging auth readiness checks, perform manual login tests, check protected pages and APIs, verify PostgreSQL Row-Level Security (RLS) tables, and verify server-only credentials.

---

## 4. Priority 1 — Submission, Cross-Check, Preview, and Student Confirmation
*   **Folder Ingestion**: Bulk folder uploads reading project structure and asset packages.
*   **Excel Cross-Check**: Build the administrative parser matching column headers in `project-details.xlsx` against database fields.
*   **Student Preview Link**: Generate token-based, private, secure preview URLs for student groups, with preview-token expiry and revocation rules.
*   **Email Notification**: Send automated preview emails containing preview links to student group contact addresses.
*   **Reminder Scheduling**: Schedule automated email reminders to groups if confirmation is pending, tracking reminder history.
*   **Review Workflows**: Bulk review and cross-check metadata manually before preview generation.
*   **Student Response Handling**:
    *   *Student Confirmation*: Record an explicit student confirmation and timestamp (auditable final sign-off).
    *   *Correction Requests*: Record correction-request comments, status, and timestamps.
    *   *Admin Resolution*: Admin resolution of student corrections, triggering regenerated/reissued previews and student re-notification.
*   **Admin Audit Trail**: Record administrative changes and student confirmations in logs.

---

## 5. Priority 2 — AI/OCR and Accessibility Workflow
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

## 6. Priority 3 — Approval, Publication, Archive, History, and Rollback
*   **Approval Gate**: Controlled editing of approved/published database records. Changes require revalidation and, where appropriate, reapproval before republishing.
*   **Staged Publication**: Compiling eligible approved and published records into `capstones-latest.json` and uploading it to public Supabase Storage, with safe publication failure handling.
*   **Archive and Unpublish**: Mark projects as archived, removing them from the public feed compilation while preserving history in PostgreSQL.
*   **Public-Removal Verification**: Ensure public-removal verification: publishing completion, fresh-feed retrieval, cache-busting or refresh verification, confirmation that the archived item is absent from Duda listing/detail rendering, and public-removal completion timestamp/audit record.
*   **Feed History & Rollback**: Save timestamped backup copies of the feed and implement controlled, authorized rollback (checksum verification, selected snapshot restoration, post-rollback feed and Duda verification, audit attribution, failure handling). A dashboard control may be a future interface, but instant restoration must not be promised.
*   **Audit and Retry**: Audit attribution for all publication status transitions, with idempotent retry behavior.

---

## 7. Priority 4 — UAT, Performance, Staff Handover, and Success Measurement
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

## 8. Optional Enhancements
*   **Community Voting**: Embed optional student and visitor voting widgets on Duda pages (must not block the core publishing path).

---

## 9. Open Institutional Decisions
*   **Long-Term Operational Owner**: Handover target alias.
*   **Data and Public-Asset Retention**: Policy regarding how many semesters of data are kept in storage before archiving.
*   **Approved Email Delivery Arrangement**: Approved university mail server / SMTP endpoint.
*   **Approved AI/OCR Provider & Privacy Terms**: Privacy-compliant cloud extraction API and terms approval.
*   **Official Production Duda Access**: Production publishing authority and site access.
*   **Recovery and Incident-Response Owner**: Designated support contact.

---

## 10. Definition of Done
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
2.  PostgreSQL database migrations applied to `capstone-impact-staging`.
3.  Unit and integration tests pass (Vitest).
4.  Accessibility compliance testing.
5.  Administrative staff UAT and staging acceptance signed off.
6.  Rollback and recovery verification completed.
7.  Institutional ownership and handover complete.
