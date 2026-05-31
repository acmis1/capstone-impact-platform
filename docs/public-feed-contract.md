# Public Feed Contract: Stable Showcase JSON

This document defines the strict, approved-only data contract consumed by the Duda Showcase Layer. The Admin/CMS compiler must enforce this contract when publishing updates.

> [!WARNING]
> **Planning Draft Only**
> This contract is a planning draft designed for architectural discussion. It is *not* a finalized API specification and must remain flexible until the formal confirmation session in July 2026. Do not implement final validation locks based on this draft during the break.

---

## 1. Purpose and Stable Feed Principle
*   **Showcase Layer Decoupling**: To bypass Duda's database and account constraints, Duda operates strictly as a public presentation shell. It does *not* host native dynamic data collections.
*   **Stable Feed URL**: Duda pulls all project grids and detail pages from a single, stable public JSON feed URL (e.g. hosted on a secure, public Supabase Storage bucket or static file path).
*   **Zero-Maintenance Design**: The Duda site template never requires manual editing when new projects are published. All listing updates, search filters, year categories, and detail routes are parsed dynamically at runtime from this single feed file.

---

## 2. Feed Compilation Rules
*   **Approved Records Only**: Only records with `status = 'approved'` or `status = 'published'` are selected for the public feed compilation.
*   **Internal Sanitization (Zero Leakage)**: The compiler must strictly strip all administrative data, private notes, and validation logs to protect student privacy and internal workflows.
*   **No Schema Breaks**: Changes to internal database models must never break the 19 fields expected by the Duda dynamic script (`bodyend.html`).

---

## 3. Allowed Fields vs. Forbidden Fields

The compiler must enforce this field segregation during every feed compilation:

### A. Allowed Public Fields (The 19-Field Contract)
The compiled public JSON feed must contain an array of objects matching these exact fields:

1.  `id`: `integer` (Unique deterministic project ID, e.g. `202610234`)
2.  `title`: `string` (Sanitized project title)
3.  `summary`: `string` (Short description for showcase cards)
4.  `background`: `string` (Detailed problem context)
5.  `solution`: `string` (Detailed project solution)
6.  `year`: `string` (Academic year, e.g. `"2026"`)
7.  `program`: `string` (Academic study program, e.g. `"Information Technology"`)
8.  `discipline`: `string` (Primary technical discipline, e.g. `"Software Engineering"`)
9.  `groupName`: `string` (Student team name, e.g. `"RuntimeError"`)
10. `teamMembers`: `array of strings` (Roster of student names)
11. `academicSupervisor`: `string` (Supervisor name)
12. `industryPartner`: `string` (Company name, if any)
13. `poster`: `string` (URL to the public poster image preview)
14. `posterPdf`: `string` (URL to the public full poster PDF document)
15. `snapshots`: `array of strings` (List of public snapshot image URLs)
16. `videoUrl`: `string` (YouTube/Vimeo or public demo video URL)
17. `demoUrl`: `string` (URL to a running prototype, if any)
18. `repositoryUrl`: `string` (Link to git code repository, if any)
19. `layoutConfig`: `object` (Visual rendering instructions)
    *   `templateId`: `string` (`poster_showcase`, `technical_detail`, or `media_rich`)
    *   `featuredMedia`: `string` (`poster`, `snapshots`, or `video`)
    *   `sectionOrder`: `array of strings` (DOM ordering parameter)

### B. Forbidden Internal Fields
If any of these fields are detected in the compiled public feed output, the compilation must fail immediately:
*   `status` (CMS workflow state)
*   `internalNotes` / `internal_staff_notes`
*   `reviewNotes` / `private_review_comments`
*   `missingItems`
*   `validationFlags` / `validationErrors` / `validationWarnings`
*   `adminId` / `admin_id` (identity of the staff reviewer)
*   `importBatchId` / `import_batch_id`
*   `sourceFolder`
*   `pendingRemovalFromPublic`
*   `publicRemovalCompletedAt`
*   `archivedAt` / `archiveReason`
*   Raw administrative file paths (e.g. `imports/...`)

---

## 4. Example Public JSON Feed

```json
[
  {
    "id": 202610052,
    "title": "Smart Campus Navigation Assistant",
    "summary": "An interactive WebGL navigation assistant for RMIT campus visitors.",
    "background": "The RMIT campus can be highly complex for new students and external visitors to navigate efficiently, leading to missed appointments and confusion.",
    "solution": "The team developed a mobile-friendly 3D campus navigation application utilizing local static models and dynamic route planning.",
    "year": "2026",
    "program": "Bachelor of Software Engineering",
    "discipline": "Software Engineering",
    "groupName": "RuntimeError",
    "teamMembers": [
      "Cao Tran Gia An",
      "Duong Hai Nam"
    ],
    "academicSupervisor": "Dr. Nguyen Van A",
    "industryPartner": "RMIT Property Services",
    "poster": "https://xyz.supabase.co/storage/v1/object/public/assets/2026/smart-campus/poster.jpg",
    "posterPdf": "https://xyz.supabase.co/storage/v1/object/public/assets/2026/smart-campus/poster.pdf",
    "snapshots": [
      "https://xyz.supabase.co/storage/v1/object/public/assets/2026/smart-campus/snapshot1.jpg",
      "https://xyz.supabase.co/storage/v1/object/public/assets/2026/smart-campus/snapshot2.jpg"
    ],
    "videoUrl": "https://www.youtube.com/watch?v=example",
    "demoUrl": "https://smart-campus-demo.example.com",
    "repositoryUrl": "https://github.com/acmis1/smart-campus",
    "layoutConfig": {
      "templateId": "media_rich",
      "featuredMedia": "video",
      "sectionOrder": ["video", "solution", "background", "snapshots", "links"]
    }
  }
]
```

---

## 5. Feed Validation Rules
To guarantee stability, the Admin/CMS publishing loop must run the compiled payload against these validation rules before writing to the public storage location:
1.  **JSON Structural Integrity**: Ensure the output is a valid JSON array of objects.
2.  **No Empty Arrays**: The feed must contain at least 1 approved record.
3.  **Strict 19-Field Compliance**: Every object must strictly conform to the 19 public-facing fields. Extra fields are rejected.
4.  **Type Safety Verification**:
    *   Verify that `id` is a valid integer.
    *   Verify that `snapshots` and `teamMembers` are arrays of strings.
    *   Verify that `layoutConfig` contains strings for `templateId` and `featuredMedia`.
5.  **Allowed Visual Layouts**: Enforce that `templateId` strictly matches one of the three verified layout presets: `poster_showcase`, `technical_detail`, or `media_rich`.

---

## 6. Public Asset URL Rules
*   **HTTPS Only**: All media URLs (`poster`, `posterPdf`, `snapshots`) must use secure `https://` schemas. Unsecure HTTP links are rejected to satisfy browser sandbox rules.
*   **Approved Public Asset URLs**: All uploaded files are strictly hosted in secure cloud locations, made available through approved public asset URLs. The system must verify that these URLs are reachable.
*   **Permanent Feed Paths**: The compilation writes to the exact same file path (e.g. `capstones-latest.json`) to prevent breaking Duda connection references.

---

## 7. Versioning & Rollback Strategy
*   **Snapshot Compilations**: The Admin/CMS should save every successful compiled public JSON feed with a timestamped file name (e.g. `capstones-backup-20260601.json`) in a private history bucket.
*   **One-Click Rollback**: If a published feed contains a critical error, administrators can select a previous backup snapshot and overwrite the active `capstones-latest.json` instantly through the dashboard.
*   **Cache Invalidation**: Implement immediate cache busting query parameters (e.g., adding `?v=timestamp` at fetch time) inside Duda's body-end script to ensure client browsers render feed overrides instantly.

---

## 8. Open Questions for July Confirmation
*   *Static Hosting vs. CDN*: Will the public feed JSON and assets be served directly from Supabase public buckets or mirrored behind a CDN to handle high-traffic showcase events?
*   *Duda Cache Policy*: How often does Duda check for updates? Should Duda client requests pull the feed on every page view, or cache it in session storage to reduce database reads?
*   *Language Localization*: Is there a future requirement to translate the feed or host separate regional showcase listings?
