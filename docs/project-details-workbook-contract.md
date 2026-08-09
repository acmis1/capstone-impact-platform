# `project-details.xlsx` Workbook Contract and Parsing Specification

This document defines the authoritative technical contract and deterministic normalization rules for the staff-facing `project-details.xlsx` workbook parsed by `apps/admin-cms`.

---

## 1. Scope & Core Principles

- **Single Project Cardinality**: Each `project-details.xlsx` workbook represents **exactly one** project.
- **Pure Server-Side Parsing**: The parser (`parseProjectDetailsWorkbook`) is a pure, buffer-based function with zero database, storage, network, or browser side effects.
- **Non-Publishing**: Parsing or importing a workbook creates zero public feed entries and does not trigger publication to Duda or public storage.
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

Header matching is case-insensitive, order-independent, trims surrounding whitespace, and normalizes repeated internal spaces.

### Staff-Facing Columns & Internal Mappings

| Staff Column Name | Internal Field | Required Status | Accepted Aliases |
| :--- | :--- | :--- | :--- |
| `Project title` | `title` | **Required** | `project title`, `title` |
| `Short public summary` | `summary` | **Required** | `short public summary`, `summary` |
| `Project background` | `background` | Optional | `project background`, `background` |
| `Solution / impact` | `solution` | Optional | `solution / impact`, `solution`, `impact`, `solution/impact` |
| `Team members` | `teamMembers` | **Required** | `team members`, `teammembers`, `participants` |
| `Group name` | `groupName` | **Required** | `group name`, `groupname` |
| `Academic supervisor` | `academicSupervisor` | Optional | `academic supervisor`, `academicsupervisor`, `supervisor` |
| `Industry partner` | `industryPartner` | Optional | `industry partner`, `industrypartner` |
| `Industry sector` | `industry` | Optional | `industry sector`, `industrysector`, `industry` |
| `Study program` | `program`, `studyProgram` | **Required** | `study program`, `studyprogram`, `program` |
| `Primary discipline` | `discipline` | **Required** | `primary discipline`, `primarydiscipline`, `discipline` |
| `Project year` | `year` | **Required** | `project year`, `projectyear`, `year` |
| `Showcase layout` | `layoutConfig.templateId` | Optional | `showcase layout`, `showcaselayout`, `templateid`, `template id` |
| `Main media to feature` | `layoutConfig.featuredMedia` | Optional | `main media to feature`, `mainmediatofeature`, `featuredmedia`, `featured media` |
| `Accessibility text` | `accessibilityText` | Optional | `accessibility text`, `accessibilitytext` |

### Public ID Separation

The `project-details.xlsx` workbook intentionally **does not** contain a public ID column. `publicId` depends on package/folder context (e.g. source folder name) and is supplied by the ingestion layer adapter (`buildImportPackageManifestFromWorkbook`).

### Unknown & Duplicate Columns

- **Unknown Columns**: Unknown non-empty headers do not block parsing. They trigger a `WORKBOOK_UNKNOWN_COLUMN` warning containing the column name.
- **Duplicate Columns**: If two columns map to the same internal field (e.g. both `Project title` and `title`), parsing fails with a `WORKBOOK_DUPLICATE_COLUMN` error.

---

## 5. Value Normalization Rules

### General Text & Formulas
- Text cells are trimmed. Empty or whitespace-only strings are normalized to `""`.
- Objects are never formatted as `"[object Object]"`.
- Excel formulas are evaluated using the cached primitive result. If a required cell contains a formula without a usable cached result, parsing fails with `WORKBOOK_UNUSABLE_FORMULA`.

### Project Year (`year`)
- Accepts 4-digit integers or numeric strings in the range `1900` through `2100` (e.g., `2026` or `"2026"`).
- Normalized to a 4-digit string (`"2026"`).
- Rejects decimal numbers, Date objects, non-numeric strings, and out-of-range years with `WORKBOOK_INVALID_YEAR`.

### Team Members (`teamMembers`)
- Accepts participant names separated by newlines (`\n`, `\r\n`), semicolons (`;`), or commas (`,`).
- Names are trimmed, empty entries removed, and original order preserved.
- Must contain at least one valid name.
- Duplicate names (case-insensitive) preserve the first occurrence and emit a `WORKBOOK_DUPLICATE_TEAM_MEMBER` warning.

### Showcase Layout (`templateId`)
Friendly values are normalized as follows:
- `Poster showcase`, `Poster-first showcase`, `Poster`, `poster_showcase` → `poster_showcase`
- `Technical report`, `Report-first layout`, `Technical detail`, `technical_detail` → `technical_detail`
- `Media-rich showcase`, `Media rich`, `Video and gallery showcase`, `media_rich` → `media_rich`

Unrecognized non-empty values emit a `WORKBOOK_UNKNOWN_LAYOUT` warning and fall back to `poster_showcase`. Absent values default to `poster_showcase` without warning.

### Main Media to Feature (`featuredMedia`)
Friendly values are normalized as follows:
- `Auto`, `auto` → `auto`
- `Poster`, `poster` → `poster`
- `Gallery`, `Snapshots`, `snapshots` → `snapshots`
- `Video`, `video` → `video`

Unrecognized non-empty values emit a `WORKBOOK_UNKNOWN_FEATURED_MEDIA` warning and fall back to `poster`. Absent values default to `poster` without warning.

---

## 6. Stakeholder Taxonomies Status

Categorical fields (`industry`, `program`, `discipline`, `academicSupervisor`, `industryPartner`) are validated for required presence but remain **unrestricted free-text strings**. No hard-coded taxonomies are enforced until formal stakeholder confirmation.

---

## 7. Error & Warning Issue Codes

| Issue Code | Severity | Description |
| :--- | :--- | :--- |
| `WORKBOOK_MALFORMED` | `error` | Buffer could not be parsed as a valid XLSX workbook. |
| `WORKBOOK_NO_DATA` | `error` | Workbook contains no readable worksheets or rows. |
| `WORKBOOK_MISSING_PROJECT_ROW` | `error` | Header row found, but no project data row exists. |
| `WORKBOOK_MULTIPLE_PROJECT_ROWS` | `error` | More than one project data row exists in the worksheet. |
| `WORKBOOK_MISSING_REQUIRED_COLUMN` | `error` | A required column is absent from the header row. |
| `WORKBOOK_DUPLICATE_COLUMN` | `error` | Multiple header columns map to the same internal field. |
| `WORKBOOK_MISSING_REQUIRED_VALUE` | `error` | A required cell value is empty or missing. |
| `WORKBOOK_INVALID_YEAR` | `error` | Project year is not a valid 4-digit year between 1900 and 2100. |
| `WORKBOOK_UNUSABLE_FORMULA` | `error` | Formula cell in a required field has no usable cached result. |
| `WORKBOOK_UNEXPECTED_SHEET_NAME` | `warning` | Preferred sheet `Project details` was absent; processed fallback sheet. |
| `WORKBOOK_EXTRA_SHEET` | `warning` | Additional non-empty worksheet detected and ignored. |
| `WORKBOOK_UNKNOWN_COLUMN` | `warning` | Non-empty header column not recognized in canonical/alias dictionary. |
| `WORKBOOK_DUPLICATE_TEAM_MEMBER` | `warning` | Duplicate participant name detected and omitted. |
| `WORKBOOK_UNKNOWN_LAYOUT` | `warning` | Unknown layout value defaulted to `poster_showcase`. |
| `WORKBOOK_UNKNOWN_FEATURED_MEDIA` | `warning` | Unknown featured media option defaulted to `poster`. |
