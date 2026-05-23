# Folder-Based Project Package Import Workflow

This document defines the project package import workflow for the CMS.

## Primary Workflow: Folder Upload
The primary, stakeholder-friendly workflow is browser-based folder upload:
- **Single Project Folder Import**: Staff selects one project folder containing a single project's assets and `project.json` (one project folder = one project).
- **Batch Folder Import**: Staff selects one parent folder containing multiple project folders (one parent folder = batch folder import).
- **Frontend Behavior**: The frontend uses folder selection (browser directory upload) and sends the files' relative paths to the backend through a file manifest.
- **Backend Endpoint**: The backend endpoint is `POST /api/import-folder`.

Staff should not be forced to manually create or manage ZIP files for importing. ZIP parsing is not the primary workflow.

## Fallback / Future ZIP Package Option
- ZIP upload is an optional/future fallback only.
- Do not describe ZIP as the main demo or import path. It is reserved solely for cases where folder selection is unsupported or where a pre-existing archive must be processed directly.

## Meeting-Driven Rationale

Stakeholder and advisor direction from the 21 May meeting changes the import model from a simulated batch demo to a real folder-based package workflow:

- One folder represents one project.
- One parent folder containing multiple project folders represents a batch folder import.
- Staff must be able to upload one project folder or many project folders without manually creating ZIP files.
- Every project folder must follow a standard structure so the CMS can scan it consistently.
- The CMS should validate file names, required metadata, required files, file types, missing files, and incorrect content before staff review.
- Valid projects should map into CMS records for review, not directly to the public site.
- Projects with issues should show validation errors or warnings that staff can act on.
- Staff should preview, approve, and publish later through the existing workflow.
- Importing must not publish to Duda. Duda remains the public-facing layer and should only update through the existing approved publish path.

## Existing Code Findings Relevant to Import

- `package.json` uses Express, Vite, React, Supabase, CORS, dotenv, and now needs `multer` for multipart folder upload handling. ZIP parsing is not required for the primary workflow.
- `server.js` exposes JSON CRUD routes for projects and a separate `POST /api/publish-cloud-feed` route. Current `POST /api/projects` and `PUT /api/projects/:id` call `generatePublicFeed()` after saving, so import should not use those routes if import must not update the public feed file.
- `utils/projectStore.js` stores project records in the Supabase `projects` table as `{ id, data, updated_at }`. Import needs lower-level upsert logic that does not regenerate or publish feeds.
- `utils/supabasePublisher.js` is focused on publishing `capstones-latest.json` to the feed storage bucket. It should not be used by the import endpoint.
- `src/App.jsx` currently includes a simulated demo batch flow using `SIMULATED_PACKAGES`, `validateProjectPackage`, `handleLoadPackages`, and `handleMapValidProjects`. That flow maps valid/warning sample data through `POST /api/projects`.
- Current UI navigation has an `Import Projects` view. A later phase should rename and reshape this into a real package upload workflow.
- Existing docs already establish the two-tier model: CMS lifecycle status is separate from Duda/public sync state. Imported records should start as `in_review`.

## Primary Single-Project Folder Structure

Single project import starts from one selected folder. The folder contains `project.json` directly:

```text
solar-power-optimizer/
├── project.json
├── poster.pdf
├── poster.png
├── accessibility.txt
└── snapshots/
    └── snapshot-01.jpg
```

Rules:

- The selected folder name is the source folder and preferred slug.
- Single mode accepts either a selected folder containing `project.json` directly or a selected parent folder with one child project folder containing `project.json`.
- Multiple child project folders in single mode should be rejected.

## Primary Batch Parent Folder Structure

Batch folder import starts from one selected parent folder. Each immediate child folder is one project package:

```text
capstone-import-batch-2026/
├── solar-power-optimizer/
│   ├── project.json
│   ├── poster.pdf
│   ├── poster.png
│   ├── accessibility.txt
│   ├── snapshots/
│   │   ├── snapshot-01.jpg
│   │   └── snapshot-02.jpg
│   └── media/
│       └── demo-video.mp4
└── smart-food-traceability/
    ├── project.json
    ├── poster.pdf
    ├── poster.jpg
    ├── accessibility.txt
    └── snapshots/
        ├── snapshot-01.jpg
        └── snapshot-02.jpg
```

Rules:

- Each immediate child folder under the selected parent is scanned as one project.
- A broken project folder should not block scanning other folders.
- The result should report each folder independently as `valid`, `warning`, or `error`.

## Fallback ZIP Package Option

ZIP upload remains a fallback/future option. If implemented later, the same folder rules apply after extraction:

- A single-project ZIP contains one project folder.
- A batch ZIP contains one parent folder with multiple project folders, or multiple project folders at the archive root.
- ZIP extraction must use the same unsafe path rejection and system-file ignore rules as folder upload.

## `project.json` Schema

Required fields:

```json
{
  "title": "Solar Power Optimizer",
  "summary": "Short public summary.",
  "background": "Problem context.",
  "solution": "Project solution.",
  "program": "Bachelor of Software Engineering",
  "discipline": "Software Engineering",
  "industry": "Energy",
  "year": "2026",
  "supervisor": "Dr Example Supervisor",
  "groupName": "Solar Optimizer Team",
  "students": ["Student One", "Student Two"],
  "templateId": "poster_showcase",
  "featuredMedia": "poster"
}
```

Optional fields:

```json
{
  "industryPartner": "Example Partner",
  "externalLinks": [
    { "label": "Project Site", "url": "https://example.com" }
  ],
  "demoUrl": "https://example.com/demo",
  "repositoryUrl": "https://github.com/example/project",
  "videoUrl": "https://www.youtube.com/watch?v=example"
}
```

Schema rules:

- Required string fields must be present and non-empty after trimming.
- `year` may be a number or string, but should be stored as a string in CMS data for consistency with current records.
- `students` must be a non-empty array of strings.
- `externalLinks`, when present, must be an array of `{ label, url }` objects.
- `templateId` should match a supported CMS layout preset. Unknown values should warn and fall back to `poster_showcase`.
- `featuredMedia` should match a supported featured media option. Unknown values should warn and fall back to `poster`.

## Required Files

Blocking required files:

- `project.json`
- Poster image: `poster.png`, `poster.jpg`, `poster.jpeg`, or `poster.webp`
- `poster.pdf`

Warning-level expected files:

- `accessibility.txt`
- `snapshots/` folder

## Optional Files

Optional media files:

- `media/demo-video.mp4`
- `media/audio.mp3`
- `media/model.glb`
- `media/model.gltf`

Optional project metadata fields may also provide external media or project links, including `videoUrl`, `demoUrl`, `repositoryUrl`, and `externalLinks`.

## Supported Media Types

Supported import asset types:

| Category | Supported types |
| :--- | :--- |
| Poster image | `.png`, `.jpg`, `.jpeg`, `.webp` |
| Poster document | `.pdf` |
| Accessibility text | `.txt` |
| Snapshots | `.png`, `.jpg`, `.jpeg`, `.webp` |
| Video | `.mp4` |
| Audio | `.mp3` |
| 3D model | `.glb`, `.gltf` |

Unsupported optional media should not block the import by default, but should appear as warnings.

## Validation Rules

Blocking errors:

- Missing `project.json`
- Invalid JSON in `project.json`
- Missing `title`
- Missing `summary`
- Missing `program`
- Missing `discipline`
- Missing `year`
- Missing poster image
- Missing `poster.pdf`

Warnings:

- Missing `accessibility.txt`
- Missing `snapshots/` folder
- Missing `supervisor`
- Unsupported optional media type
- Unknown `templateId` fallback
- Oversized files if a size limit is defined

Additional required safety checks:

- Ignore system files such as `__MACOSX`, `.DS_Store`, and `thumbs.db`.
- Reject path traversal entries such as `../`, absolute paths, and drive-letter paths.
- Normalize path separators before scanning folder structure.
- Enforce one poster image winner if multiple poster images are present, and warn about extras.
- Validate URL fields when optional links are provided.
- Keep validation results attached to each project record for later staff review.

## Supabase Storage Path Strategy

Expected bucket environment variable:

```text
SUPABASE_ASSET_BUCKET=project-assets
```

Expected object paths:

```text
imports/{batchId}/{projectSlug}/poster.pdf
imports/{batchId}/{projectSlug}/poster.{ext}
imports/{batchId}/{projectSlug}/accessibility.txt
imports/{batchId}/{projectSlug}/snapshots/{filename}
imports/{batchId}/{projectSlug}/media/{filename}
```

Storage rules:

- `batchId` should be generated per upload request.
- `projectSlug` should come from the project folder name after URL-safe normalization.
- Preserve snapshot and media filenames after validating they are safe relative filenames.
- Storage upload should be separate from public feed publishing. Uploading import assets must not call `/api/publish-cloud-feed`.
- Asset URLs mapped into CMS records should point to the uploaded storage objects, but imported records remain internal until later approval/publish steps.

## Backend Endpoint

Primary folder import endpoint:

```text
POST /api/import-folder
```

Request:

- `Content-Type: multipart/form-data`
- `files`: multiple uploaded files
- `mode=single` or `mode=batch`
- `manifest`: JSON mapping uploaded files to browser relative paths
- Existing admin auth header should apply, matching current protected routes.

Manifest format:

```json
{
  "files": [
    {
      "uploadName": "project.json",
      "relativePath": "capstone-import-batch-2026/solar-power-optimizer/project.json"
    }
  ]
}
```

Dependency:

- `multer` for multipart upload handling

ZIP fallback dependency, only if implemented later:

- `adm-zip` or equivalent ZIP parser

Response shape:

```json
{
  "batchId": "import-2026-05-21-001",
  "mode": "batch",
  "importedCount": 2,
  "warningCount": 1,
  "errorCount": 0,
  "projects": [
    {
      "id": 202684321,
      "folder": "solar-power-optimizer",
      "title": "Solar Power Optimizer",
      "status": "valid",
      "imported": true,
      "errors": [],
      "warnings": [],
      "assets": {
        "poster": true,
        "posterPdf": true,
        "snapshots": 1,
        "video": true,
        "audio": false,
        "model3d": false
      }
    }
  ]
}
```

Implementation note:

- Do not route this through `POST /api/projects` unless that route is changed or bypassed so import does not regenerate `public/capstones-latest.json`.
- Do not call `publishToCloud`, `getPublishedFeedStatus`, `/api/publish-cloud-feed`, or any Duda publishing workflow from import.

## Imported Project Record Mapping

Imported records should be compatible with current CMS fields:

| CMS field | Import source |
| :--- | :--- |
| `id` | Deterministic numeric ID from year plus slug/hash strategy |
| `title` | `project.json.title` |
| `summary` | `project.json.summary` |
| `background` | `project.json.background` |
| `solution` | `project.json.solution` |
| `year` | `String(project.json.year)` |
| `program` | `project.json.program` |
| `discipline` | `project.json.discipline` |
| `industry` | `project.json.industry` |
| `supervisor` | `project.json.supervisor` |
| `industryPartner` | `project.json.industryPartner` or empty string |
| `groupName` | `project.json.groupName` |
| `students` | `project.json.students` |
| `poster` | Storage URL for `poster.{ext}` |
| `posterPdf` | Storage URL for `poster.pdf` |
| `snapshots` | Storage URLs for supported files in `snapshots/` |
| `videoUrl` | `project.json.videoUrl` or storage URL for `media/demo-video.mp4` |
| `accessibilityText` | Contents of `accessibility.txt`, or empty string |
| `externalLinks` | `project.json.externalLinks` or empty array |
| `layoutConfig.templateId` | `project.json.templateId` or fallback |
| `layoutConfig.featuredMedia` | `project.json.featuredMedia` or fallback |
| `layoutConfig.sectionOrder` | Default current order: `["background", "solution", "snapshots", "video", "links"]` |
| `layoutConfig.hiddenSections` | Empty array by default |
| `status` | Always `in_review` |
| `importBatchId` | Generated upload batch ID |
| `sourceFolder` | Selected project folder name |
| `packageValidation` | Full validation result object |
| `validationFlags` | Compact status flags for UI filtering |

Compatibility note:

- Current app code often uses `teamMembers` and `academicSupervisor`, while this import schema names `students` and `supervisor`. The implementation phase should either map both pairs or standardize form handling so imported records render correctly in the current edit and preview screens.
- Imported records are not live immediately.
- Duda sync fields such as `lastPublishedPublicHash`, `lastPublishedTemplateId`, `lastPublishedAt`, and Duda/public feed markers should be empty or absent for imported records.
- Duda/public feed must not update during import.

## Duplicate ID Strategy

The current Supabase table uses bigint IDs. Use deterministic numeric IDs so re-importing the same project can update the same CMS record.

Recommended strategy:

1. Normalize `projectSlug` from the source folder name.
2. Combine year and slug into a stable seed string, for example `2026:solar-power-optimizer`.
3. Hash the seed into a positive numeric value that fits the bigint column.
4. Prefix or bound the generated number by year where practical, while reserving current demo IDs.
5. Never use sample IDs `2026101` through `2026105`.
6. Check existing CMS records before insert.
7. If the ID already exists, update/upsert the existing CMS record rather than creating a duplicate.
8. Avoid collisions with existing seed/demo IDs. If a hash collision is detected against a different source folder/title, add deterministic collision resolution such as a numeric suffix in the hash seed.

## Single Import UI Flow

Later Project Repository change:

- Add `+ Import project folders`.
- Open an import modal or panel.
- Offer `Single Project Folder`.
- Staff selects or drops one project folder.
- Frontend sends `multipart/form-data` with files and an explicit relative-path manifest.
- UI posts to `POST /api/import-folder` with `mode=single`.
- UI shows validation status, detected assets, errors, warnings, and imported ID.
- If import succeeds with `valid` or `warning`, staff can choose `Edit & Review`.
- The project remains `in_review` until staff explicitly changes lifecycle state later.

## Batch Folder Import UI Flow

Later Project Import page change:

- Main CTA: `Select batch folder` (which triggers browser folder picker).
- Sample mode becomes secondary only and is renamed `Load Demo Example`.
- Frontend sends every file under the selected parent folder with a relative-path manifest.
- UI posts to `POST /api/import-folder` with `mode=batch`.
- Each top-level project folder appears as a result row.
- Error folders remain visible but are not imported as valid CMS records unless the backend intentionally records rejected attempts separately.

Result table columns:

- Project folder
- Detected title
- Validation status: `valid`, `warning`, or `error`
- Errors
- Warnings
- Detected assets
- Imported ID
- Action: `Edit & Review`

## Out-of-Scope / Future Items

Out of scope for Phase 1:

- UI implementation of folder upload controls
- Duda publishing
- Public feed updates
- ZIP parsing
- OCR or AI extraction from poster files
- Spreadsheet reconciliation
- Student submission portal
- Student preview/approval emails
- Production authentication or role-based access control

Future work:

- Add UI upload flows for single and batch packages.
- Add ZIP fallback import if stakeholders need archive uploads.
- Add automated tests for validation rules and ID generation.
- Implemented file size limits: Multer multipart upload limit is set to a demo-safe 100 MB total payload (maximum upload), with individual file validation warnings flagged for files exceeding 50 MB. This comfortably supports 60-second compressed H.264 MP4 videos (typically 5-15 MB) while preventing server/database instability.

## Final Demo Import Verification (Phase 3)

For the final stakeholder and advisor demonstration, a fresh external demo import batch folder has been created and E2E browser verified to prove the system can handle different project templates and richer media:

### 1. External Demo Batch Path
`d:\IT RMIT\Capstone\capstone-import-batch-demo-final`

### 2. Imported Projects & Rich Media Specifications
1. **smart-campus-navigation** (Valid, In Review)
   - **Title**: Smart Campus Navigation Assistant
   - **ID**: `202637527` (Deterministic ID based on year + slug, distinct from previous smoke-test records)
   - **Layout Preset Template**: `media_rich`
   - **Featured Media**: `video` Hero Element
   - **Video Asset**: A real 60-second H.264 MP4 video (`media/demo-video.mp4`) with a file size of 5.25 MB (demo-safe placeholder).
   - **High-Resolution Snapshots**: Two 1920x1080 JPEG images (`snapshots/snapshot-01.jpg` and `snapshot-02.jpg` from Picsum seeds).
   - **Poster Image & PDF**: 1920x1080 poster PNG and standard PDF document included.
   - **Accessibility Text**: Valid `accessibility.txt` included.
2. **robotics-safety-monitor** (Warning-level, In Review)
   - **Title**: Robotics Safety Monitoring System
   - **ID**: `202620724`
   - **Layout Preset Template**: `technical_detail`
   - **Featured Media**: `poster` Hero Element
   - **High-Resolution Snapshot**: One 1920x1080 JPEG snapshot image.
   - **Poster Image & PDF**: 1920x1080 poster JPG and standard PDF document included.
   - **Accessibility Text**: Omitted intentionally to trigger a warning condition.

### 3. E2E Import Results
- **Batch Folder Import UI**: Scanned the parent directory and successfully imported 2 records (`importedCount = 2`, `valid = 1`, `warning = 1`, `error = 0`). The valid record (`smart-campus-navigation`) detects and attaches the MP4 video, whereas the warning-level project (`robotics-safety-monitor`) flags a missing accessibility text warning but imports successfully.
- **Repeatable Single Folder Import UI**: Scanned the `smart-campus-navigation` folder directly. It safely performs an update (upsert) on ID `202637527`, showing that duplicate folder importing is blocked, and the video asset remains correctly attached.
- **Data & Feed Safety**: Public feed files (`public/capstones-latest.json` and `data/db.json`) remain completely clean and unmodified. The import workflow populates internal draft review records in the CMS database without publishing to Duda or triggering feed regeneration.

