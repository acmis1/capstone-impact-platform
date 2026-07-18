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
*   **Admin Authentication Schemas**: PostgreSQL schemas and role models exist in Supabase migrations, but active Route validation, Next.js middleware hooks, and live staging session checks are not operationally activated.

---

## 3. Priority 0 — Admin Identity and Environment Activation
*   **Staging Activation**: Activate the Admin/CMS against the separate `capstone-impact-staging` environment (never use the Prototype recovery Supabase project).
*   **Identity Provisioning**: Seed authorized admin email accounts and roles (no public self-registration).
*   **Role-Based Route Locking**: Verify Next.js routes and backend APIs reject requests if session token is absent or lacks administrative credentials.
*   **Security Check**: Confirm RLS policies are enabled on all PostgreSQL tables and secrets are excluded from repository code.

---

## 4. Priority 1 — Submission, Cross-Check, Preview, and Student Confirmation
*   **Folder Ingestion**: Bulk folder uploads reading project structure and asset packages.
*   **Excel Cross-Check**: Build the administrative parser matching column headers in `project-details.xlsx` against database fields.
*   **Student Preview Link**: Generate token-based, private, secure preview URLs for student groups.
*   **Email Notification**: Send automated preview emails containing preview links to student group contact addresses.
*   **Reminder Scheduling**: Schedule automated email reminders to groups if confirmation is pending.
*   **Student Response Handling**:
    *   *Student Confirmation*: Roster a positive confirmation sign-off in the database.
    *   *Correction Requests*: Roster student comments flagging typos or incorrect assets.
*   **Admin Audit Trail**: Record administrative changes and student confirmations in logs.

---

## 5. Priority 2 — AI/OCR and Accessibility Workflow
*   **OCR Poster-Text Extraction**: Extract text from poster PDF files to pre-fill metadata fields.
*   **Full-Text Accessibility Alternatives**: Generate complete reviewed text descriptions for images and posters.
*   **Title and Formatting Consistency**: Highlight mismatches between the spreadsheet metadata title and poster title.
*   **Image/Text Consistency Assistance**: Flag mismatched media files or missing elements.
*   **Duplicate Detection**: Check project IDs and directories to block duplicate imports.
*   **Deterministic Fallback**: Ensure the system remains fully functional via manual entry if OCR/AI endpoints fail.
*   **Privacy & Cost Controls**: Limit OCR/AI token counts and process files locally where possible.
*   **Mandatory Human Review**: Prevent any OCR/AI output from auto-approving or auto-publishing without staff review.

---

## 6. Priority 3 — Approval, Publication, Archive, History, and Rollback
*   **Approval Gate**: Locking approved database records from accidental administrative modification.
*   **Staged Publication**: Compiling the approved projects into `capstones-latest.json` and uploading it to public Supabase Storage.
*   **Archive and Unpublish**: Mark projects as archived, removing them from the public feed compilation while preserving history in PostgreSQL.
*   **Public-Removal Verification**: Ensure the public feed updates immediately and Duda no longer displays archived items.
*   **Feed History & Rollback**: Save timestamped backup copies of the feed and implement a dashboard button to restore any historical feed instantly.

---

## 7. Priority 4 — UAT, Performance, Staff Handover, and Success Measurement
*   **Accessibility Compliance Check**: Perform accessibility keyboard and screen-reader tests on Duda and Admin UI.
*   **Performance & Scaling Verification**: Load-test database queries and file storage bandwidth under a target of at least **100 projects per year**.
*   **Non-technical Staff UAT**: Conduct usability testing with school administrative staff.
*   **Documentation & Training**: Deliver a complete administrator user guide.
*   **Institutional Handover**: Execute the transfer of repository admin rights, Supabase database, and Render hosting control to school-controlled accounts.
*   **Success Measurement**: Verify that the publishing workflow demonstrates at least a **50% time or manpower reduction** compared to manual Duda page creation.

---

## 8. Optional Enhancements
*   **Community Voting**: Embed optional student and visitor voting widgets on Duda pages (must not block the core publishing path).

---

## 9. Open Institutional Decisions
*   **Long-Term System Owner**: Handover target alias.
*   **Data Retention Policy**: Duration of public asset retention.
*   **SMTP Services**: Approved university mail server endpoint.
*   **Approved AI/OCR Endpoint**: Privacy-compliant cloud extraction API.

---

## 10. Definition of Done
A backlog item is defined as done when:
1.  Code is written in Next.js/TypeScript and fully typed.
2.  SQL migrations are applied to `capstone-impact-staging`.
3.  Unit tests pass (Vitest).
4.  Documentation is updated.
5.  Verified in a running staging environment.
