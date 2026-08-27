# PP1 Phase 5: Staff Assistive Checks UI

## 1. Overview & Purpose

Phase 5 of the PP1 AI/OCR assistive validation subsystem introduces the production-quality staff editorial interface. Situated within the **Review and edit** workspace of the project detail page, the interface enables editorial staff to execute on-demand checks, monitor asynchronous progress, inspect evidence excerpts and title candidates, copy evidence, apply candidate titles to client draft forms, and record reviewer dispositions.

### Non-Authoritative Invariant
Assistive validation is strictly **advisory** and **non-blocking**:
- Assistive findings **never** directly mutate project status, workflow gates, publication readiness, or database records.
- "Apply to draft" populates the in-browser `ProjectMetadataEditor` form draft and marks the form dirty; persistence occurs only when staff explicitly clicks **Save metadata**, invoking the authoritative `saveProjectMetadataAction` audit pipeline.
- Phase 7 language findings use the same browser-only boundary for one selected replacement. The editor rechecks the stored Unicode-code-point source span against the current draft before changing only that span; stale or mismatched evidence is refused.
- Finding dispositions (`REVIEWED`, `IGNORED`) are editorial tracking records, not project approvals.
- Assistive status labels never use misleading terminology (e.g. "AI approved", "validation passed", "blocking").

---

## 2. Canonical Migration 0032

To provide bounded, read-only inspection of active/terminal runs, current job lifecycle status, and findings, Migration 0032 is introduced. Migrations 1–31 remain byte-for-byte unmodified against `origin/main`.

- **Canonical Migration Filename**: `20260821090000_assistive_validation_staff_inspection.sql`
- **SHA-256 Digest**: `817e6b0cbc87b33edde6bcaf64f56d9dedf65035e490446bc742854b667857f3`

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

### Security, Isolation & Privacy Invariants
1. **Service-Role Execution Only**: `REVOKE ALL` from `PUBLIC, anon, authenticated, service_role`; `GRANT EXECUTE` strictly to `service_role`.
2. **Deny-All Table Protection**: Direct table access remains denied on `assistive_validation_runs`, `assistive_validation_jobs`, and `assistive_validation_findings`.
3. **Fail-Closed Project Association**: If `p_run_id` is supplied but belongs to a different project, the function returns `NOT_FOUND`.
4. **No Secret or Token Leakage**: Claim tokens, worker IDs, lease timestamps, private bucket names, and storage paths are completely omitted from return payloads.
5. **Privacy Boundary**: Reviewer identity UUIDs (`reviewed_by`) and audit timestamps (`reviewed_at`) remain durably stored by Phase 3 but are strictly omitted from the Phase 5 browser inspection payload.
6. **Finding Count Bound**: Finding array is strictly capped to <= 50 findings. If count exceeds bounds, the RPC fails closed with `INVARIANT_VIOLATION`.
7. **No Fabricated Job State**: Exactly one job row must exist per run (Migration 31 invariant). Missing job rows return `INVARIANT_VIOLATION`.
8. **No Dynamic SQL & No Mutations**: The inspection function performs zero database writes and uses zero dynamic SQL formatting.

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
| `runAssistiveChecksAction(publicId)` | `projects.read` | Authenticates staff via `requireAdmin()`, checks environment execution availability, resolves non-deleted project ID, enqueues Phase 4 asynchronous job. |
| `cancelAssistiveChecksAction(publicId, runId)` | `projects.read` | Verifies run belongs to non-deleted project with strict schema parsing, requests job cancellation in Postgres queue. |
| `recordAssistiveDispositionAction(publicId, runId, findingId, disposition)` | `projects.review` | Verifies reviewer role, ensures finding belongs to non-deleted project run with strict schema parsing, records `REVIEWED` or `IGNORED` disposition without returning staff UUID to browser. |
| `getAssistiveInspectionAction(publicId, runId?)` | `projects.read` | Fetches bounded inspection run, job status, findings, and computes stale state. |

### Environment Execution Boundary
- Asynchronous worker and coordinator execution is currently supported in local loopback environments (`isAssistiveExecutionAvailable()`).
- In hosted environments where no worker daemon is deployed, the server action returns `EXECUTION_UNAVAILABLE` and the UI presents a truthful notice while allowing read-only access to historical findings.

---

## 5. UI Features & Operational Workflows

### A. Asynchronous Polling Lifecycle
- While a check job is active (`QUEUED`, `EXTRACTING`, `CHECKING`, `RUNNING`), the client component uses a self-scheduling bounded polling loop (`schedulePoll` every 2.5s).
- Polling requests never overlap (`isPollingRef`). Polling stops on terminal state (`COMPLETED`, `PARTIAL`, `FAILED`, `CANCELLED`, `SUPERSEDED`) or unmount.
- Transient read failures preserve the last known inspection view and re-schedule the next poll interval.
- If a specific active run returns `NOT_FOUND`, polling clears that unavailable run, exits the active spinner, and reports that the run is no longer available without fabricating a terminal backend state.

### B. Stale-Run Detection & Synchronization
- When a terminal run is evaluated, `loadAssistiveInspection` checks current project title and poster hash:
  - **`CURRENT`**: Title and poster match the evaluated snapshot.
  - **`STALE`**: Metadata or poster changed after the run. Warning banner is shown; "Apply to draft" is disabled.
  - **`UNVERIFIABLE`**: Document assets cannot be verified.
- Client state synchronizes `initialInspection` and `initialReadFailed` as one refreshed server snapshot (after `saveProjectMetadataAction` -> `router.refresh()`), transitioning same-run results to `STALE` or `UNVERIFIABLE`, recovering read availability in either direction, and retaining a newer locally started run when an older or failed server read arrives late.

### C. Graceful Partial / Degraded Mode
- When OCR is not run (`OCR_REQUIRED`) or no provider is configured (`OCR_PROVIDER_UNAVAILABLE`), whatever native text layer the document carries is checked and the status is set to `PARTIAL`.
- The notice is completion-code aware and media-neutral. A PNG, JPEG, or scanned poster has no native text layer at all, so the copy says native text was checked *when available* rather than asserting that born-digital PDF text was evaluated on every partial run.

### D. Evidence Presentation & Accessibility Targets
- **WCAG 2.2 AA target (not a certification)**: the surface is built against the repository accessibility target and was exercised at 390px, 768px, and 1440px with keyboard focus, semantic heading levels, and `motion-safe:animate-spin` / `prefers-reduced-motion` scrolling. No formal conformance audit has been performed and none is claimed.
- **Diagnostic Score Disclosure**: Lexical similarity is presented in an accessible technical details disclosure (`Lexical similarity score: 0.85; Diagnostic evidence only — not confidence or accuracy.`) without percentage or confidence claims.
- **Untrusted Text Security**: All document excerpts and candidate values are rendered strictly as text nodes in the DOM. No `dangerouslySetInnerHTML` or Markdown parsing is performed on untrusted candidate strings.
- **Apply to Draft**: Available for `TITLE_CONSISTENCY` findings on `CURRENT` runs when candidate fits the canonical 200-character bound (`PROJECT_METADATA_LIMITS.title`).

---

## 6. Verification & Test Suite

The staff UI is covered by the following automated evidence. Unit tests alone are not treated as
sufficient for this phase: the browser workflow was exercised against disposable Local Supabase as
well (see section 7).
- `assistiveValidationStaffInspectionMigration.test.ts`: Migration 0032 identity, SHA-256 verification, grant hardening, finding bounds, and privacy invariants.
- `verifyAssistiveValidationStaffInspectionRuntime.ts`: Local Supabase runtime verifier covering 26 scenarios, including the fifty-finding bound, the retry-queued failure-code invariant, and an end-to-end parse of a seeded-shape project identifier through the browser-facing contract.
- `inspectionContract.test.ts`: Strict Zod schema parsing, max 50 finding limit, and secret/identity omission.
- `assistiveInspectionService.test.ts`: Run loading, stale calculation, and in-flight polling isolation.
- `assistiveActions.test.ts`: Server action authentication, authorization, project association, execution availability, and disposition handling.
- `projectAssistiveChecksState.test.ts`: Reducer lifecycle, status formatters, 200-character title eligibility, and truthful partial notices.
- `ProjectAssistiveChecks.test.tsx`: Component rendering, recursive polling, no overlap, unmount cleanup, transient failure recovery, coherent server-prop sync, active-run `NOT_FOUND`, copy feedback, and XSS safety.
- `ProjectMetadataEditor.test.tsx`: "Apply to draft" handler registration, mode switching, dirty tracking, reduced motion, status-versus-error notice channel, and unsaved changes confirmation.
- `postgresCanonicalUuid.test.ts`: which identifier boundaries accept canonical database UUID text and which stay strict, including the job claim token.

---

## 7. Browser Verification

The workflow was driven in a real browser against the real Admin/CMS and disposable Local Supabase,
using synthetic fixtures only, at 390px, 768px, and 1440px.

Observed: the no-history empty state; local Run checks availability; an active `QUEUED` run polled
repeatedly while its state did not change, with non-overlapping requests; a `COMPLETED` run with
findings; a `PARTIAL` run produced by a PNG poster with OCR left at its `NONE` default; document text
containing markup rendered literally; copy success and copy failure; "Apply to draft" changing only
the title in the existing client draft, focusing the field, leaving the editor dirty and persisting
nothing; an explicit "Save metadata" through the existing authoritative workflow, after which the
historical run became `STALE` and its finding could no longer be applied; a reviewer disposition
surviving reload; an editor-only account offered no disposition controls and a reviewer-only account
no "Apply to draft"; keyboard-focusable controls; and reduced-motion behaviour.

Additional failure and race states are covered by deterministic component and Server Action tests rather than in-browser observation. Both
the execution-availability gate and the Supabase admin client read `NEXT_PUBLIC_SUPABASE_URL`, so
rendering the execution-unavailable state in a browser would require pointing the application at a
non-loopback Supabase, which the repository safety boundary does not permit. The assistive-read
failure recovery and active-run `NOT_FOUND` states likewise require forcing server-side read outcomes.
