# `project-details.xlsx` Workbook Contract and Parsing Specification

This document defines the current provisional technical contract and deterministic normalization rules for the staff-facing `project-details.xlsx` workbook parsed by `apps/admin-cms`.

> [!NOTE]
> **Provisional Contract Notice**: This contract represents the technical parser foundation. Column definitions, aliases, defaults, and mappings are deliberately centralized in [`projectDetailsWorkbookContract.ts`](../apps/admin-cms/src/import/projectDetailsWorkbookContract.ts) so they can be adjusted safely after stakeholder consultation without rewriting the parser architecture. Stakeholder-dependent rules must not be treated as permanently authoritative.

---

## 1. Scope & Core Principles

- **Single Project Cardinality**: Each `project-details.xlsx` workbook represents **exactly one** project.
- **Pure Server-Side Parsing**: The parser (`parseProjectDetailsWorkbook`) is a pure, buffer-based function with zero database, storage, network, email, or browser side effects.
- **Non-Publishing**: Parsing or importing a workbook creates zero public feed entries and does not trigger publication to Duda, persistence, storage uploads, or public feed updates.
- **Developer Fallback Preserved**: `project.json` remains fully supported as a developer and testing fallback format.

---

## 2. Worksheet Selection

- **Preferred Worksheet Name**: `Project details` (matching is whitespace-trimmed and case-insensitive).
- **Fallback Behavior**:
  - If `Project details` is missing, the parser processes the first non-empty worksheet and issues a `WORKBOOK_UNEXPECTED_SHEET_NAME` warning.
  - If additional non-empty worksheets exist, they are ignored for project metadata and trigger a `WORKBOOK_EXTRA_SHEET` warning.
  - Rows from multiple worksheets are never combined.

---

## 3. Row Cardinality

- **Header Row**: The first non-empty row in the selected worksheet is treated as the header row.
- **Project Data Row**: The second non-empty row is treated as the single project data row.
- **Blank Rows**: Empty rows preceding the header row, between the header and project row, or following the project row are safely ignored.
- **Cardinality Errors**:
  - A workbook with no project data row fails with `WORKBOOK_MISSING_PROJECT_ROW`.
  - A workbook with more than one project data row fails with `WORKBOOK_MULTIPLE_PROJECT_ROWS`.

---

## 4. Column Definitions & Header Matching

Header matching is case-insensitive, order-independent, trims surrounding whitespace, and collapses repeated whitespace.

### Staff-Facing Columns & Internal Mappings

| Staff Column Name | Internal Field | Required Status | Accepted Aliases |
| :--- | :--- | :--- | :--- |
| `Project title` | `title` | **Required** | `project title`, `title` |
| `Short public summary` | `summary` | **Required** | `short public summary`, `summary` |
| `Project background` | `background` | Optional | `project background`, `background` |
| `Solution / impact` | `solution` | Optional | `solution / impact`, `solution`, `impact`, `solution/impact` |
| `Team members` | `teamMembers` | **Required** | `team members`, `teammembers`, `participants` |
| `Group name` | `groupName` | **Required** | `group name`, `groupname` |
| `Participant contact email` | `participantContactEmail` | Optional | `participant contact email`, `participantcontactemail`, `group contact email`, `groupcontactemail`, `participant email`, `group email`, `contact email` |
| `Academic supervisor` | `academicSupervisor` | Optional | `academic supervisor`, `academicsupervisor`, `supervisor` |
| `Industry partner` | `industryPartner` | Optional | `industry partner`, `industrypartner` |
| `Industry sector` | `industry` | Optional | `industry sector`, `industrysector`, `industry` |
| `Study program` | `program`, `studyProgram` | **Required** | `study program`, `studyprogram`, `program` |
| `Primary discipline` | `discipline` | **Required** | `primary discipline`, `primarydiscipline`, `discipline` |
| `Project year` | `year` | **Required** | `project year`, `projectyear`, `year` |
| `Showcase layout` | `templateId` | Optional | `showcase layout`, `showcaselayout`, `templateid`, `template id` |
| `Main media to feature` | `layoutConfig.featuredMedia` | Optional | `main media to feature`, `mainmediatofeature`, `featuredmedia`, `featured media` |
| `Poster full text` | `posterText` | **Required** | `poster full text`, `poster text`, `postertext`, `posterfulltext` |
| `Accessibility text` | `accessibilityText` | **Required** | `accessibility text`, `accessibilitytext` |
| `Snapshot image alt text` | `snapshotAltText` | Conditional — required when the package contains `snapshot-1.png` | `snapshot image alt text`, `snapshot alt text`, `snapshot accessibility text`, `snapshotimagealttext`, `snapshotalttext` |

### Participant Contact Email

`Participant contact email` is the authoritative destination for participant preview correspondence.
It is a **project/group communication contact**, not an individual participant account, and staff may
leave it blank — an ordinary participant preview never requires one.

- Stored normalized: surrounding whitespace trimmed and the whole address lowercased.
- Blank or absent leaves the project with no authoritative contact. Generate + Send then fails closed
  with `PARTICIPANT_EMAIL_MISSING` and creates no preview.
- Present but not a single valid address is a blocking `WORKBOOK_INVALID_PARTICIPANT_CONTACT_EMAIL`
  error. The raw cell value is never echoed into the issue message.
- The browser never supplies or overrides this address at send time; the server resolves it from
  persisted project data at execution time.

### Accessible Poster Content

`Poster full text` and `Accessibility text` are both **required**, because a published project page
must carry a full text version of its image content plus a text alternative for the poster image.

- `Poster full text` (`posterText`) is the searchable/selectable full textual version of the
  meaningful content on the poster. Multiline content is preserved exactly; only outer whitespace is
  trimmed.
- `Accessibility text` (`accessibilityText`) is a concise descriptive text alternative for the poster
  image. It describes what the poster shows and is deliberately **not** required to match
  `posterText`.
- A missing column, a blank value after trim, or a formula cell with no usable cached result is a
  blocking `error` for either field, following the same policy as every other required field.
- Each value is bounded by a transport/storage safety ceiling — 20,000 characters for `posterText`
  and 2,000 for `accessibilityText` — enforced as `WORKBOOK_VALUE_TOO_LONG`. These are size limits,
  **not** content-quality rules.
- Nothing judges whether the prose is complete, accurate, or well written. There is no word count,
  no keyword check, no comparison against the title, and no OCR or AI. Both values are authored by
  staff or supplied in the workbook.
- A legacy `project.json` package may still be staged without either value, but it cannot be
  submitted for review, approved, or published until staff supply both through the Project Metadata
  editor in the Admin/CMS.

### Snapshot Image Alt Text

`Snapshot image alt text` (`snapshotAltText`) is the text alternative describing the meaningful
content of the package's snapshot image. It is **conditionally required**: the snapshot image itself
stays optional, but a package that includes one must describe it.

- **Package contains `snapshot-1.png`** — the value must be present and non-blank. An absent column,
  a blank value after trim, or a formula cell with no usable cached result each block the import.
- **Package contains no `snapshot-1.png`** — the column and value may be absent. Nobody is asked to
  describe an image that is not there, and the existing "snapshot recommended" warning is unchanged.
- The value is bounded at 2,000 characters and enforced as `WORKBOOK_VALUE_TOO_LONG`. An oversized
  value is rejected outright and is **never** silently truncated.
- Because the workbook parser cannot see which files a package contains, it enforces only what it
  can evaluate alone (readable cell, bounded length). The conditional presence rule is applied at
  the package-aware boundary, which reports `METADATA_MISSING_SNAPSHOT_ALT_TEXT` or
  `METADATA_SNAPSHOT_ALT_TEXT_TOO_LONG`.
- This value is per media asset, not per project, and is stored on `media_assets.alt_text_public`.
  The poster image keeps `accessibilityText` as its text alternative; it is never duplicated here.
- **Nothing derives this value** from the filename, the project title, the poster accessibility
  text, OCR, or AI. A filename is file information, not a text alternative.
- A legacy `project.json` package may supply `snapshotAltText`, and an oversized value there is
  rejected. A legacy package with a snapshot and no alt text may still be staged into private draft
  media, but it cannot be submitted for review, approved, given a participant preview, or published
  until staff supply the text in the project media section of the Admin/CMS.
- Only the single current snapshot image (`snapshot-1.png`) is supported. Arbitrary multi-image
  galleries and gallery ordering are **not** implemented.

### Public ID Separation

The `project-details.xlsx` workbook intentionally **does not** contain a public ID column. `publicId` depends on package/folder context (e.g. source folder name) and is supplied by the ingestion layer adapter (`buildImportPackageManifestFromWorkbook`).

### Unknown & Duplicate Columns

- **Unknown Columns**: Unknown non-empty headers do not block parsing. They trigger a `WORKBOOK_UNKNOWN_COLUMN` warning containing location metadata.
- **Duplicate Columns**: If two columns map to the same internal field (e.g. both `Project title` and `title`), parsing fails with a `WORKBOOK_DUPLICATE_COLUMN` error.

---

## 5. Value Normalization & Safe Messaging Rules

### Safe Issue Message Rule
Parser issue messages (`message`) must **never** echo participant names, project titles, summaries, or raw workbook cell contents, nor expose raw dependency stack traces or internal XML/ZIP details. Structural field, column, and row context is communicated strictly through typed metadata properties (`fieldName`, `columnName`, `rowNumber`).

### General Text & Formulas
- Text cells are trimmed. Empty or whitespace-only cells are normalized to `""`.
- Objects are never formatted as `"[object Object]"`.
- Excel formulas are evaluated using the cached primitive result. If a required cell contains a formula without a usable cached result, parsing fails with `WORKBOOK_UNUSABLE_FORMULA` (and does **not** generate a duplicate `WORKBOOK_MISSING_REQUIRED_VALUE` error).

### Project Year (`year`)
- Accepts 4-digit integers or numeric strings in the range `1900` through `2100` (e.g., `2026` or `"2026"`).
- Normalized to a 4-digit string (`"2026"`).
- Rejects decimal numbers, Date objects, non-numeric strings, and out-of-range years with `WORKBOOK_INVALID_YEAR`.

### Team Members (`teamMembers`)
- Accepts participant names separated by newlines (`\n`, `\r\n`), semicolons (`;`), or commas (`,`).
- Names are trimmed, empty entries removed, and original order preserved.
- Must contain at least one valid name.
- Duplicate names (case-insensitive) preserve the first occurrence and emit a generic `WORKBOOK_DUPLICATE_TEAM_MEMBER` warning (`"A duplicate team member entry was removed."`).

### Showcase Layout (`templateId`)
Friendly values are normalized via a shared helper that trims whitespace, converts to lowercase, converts hyphens/underscores to spaces, and collapses repeated whitespace:
- `Poster showcase`, `Poster-first showcase`, `Poster`, `poster_showcase`, `POSTER   SHOWCASE` → `poster_showcase`
- `Technical report`, `Report-first layout`, `Technical detail`, `technical_detail` → `technical_detail`
- `Media-rich showcase`, `Media rich`, `Video and gallery showcase`, `media_rich` → `media_rich`

Unrecognized non-empty values emit a generic `WORKBOOK_UNKNOWN_LAYOUT` warning and fall back to `poster_showcase`. Absent values default to `poster_showcase` without warning.

### Main Media to Feature (`featuredMedia`)
Friendly values are normalized via the shared helper:
- `Auto`, `auto` → `auto`
- `Poster`, `poster` → `poster`
- `Gallery`, `Snapshots`, `snapshots` → `snapshots`
- `Video`, `video` → `video`

Unrecognized non-empty values emit a generic `WORKBOOK_UNKNOWN_FEATURED_MEDIA` warning and fall back to `poster`. Absent values default to `poster` without warning.

---

## 6. Stakeholder Taxonomies Status

- `program` and `discipline` are currently required fields by the provisional workbook contract.
- `industry`, `academicSupervisor`, and `industryPartner` are optional fields.
- All five fields remain unrestricted free-text strings.
- No stakeholder taxonomy or enum list is enforced yet.

---

## 7. Error & Warning Issue Codes

| Issue Code | Severity | Description |
| :--- | :--- | :--- |
| `WORKBOOK_MALFORMED` | `error` | The uploaded file could not be read as a valid .xlsx workbook. |
| `WORKBOOK_NO_DATA` | `error` | Workbook contains no readable worksheets or rows. |
| `WORKBOOK_MISSING_PROJECT_ROW` | `error` | Header row found, but no project data row exists. |
| `WORKBOOK_MULTIPLE_PROJECT_ROWS` | `error` | More than one project data row exists in the worksheet. |
| `WORKBOOK_MISSING_REQUIRED_COLUMN` | `error` | A required column is absent from the header row. |
| `WORKBOOK_DUPLICATE_COLUMN` | `error` | Multiple header columns map to the same internal field. |
| `WORKBOOK_MISSING_REQUIRED_VALUE` | `error` | A required cell value is empty or missing. |
| `WORKBOOK_INVALID_YEAR` | `error` | Project year is not a valid 4-digit year between 1900 and 2100. |
| `WORKBOOK_UNUSABLE_FORMULA` | `error` | Formula cell in a required field has no usable cached result. |
| `WORKBOOK_INVALID_PARTICIPANT_CONTACT_EMAIL` | `error` | Participant contact email is present but is not a valid single email address. |
| `WORKBOOK_VALUE_TOO_LONG` | `error` | An accessible-content value exceeds its bounded technical ceiling. |
| `WORKBOOK_UNEXPECTED_SHEET_NAME` | `warning` | Preferred sheet `Project details` was absent; processed fallback sheet. |
| `WORKBOOK_EXTRA_SHEET` | `warning` | Additional non-empty worksheet detected and ignored. |
| `WORKBOOK_UNKNOWN_COLUMN` | `warning` | Non-empty header column not recognized in canonical/alias dictionary. |
| `WORKBOOK_DUPLICATE_TEAM_MEMBER` | `warning` | Duplicate participant name detected and omitted. |
| `WORKBOOK_UNKNOWN_LAYOUT` | `warning` | Unknown layout value defaulted to `poster_showcase`. |
| `WORKBOOK_UNKNOWN_FEATURED_MEDIA` | `warning` | Unknown featured media option defaulted to `poster`. |

---

## 10. Admin Excel Reference Dataset Reconciliation

Distinct from `project-details.xlsx` (which is submitted inside each project folder representing package metadata), staff may optionally supply a separate **Admin Reference Dataset** `.xlsx` workbook during browser import.

- **Purpose**: Cross-checks submitted project packages against official administrative records (e.g. School master roster).
- **Inspection**: Endpoint `POST /api/imports/admin-reference/inspect` inspects sheets, row counts, and headers safely without returning or persisting raw cell data.
- **Mapping-Driven**: Mappings are user-configured (1–3 composite match key fields, 1–20 comparison fields) and validated server-side (`validateAdminReferenceMapping`).
- **Rules-First Matching**: Reconciles normalized package values against reference rows. Packages with field mismatches, missing reference rows, or ambiguous/duplicate matches are marked `invalid` and blocked from staging.
- **TOCTOU & Staging Replay**: The reference workbook SHA-256 fingerprint and canonicalized mapping are bound into the preview fingerprint (`previewFingerprint`) and commitment intent (`adminReference`). Staging re-verifies the uploaded reference workbook and mapping, re-running reconciliation server-side before persisting metadata.
