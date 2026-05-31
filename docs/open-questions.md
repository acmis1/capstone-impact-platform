# Open Questions

This document outlines key open questions that must be resolved during the initial weeks of the Part 2 phase (July 2026). These questions are grouped by functional domain and require input from stakeholders, coordinators, academic advisors, or developers.

---

## 1. Stakeholder Workflow
*   **Roles & Permissions**: Who are the primary administrators using the Admin/CMS? Do they require distinct roles (e.g., academic coordinator, admin assistant, student reviewer), or is a single admin role sufficient?
*   **Notification Frequency**: How often should students receive "Changes Requested" notifications? Should notifications be real-time or aggregated into daily digests?
*   **Workflow Bottlenecks**: In the current design, the administrator must manually click "Send Preview Link." Can this state transition automatically when a project passes validation, or must a human remain in the loop?

---

## 2. Academic Advisor Expectations
*   **Assessment Alignment**: Does the showcase publishing process intersect with Capstone grading or submission deadlines? Is there a requirement to export submission metadata for assessment records?
*   **Evidence Collection**: Do advisors require an immutable snapshot of submissions at the moment of deadline, independent of the edits made during the showcase review?

---

## 3. Duda Public Layer
*   **SEO Optimization**: Since the listing and details are rendered client-side via JavaScript, search engines may experience indexing latency. Is SEO a critical metric, or is showcase visibility restricted to direct URL traffic?
*   **Domain Mapping**: What is the final public URL for the showcase? Will it reside on an RMIT subdomain (e.g., `showcase.rmit.edu.au`) or remain a standard Duda domain?
*   **Script Failbacks**: How should Duda handle cases where the public feed is temporarily unreachable or empty? Should it display a standardized maintenance message or fall back to static historical data?
*   **Safety Lock Policy**: How will we ensure that no Duda-facing changes are made during the break, preserving the current Duda prototype evidence for reconfirmation in July?

---

## 4. XLSX Template
*   **Template Ownership**: Who is responsible for maintaining the `project-details.xlsx` master template? If fields change in future semesters, how will the system adapt?
*   **Localization/Formatting**: Are team members' names parsed exactly as text, or do they need to match RMIT student directories?
*   **Strict vs. Relaxed Constraints**: What happens if a student deletes or renames a non-critical sheet/column in the template? Should the parser fail completely, or attempt a soft recovery?

---

## 5. Media Policy and Public/Private Asset Separation
*   **Asset File Formats**: What are the strict limitations on snapshot and poster formats? Are modern formats like WebP or SVG permitted, or must we restrict uploads to PNG, JPG, and PDF?
*   **File Size Caps**: The current prototype enforces a basic size limit. What are the maximum file size policies for public hosting (especially for high-res poster PDFs)?
*   **Image Optimization**: Should the Admin/CMS automatically compress or resize student-uploaded snapshots to optimize listing page load speed?

---

## 6. Approval Rules
*   **Signature Requirements**: Is a single coordinator's approval sufficient to publish a project, or is a multi-signature approval flow required for sensitive projects?
*   **Re-approval Logic**: If an already published project is edited (e.g., to fix a spelling error in a name), does it automatically revert to a "Draft" status requiring re-approval, or does it stay live during edits?

---

## 7. Archive/Unpublish/Delete Rules
*   **Retention Period**: How long should archived projects remain in the Supabase database? Is there a legal requirement to retain student submission metadata for multiple years?
*   **Physical Deletion**: Under what specific scenarios should a physical hard-delete of files from Supabase Storage be executed (e.g., copyright violation, explicit student retraction request)?
*   **Archive Visibility**: Should archived projects be accessible via deep links, or completely scrubbed from all public API paths?

---

## 8. Student Preview/Confirmation
*   **Authentication**: How will students access their preview link securely without requiring an RMIT portal login? Will token-based signed URLs (e.g., valid for 7 days) be sufficient?
*   **Rejection Feedbacks**: If a student rejects a preview, what structured feedback can they submit to the admin?

---

## 9. OCR/AI Restrictions
*   **Data Residency**: Are we permitted to use external commercial APIs (like OpenAI or Claude) to parse poster text, or must all data processing occur within RMIT local servers/private cloud environments to satisfy privacy policies?
*   **Reliability SLA**: If the AI extraction engine fails or is slow, how does that affect the overall import speed? 

---

## 10. Free-Tier Deployment
*   **Hosting Boundaries**: For the free-tier hosting option to be verified later, how will we mitigate the "cold start" delay (which can take 50+ seconds for inactive instances)?
*   **Database Limits**: Supabase free tiers have exact limits on database size (e.g., 500MB). With multiple semesters uploading high-res PDFs and images, how many semesters can be hosted before reaching this limit, and what is the mitigation strategy?

---

## 11. Handover and Maintenance
*   **Long-Term Owner**: Once the RuntimeError team graduates, who inside the RMIT IT/academic department will own and maintain the Admin/CMS codebase?
*   **Security Updates**: How will security patches, Node dependency upgrades, and Supabase security keys be managed post-handover?

---

## 12. Database Schema & Public Feed Contracts
*   **PostgreSQL Relational Mapping**: Does the academic team approve shifting the unstructured `data` JSONB column model into structured relational tables (separating `MediaAsset`, `ValidationFlag`, and `ApprovalRecord` entities) during Part 2?
*   **Student Preview Confirmation Status**: Should `StudentConfirmation` sign-offs be formalized in the SQL schema for Part 2, or kept as a conceptual student-review workflow to be verified in a future sprint?
*   **JSON Public Feed Fields**: Are the 19 fields defined in the public feed contract fully comprehensive for the showcase layer, or are there additional student metadata fields required in July?
*   **CDN Feed Caching**: Will the JSON feed and public assets be served directly from public Supabase Storage buckets, or is the feed fronted by a CDN to handle dynamic bandwidth spikes during high-volume showcase events?

---

> [!TIP]
> **Consolidated Meeting Agenda**
> All these open questions, along with the proposed Part 2 architecture and decision matrix, have been compiled into a concise, meeting-ready pack: [july-confirmation-pack.md](file:///d:/IT%20RMIT/Capstone/docs/july-confirmation-pack.md). Use the confirmation pack to guide the alignment session with stakeholders and advisors.
