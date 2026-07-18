# Demo Readiness — Capstone Impact Platform Prototype

> **Last updated:** 2026-05-17
>
> This document is the single reference for stakeholder demonstrations of the Capstone Impact Platform prototype.

---

## 1. Deployed URLs

| Component | URL |
| :--- | :--- |
| **Render Admin/CMS** | `https://capstone-impact-platform.onrender.com` |
| **Supabase Stable Feed** | `https://<GENERATED_PROJECT_REFERENCE>.supabase.co/storage/v1/object/public/feeds/capstones-latest.json` |
| **Duda Public Listing** | `[insert Duda listing URL]` |
| **Duda Project Detail** | `[insert Duda detail URL]` (path: `/project-detail?id=…`) |
| **GitHub Repository** | `https://github.com/acmis1/capstone-impact-platform` |

> [!IMPORTANT]
> The staging access key is shared separately with authorised stakeholders. It is **never** committed to the repository.

---

## 2. Stakeholder Demo Script

Use the following step-by-step script during live demonstrations.

### Setup
1. Open the **Render Admin/CMS** URL in a browser.
2. Enter the **staging access key** in the sidebar field.
3. **Note on Persistence**: Even on the Render Free Tier, project records are now persisted in the **Supabase Database**. No manual restore steps are needed after a server restart.

### Dashboard & Publishing Workflow
3. Observe the **Dashboard** — it shows the project summary and publishing controls.
4. Click **"Projects"** in the sidebar to open the Project Repository.

### Editing & Importing
5. Select a project and click **Edit & Review** to show the editor.
6. Demonstrate adding or editing a project record.
7. Point out the **source files/media fields**:
    - Main poster image source
    - Downloadable poster PDF source
    - Project snapshots / gallery sources
   - `posterText` field (long-form poster text)
8. **Explain**: AI/OCR-assisted text extraction is conceptual in this prototype — the `posterText` field is manually entered or imported.

### Simulated Demo Batch Workflow (New in v2)
9. Click **"Import Projects"** in the sidebar.
10. Scroll to the bottom and click **"Load Demo Example"** to simulate scanning 5 incoming student submissions:
    - Point out that 3 packages are identified as **Valid** (all required fields present, layout preset selected, valid URLs).
    - Point out 1 package flagged as **Warning** (missing accessibility text warning, and contains unsupported file types in package assets: `.exe` and `.zip` which are flagged).
    - Point out 1 package marked as **Error** (missing both poster image and poster PDF, has invalid video/GitHub URLs, and selects an invalid layout preset).
11. Observe the clean visual representation of the scans. Point out how warnings and errors are formatted to help administrative staff pinpoint package issues.
12. Explain **Deduplication Safeguards**: The simulated loading prevents duplicate imports by checking `id`, `sourceFolder`, and `sampleImportId` against existing projects.
13. Click **"Map Valid Projects to CMS"**. Confirm that the 4 valid or warning-only projects are mapped to Supabase database with status **In Review** and stable integer IDs, while the error-ridden package is safely blocked.

### Real Folder Import & Rich Media Handling (Phase 3 Final Demo)
14. Navigate to **"Projects"** and click **"+ Import project folders"** to open the **Project Import Workspace**.
15. Point out the **"Download Excel template"** button in the header. Explain that RMIT administrative staff can download a pre-formatted Excel template (`project-details.xlsx`) with friendly column names such as **Project title**, **Showcase layout**, and **Main media to feature**.
16. Select the **"Batch Folder"** option.
17. Select the fresh external demo batch folder containing our new Excel worksheets:
    `d:\IT RMIT\Capstone\capstone-import-batch-demo-final`
18. Click **"Scan & Import Batch"** and point out the real import process:
    - The scanner reads **`project-details.xlsx`** inside each project folder, falling back to `project-details.csv` or `project.json` if missing.
    - **smart-campus-navigation**: Successfully imported (`IMPORTED`) with stable ID `202637527`. It includes a real **60-second H.264 video** (5.25 MB, demo-safe placeholder) at `media/demo-video.mp4`, two high-resolution 1920x1080 snapshots, poster image, and PDF document.
    - **robotics-safety-monitor**: Successfully imported with warnings (`IMPORTED WITH WARNINGS`) with stable ID `202620724`. It intentionally omits `accessibility.txt` to trigger a warning, contains one high-resolution 1920x1080 snapshot, and poster image/PDF.
19. In the results table, click **"Edit & Review"** for *Smart Campus Navigation Assistant*:
    - Observe the status is set to **In Review** and Duda Sync is **Not public / Draft**.
    - Verify that the poster image, poster PDF link, and high-resolution snapshots load perfectly.
    - Confirm the video URL exists in the CMS record and is available in the Media Rich layout preview.
20. Now click **"+ Import project folders"** again, select **"Single Project Folder"** option, and select `d:\IT RMIT\Capstone\capstone-import-batch-demo-final\smart-campus-navigation`.
21. Click **"Scan & Import Project"** to demonstrate **repeatability and upserts**. Verify that it safely updates the existing record (`202637527`) instead of duplicating, and the video asset remains correctly attached.

### CMS Layout Panel & Presentation Editing (New in v2)
21. Navigate back to **"Projects"** and select one of the imported records (e.g. *Smart Campus Navigation Assistant*).
22. Click **Edit & Review** and scroll to **Section C: Public Layout & Presets**.
23. Demonstrate changing the **Layout Preset Template** (e.g. from `poster_showcase` to `media_rich` or `technical_detail`).
24. Demonstrate modifying the **Featured Media Element** (e.g. choosing `snapshots` or `video` as hero).
25. Show how content blocks can be vertically reordered (clicking ▲ Up / ▼ Down) or toggled on/off (Show checkbox).
26. Highlight the warning disclaimer: *This configures the showcase dynamic rendering layout and does not create native Duda pages.*
27. Demonstrate adding custom links in the **External Links** field using the `Label | URL` format.
28. Save the changes, set the project to **Approved**, and sync it to the showcase feed.

### Approval & Publishing
29. Set the project status to **Approved** and click **Save & Update Record**. (This automatically regenerates the local preview feed).
30. Return to the **Dashboard** — observe that the public record counts update.
31. Click **"Publish to Duda"** — confirm the feed is uploaded to Supabase and the project status transitions to **Published**.

### Verification — Feed & Duda
32. Open the **Supabase Stable Feed URL** in a new tab — show the JSON contains the approved project.
33. Open the **Duda Public Listing URL** — refresh the page and show the project card appears.
34. Click the project card to navigate to the **Detail Page** and confirm all fields render.

### Archive / Removal Flow
35. Return to the Admin/CMS and open the published project.
36. Click **"Archive / remove from showcase"**. Explain that this archives the CMS record and marks it for removal from the public showcase, but does not delete the record or publish immediately.
37. Return to the Dashboard and click **"Publish to Duda"** again only when stakeholders intentionally want the public showcase updated.
38. Refresh the **Supabase feed** — the archived project should no longer appear.
39. Refresh the **Duda listing** — the archived project card should be gone.

---

## 3. What This Prototype Proves

- ✅ Admin/CMS can manage capstone project records end-to-end.
- ✅ **Cloud Persistence**: Records survive server restarts and redeploys without local disk storage.
- ✅ Non-technical staff do not need to edit JSON, GitHub, or Duda code manually.
- ✅ A stable public feed URL (`capstones-latest.json`) remains unchanged — consumers always fetch the same endpoint.
- ✅ The Duda public layer updates dynamically from approved public data.
- ✅ Poster images, poster PDF links, and snapshot galleries are supported in the data model and rendered on Duda.
- ✅ Archive/removal workflow prevents removed projects from appearing on the live site after republishing.
- ✅ **Batch Folder Import & Pre-validation**: Dynamic scanning, reporting, and blocking of invalid packages, and mapping compliant ones with stable IDs in a safe, draft-like `in_review` state.
- ✅ **Robust Deduplication**: Prevention of duplicate imports using `id`, `sourceFolder`, and `sampleImportId` checks.
- ✅ **Staff Layout Control**: CMS-controlled visual presets inside one reusable Duda detail page: Poster Showcase is exhibition/poster-first, Technical Detail is formal report/article-first, and Media Rich is demo/media-first. Staff can reorder/hide supported blocks, but these are not native Duda page templates.
- ✅ **Self-Contained Detail Module**: The embedded project detail renderer defines its own readable backgrounds, cards, metadata, and CTA colors so it remains usable on Duda's white/light page background.
- ✅ **Enhanced Media Fields**: Responsive rendering of code repositories, interactive demos, embedded videos, accessibility screen reader text, and custom link lists.
- ✅ **Real Folder Import & Rich Media Handling**: Live frontend folder selection and relative-path manifest import E2E flow. Proven to handle high-resolution poster images/snapshots and a real 60-second H.264 video file (`media/demo-video.mp4`) safely uploaded to Supabase Storage and stored in CMS draft review records.
- ✅ **Repeatable Folder Import (Upsert)**: Proven that re-scanning/re-importing the same project folder updates the existing record cleanly while keeping the rich video/media assets correctly mapped without duplicating.

- âœ… **Staff-Friendly Excel Metadata**: The downloaded `project-details.xlsx` template uses human-readable headers and maps friendly layout/media choices into internal CMS values automatically.
- âœ… **CMS-Only Review Controls**: Imported review records can be safely deleted before publication, selected records can be bulk-approved, and public records can be archived without publishing to Duda immediately.

---

## 4. What It Does Not Prove Yet

These features are **out of scope** for the prototype and are planned for production:

- ❌ Real OCR/AI extraction from poster files.
- ❌ Real student submission form (intake from students).
- ❌ Real preview email sent to student groups.
- ❌ Real student confirmation link.
- ❌ Production authentication and role management (RMIT SSO, RBAC).
- ❌ Production media upload automation (direct resumable client-to-cloud storage upload). Simple multipart uploads are used for prototype demo safety with a 100 MB limit.
- ❌ Real ZIP file upload, extraction, and validation.
- ❌ Dynamic generation of brand-new native Duda pages or native Duda layout templates.
- ❌ Production spreadsheet governance such as locked template cells, staff permissions, and automated cross-checking against official school datasets.

| Limitation | Detail |
| :--- | :--- |
| **Render Free spin-down** | The free-tier service spins down after inactivity. The first request after idle may take 30–60 seconds. |
| **Shared access key** | The staging access key is a single shared secret — it is not a production auth system. |
| **Production requirements** | Production should use proper authentication (RMIT SSO) and managed file upload storage. |

---

## 5. Two-Tier Status Model (New in v2.1)

To prevent confusion between administrative actions inside the CMS workspace and live public showcase updates, Prototype v2.1 introduces a **two-tier status architecture**:

1. **CMS Lifecycle Status** (Internal administrative gates):
   - `Draft` / `Submitted` / `In Review` / `Changes Requested` / `Preview Sent` / `Student Confirmed` / `Approved` / `Published` / `Archived`
2. **Duda Sync / Showcase Status** (Shows whether changes are live publicly):
   - **Synced / Up to date**: Project is live on Duda and matches the current CMS record.
   - **Unpublished CMS changes**: Project is live on Duda, but staff have made saves in the CMS (e.g. edited text or changed layout templates) that are not yet visible to the public.
   - **Pending publish**: Project is marked Approved by staff but not yet distributed to Duda.
   - **Pending removal**: Project is archived in the CMS but still live on Duda until next Publish to Duda is triggered.
   - **Not public / Draft**: Project is draft/review and is not live.

This prevents staff from assuming that clicking "Save CMS Changes" instantly updates the live Duda site. Live updates only occur when clicking **Publish to Duda** from the dashboard.

---

## 6. Final Validation Checklist

Run through this checklist before any stakeholder demo.

| # | Check | Pass? |
| :--- | :--- | :---: |
| 1 | Render app loads (Dashboard visible) | ☐ |
| 2 | `/api/projects` returns JSON project array from database | ☐ |
| 3 | `/capstones-latest.json` returns the public feed | ☐ |
| 4 | Local preview feed updates automatically after save | ☐ |
| 5 | "Publish to Duda" completes without error | ☐ |
| 6 | Supabase feed URL returns updated JSON | ☐ |
| 7 | Duda listing page shows approved projects | ☐ |
| 8 | Archive → Publish removes project from Duda | ☐ |
| 9 | No secrets committed (`.env` is in `.gitignore`) | ☐ |

---

## 7. Related Documentation

- [Deployment & Staging Guide](./deployment-staging.md)
- [Duda Integration Plan](./duda-integration-plan.md)
- [Prototype Publishing Notes](./prototype-notes.md)
