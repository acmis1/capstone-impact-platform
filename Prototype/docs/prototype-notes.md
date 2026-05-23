# Prototype Publishing & Schema Notes

This document provides details on the Capstone Impact Platform data schema, field lifecycle, and showcase status flows implemented in **Prototype v2**.

---

## 1. Complete Fields Schema Matrix

The Capstone database utilizes a flexible document model stored in Supabase under `projects` (primary key `id` matching the project ID). The table below outlines all fields present in Prototype v2:

| Field Name | Type | Description | Visibility / Public Feed? | Status / Validation |
| :--- | :--- | :--- | :--- | :--- |
| `id` | Integer (BigInt) | Unique stable project ID (e.g. `2026101`). | **Public** | Required. Double-safe deduplication check on import. |
| `title` | String | Title of the capstone project. | **Public** | Required. |
| `year` | String | Academic year of the project (e.g. `"2026"`). | **Public** | Required. |
| `program` | String | Academic program name. | **Public** | Required. |
| `discipline` | String | Primary discipline name. | **Public** | Required. |
| `disciplines` | Array of Strings | All related academic disciplines. | **Public** | Required. |
| `teamMembers` | Array of Strings | Names of the student authors. | **Public** | Required. |
| `groupName` | String | Assigned capstone group name. | **Public** | Required. |
| `academicSupervisor` | String | Supervisor faculty member. | **Public** | Required. |
| `industryPartner` | String | Corporate sponsor / client. | **Public** | Required. |
| `background` | String | Background problem statement. | **Public** | Required. |
| `solution` | String | Details of the solution designed by students. | **Public** | Required. |
| `poster` | String (URL) | URL path to the poster PNG/JPG file. | **Public** | Poster OR Poster PDF is required. Warning if only one exists. |
| `posterPdf` | String (URL) | URL path to the poster PDF file. | **Public** | Poster OR Poster PDF is required. Warning if only one exists. |
| `snapshots` | Array of Strings (URLs) | List of showcase gallery screenshot URLs. | **Public** | Required. |
| `accessibilityText` | String | Descriptive alternative text for screen readers. | **Public** | Optional. Triggers a warning (not error) if missing. |
| `videoUrl` | String (URL) | URL to project video (YouTube, Vimeo, etc.). | **Public** | Optional. Validated for proper URL format. |
| `demoUrl` | String (URL) | URL to interactive project demo. | **Public** | Optional. Validated for proper URL format. |
| `repositoryUrl` | String (URL) | URL to code repository (GitHub, GitLab, etc.). | **Public** | Optional. Validated for proper URL format. |
| `externalLinks` | Array of Objects | Custom external resources (contains `{ label, url }`). | **Public** | Optional. Validated for proper URL formats. |
| `layoutConfig` | Object | Staff configuration for visual rendering preset. | **Public** | Optional. Validates preset IDs and structures. |
| `importBatchId` | String | Identifier for batch intake. | **Forbidden** (Stripped) | Administrative field. Excluded in validator. |
| `sourceFolder` | String | Folder containing student package assets. | **Forbidden** (Stripped) | Administrative field. Excluded in validator. |
| `sampleImportId` | String | Package code used for tracking. | **Forbidden** (Stripped) | Administrative field. Excluded in validator. |
| `packageValidation` | Object | Import scanner results (status, errors, warnings). | **Forbidden** (Stripped) | Administrative field. Excluded in validator. |
| `status` | String | Life-cycle status of the project record. | **Forbidden** (Stripped) | Internal state machine. |
| `internalNotes` | String | Private comments for staff only. | **Forbidden** (Stripped) | Excluded. |
| `reviewNotes` | String | Review feedback shared with the student team. | **Forbidden** (Stripped) | Excluded. |
| `lastUpdated` | String (ISO Date) | Server timestamp of last edit. | **Forbidden** (Stripped) | Excluded. |
| `lastPublishedPublicHash` | String | FNV-1a fingerprint hash of the last successfully published public payload. | **Forbidden** (Stripped) | Internal state tracking. Used to detect out-of-sync edits. |
| `lastPublishedTemplateId` | String | Layout template ID in use when last published. | **Forbidden** (Stripped) | Internal state tracking. |
| `lastPublishedAt` | String (ISO Date) | Timestamp of last successful public publication. | **Forbidden** (Stripped) | Internal state tracking. |

---

## 2. Dynamic Showcase Status Flow & Two-Tier Decoupling

RMIT CMS segregates the administrative lifecycle status of a project from its live public sync state to prevent staff from assuming that CMS saves instantly propagate to Duda.

### A. CMS Lifecycle Status
1.  **Draft** / **Submitted**: Standard project creation flow.
2.  **In Review**: Compliant project folders imported through the workspace are automatically mapped to this status. They represent projects ready for staff verification.
3.  **Approved**: Set by staff once metadata and layout configurations are verified. This immediately incorporates the project into the *local preview feed* on the Admin server.
4.  **Published**: Live on the Duda public showcase. This state is reached after clicking **Publish to Duda** on the Dashboard, uploading the feed to Supabase stable storage.
5.  **Archived**: Record is preserved in Supabase for auditing but completely removed from both local and public feeds.

### B. Duda Sync Status
The sync status is dynamically computed by comparing the current public fields' fingerprint against `lastPublishedPublicHash`:
- **Synced / Up to date**: Project is published, and all public-facing CMS fields exactly match the last published snapshot.
- **Unpublished CMS changes**: Project is published, but a staff member edited public details or changed visual templates since the last publish. Duda will remain out of sync until a **Publish to Duda** action is run from the Dashboard.
- **Pending publish**: The project is approved and queued for publication on the next cloud sync.
- **Pending removal**: The project is archived but remains live on Duda until the next cloud sync.
- **Not public / Draft**: The project is draft/review and is not public.

---

## 3. Duplicate Prevention & Safety Checks (Phase 3 Folder Import)

Deduplication and project import checks are performed automatically:
-   **Stable Deterministic ID Generation**: The backend generates stable positive `BigInt` IDs by hashing the academic year and the folder slug (e.g., `2026:smart-campus-navigation` -> `202637527`). This prevents collision with sample IDs and guarantees that re-importing the same project folder will correctly update/upsert the existing CMS record.
-   **Server-Side Import Upsert**: When a project is re-imported or upserted, existing fields are preserved or updated. Handled assets (such as video files, PDF posters, and high-resolution snapshots) remain correctly attached.
-   **Excel Metadata Support (`project-details.xlsx`)**: RMIT staff do not need to write technical JSON files. Instead, the CMS primarily parses `project-details.xlsx` inside each project folder. Fallbacks to `project-details.csv` and `project.json` are fully supported for backwards compatibility and test flexibility.
-   **Demo Mode Deduplication**: For the simulated demo loading path, the CMS matches `pkg.id`, `sourceFolder`, and `sampleImportId` against existing projects to block duplicate records.
-   **Size Validation Safeguards**: The multer upload framework limits total multipart payloads to 100 MB. Import validations trigger a warning if an individual file exceeds 50 MB to prevent performance or database instability. Real 60-second H.264 video assets (e.g. 5.25 MB) and 1920x1080 high-res snapshot images are fully supported and successfully uploaded to Supabase Storage (`project-assets` bucket).

---

## 4. CMS-Controlled Layout Presets vs. Page Templates

RMIT staff configure visual presentation settings on a per-project basis through the dynamic layout options in **Section C: Public Layout & Presets** of the Admin interface.

> [!NOTE]
> **Key Conceptual Boundaries:**
> 1. **Client-Side Rendering Engine:** These layout options (`poster_showcase`, `technical_detail`, `media_rich`) are CMS-controlled visual presets rendered client-side on a single reusable Duda detail page. They are **not** native Duda page templates.
> 2. **Preset Intent:** Poster Showcase is an exhibition/poster-first page, Technical Detail is a formal report/article-first page, and Media Rich is a demo/media-first page.
> 3. **Staff Control Limits:** Administrative staff can reorder or toggle visibility for any supported content block (e.g. background, solution, snapshots, video, links) in the CMS panel.
> 4. **Developer Extensibility:** Implementing new content block types or creating completely new visual systems still requires developer extension of the `bodyend.html` rendering loop and modern CSS stylesheets.
> 5. **Duda Background Safety:** The embedded detail module is self-contained and defines its own readable light or dark backgrounds, metadata cards, and CTA styling so it remains readable on Duda's white/light page background.

---

## 5. Future Scope & Enhancements

### Future enhancement: Media Library / Asset Picker
A future version could allow staff to browse uploaded assets, preview images/videos/PDFs, select existing media, replace files, and manage asset reuse. This is not part of the current MVP because it requires permissions, search, thumbnails, and asset governance.
