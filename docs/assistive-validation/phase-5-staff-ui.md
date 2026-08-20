# PP1 Phase 5: Staff Assistive Checks UI

## 1. Overview & Purpose

Phase 5 of the PP1 AI/OCR assistive validation subsystem introduces the production-quality staff editorial interface. Situated within the **Review and edit** workspace of the project detail page, the interface enables editorial staff to execute on-demand checks, monitor asynchronous progress, inspect evidence excerpts and title candidates, copy evidence, apply candidate titles to client draft forms, and record reviewer dispositions.

### Non-Authoritative Invariant
Assistive validation is strictly **advisory** and **non-blocking**:
- Assistive findings **never** directly mutate project status, workflow gates, publication readiness, or database records.
- "Apply to draft" populates the in-browser `ProjectMetadataEditor` form draft and marks the form dirty; persistence occurs only when staff explicitly clicks **Save metadata**, invoking the authoritative `saveProjectMetadataAction` audit pipeline.
- Assistive status labels never use misleading marketing terminology (e.g. "AI approved", "validation passed", "blocking").

---

## 2. Canonical Migration 0032

To provide bounded, read-only inspection of active/terminal runs, current job lifecycle status, and findings, Migration 0032 is introduced. Migrations 1–31 remain byte-for-byte unmodified against `origin/main`.

- **Canonical Migration Filename**: `20260821090000_assistive_validation_staff_inspection.sql`
- **SHA-256 Digest**: `d0d3afc0f1b732220e4693fef92986c8346f5f0c6eff517630a883bcab0124d8`

```sql
-- Migration 0032: bounded read-only inspection for staff assistive validation review.
CREATE OR REPLACE FUNCTION public.get_project_assistive_validation_inspection(
  p_project_id uuid,
  p_pipeline_version text,
  p_run_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
...
```

### Security & Isolation Invariants
1. **Service-Role Execution Only**: `REVOKE ALL` from `PUBLIC, anon, authenticated, service_role`; `GRANT EXECUTE` strictly to `service_role`.
2. **Deny-All Table Protection**: Direct table access remains denied on `assistive_validation_runs`, `assistive_validation_jobs`, and `assistive_validation_findings`.
3. **Fail-Closed Project Association**: If `p_run_id` is supplied but belongs to a different project, the function returns `NOT_FOUND`.
4. **No Secret Leakage**: Claim tokens, worker IDs, lease timestamps, private bucket names, and storage paths are completely omitted from return payloads.
5. **No Dynamic SQL & No Mutations**: The inspection function performs zero database writes and uses zero dynamic SQL formatting.

---

## 3. Information Architecture & Placement

The assistive checks UI resides inside the **Review and edit** (`#review-and-edit`) macro section on the project detail page, preserving the standard four macro group layout:

```
Review and edit (#review-and-edit)
├── Workflow status (#workflow-status) [Emphasis Tone]
├── Assistive checks (#assistive-checks) [Surface Card Tone]
└── Project information (#project-information) [Metadata Editor]
```

This positions document evidence directly between the high-level workflow stage decision and the editable metadata fields.

---

## 4. Server Actions & Authority Model

All interactions route through typed Next.js Server Actions with strict server-derived authority:

| Server Action | Permission Required | Description |
| :--- | :--- | :--- |
| `runAssistiveChecksAction(publicId)` | `projects.read` | Authenticates staff via `requireAdmin()`, resolves project ID, enqueues Phase 4 asynchronous job. |
| `cancelAssistiveChecksAction(publicId, runId)` | `projects.read` | Verifies run belongs to project, requests job cancellation in Postgres queue. |
| `recordAssistiveDispositionAction(publicId, runId, findingId, disposition)` | `projects.review` | Verifies reviewer role, ensures finding belongs to project run, records `REVIEWED` or `IGNORED` disposition. |
| `getAssistiveInspectionAction(publicId, runId?)` | `projects.read` | Fetches bounded inspection run, job status, findings, and computes stale state. |

### Role Permissions Matrix
- **Admin**: View findings, run checks, cancel checks, record dispositions (`projects.review`), apply candidate titles to draft (`projects.edit`).
- **Reviewer**: View findings, run checks, cancel checks, record dispositions (`projects.review`); cannot apply titles or edit metadata.
- **Editor**: View findings, run checks, cancel checks, apply candidate titles to draft (`projects.edit`); cannot record reviewer dispositions.

---

## 5. UI Features & Operational Workflows

### A. Asynchronous Polling Lifecycle
- While a check job is active (`QUEUED`, `EXTRACTING`, `CHECKING`, `RUNNING`), the client component polls `getAssistiveInspectionAction` every 2.5 seconds.
- Polling is lightweight: the server queries Postgres job state without re-downloading or re-hashing poster files.
- When the job reaches a terminal state (`COMPLETED`, `PARTIAL`, `FAILED`, `CANCELLED`, `SUPERSEDED`), polling immediately halts.

### B. Stale-Run & Unverifiable Detection
- When a terminal run is loaded, the server compares the run's `inputHash` against the current project title and poster SHA-256 (`loadAssistiveInput`).
- **`CURRENT`**: Title and poster match the snapshot evaluated during the run.
- **`STALE`**: Metadata or poster media changed after the run completed. A warning banner informs staff that results may be outdated, and "Apply to draft" is disabled until re-run.
- **`UNVERIFIABLE`**: Poster media cannot be loaded or validated.

### C. Graceful Partial / Degraded Mode
- When OCR extraction is unavailable (`ocrProvider: 'NONE'`), born-digital PDF text is still extracted and analyzed.
- The run completes with status `PARTIAL`.
- The UI displays an informational notice explaining that born-digital text was verified while scanned raster graphics were skipped, avoiding false "validation failed" alarms.

### D. Evidence Presentation & Safe Literal Rendering
- Each finding presents:
  - Human-friendly check type (e.g. `Project title`, `Document formatting`, `Document extraction`).
  - Semantic outcome badge (`Title match`, `Review suggested`, `Possible title mismatch`, `Information`).
  - Review status badge (`Unreviewed`, `Reviewed`, `Ignored`).
  - Side-by-side title comparison (Metadata Title vs Document Candidate Title).
  - Score percentage (clearly labeled as lexical similarity evidence).
  - Document excerpt with page number.
- **Untrusted Text Security**: All document excerpts and candidate values are rendered strictly as text nodes in the DOM. No `dangerouslySetInnerHTML` or Markdown parsing is performed on untrusted candidate strings.

### E. Accessible Actions
- **Copy Text**: Copies candidate or excerpt string to the clipboard with accessible temporary `Copied` confirmation.
- **Apply to Draft**: Available for `TITLE_CONSISTENCY` findings on `CURRENT` runs when staff has `projects.edit`. If the user already has unsaved title edits, the UI prompts for confirmation before updating `draft.title`, switching to edit mode, and focusing `#metadata-title`.
- **Mark Reviewed / Ignore**: Toggles reviewer disposition for audit compliance.

---

## 6. Verification & Test Suite

The staff UI is verified by an exhaustive test suite:
- `assistiveValidationStaffInspectionMigration.test.ts`: Migration 0032 identity, SHA-256 verification, grant hardening, and fail-closed isolation.
- `inspectionContract.test.ts`: Strict Zod schema parsing and secret omission.
- `assistiveInspectionService.test.ts`: Run loading, stale calculation, and active in-flight polling isolation.
- `assistiveActions.test.ts`: Server action authentication, authorization, project association, and disposition handling.
- `projectAssistiveChecksState.test.ts`: Reducer lifecycle, status formatters, and eligibility predicates.
- `ProjectAssistiveChecks.test.tsx`: Component rendering, active polling, copy feedback, stale banners, disposition triggers, and XSS safety.
- `ProjectMetadataEditor.test.tsx`: "Apply to draft" handler registration, mode switching, dirty tracking, and unsaved changes confirmation.
