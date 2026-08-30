# Admin/CMS Accessibility and Stakeholder UAT Checklist

## Scope

This document records the repeatable accessibility and usability acceptance pass for the staff-facing Admin/CMS and participant preview.

Testing is local-data-only. Duda, hosted Supabase/Render operations, schema/RLS/auth-role changes, broad visual redesign, and public-site accessibility are outside this task.

Status definitions:

- **PASS** — supported by completed automated, source, or manual evidence.
- **PENDING** — browser/manual evidence is still required before PR completion.
- **N/A** — outside task scope.

## Baseline Inventory

| Surface | Representative route | Coverage |
| --- | --- | --- |
| Authentication | `/login` | Sign-in and authentication feedback |
| Projects dashboard | `/admin` | Search, filters, sorting, pagination, bulk selection |
| Imports | `/admin/imports` | Import workflow navigation |
| New import | `/admin/imports/new` | File input, preview, validation and failure feedback |
| Import batch | `/admin/imports/[batchId]` | Validation results, project review and advanced details |
| Project detail | `/admin/projects/[publicId]` | Metadata, validation, review, participant and publication workflow |
| Staff access | `/admin/staff` | Staff access-management UI |
| Public deployment/history | `/admin/public-feed` | Admin/CMS deployment evidence only |
| Participant preview | `/participant-preview/[token]` | Evidence, confirmation and correction |

## Automated Baseline

| Check | Status | Evidence |
| --- | --- | --- |
| TypeScript | PASS | `npm run typecheck:admin` |
| ESLint | PASS | 0 errors; baseline contained 6 pre-existing warnings |
| Full Vitest suite | PASS | Baseline: 274 passed files, 1 skipped; 3889 passed tests, 14 skipped |
| Accessibility-focused tests | PASS | 4 files / 55 tests |
| Publication disclosure regression | PASS | Native disclosure semantics regression added and passing |
| Relevant workflow tests after remediation | PASS | Publication and assistive-check suites pass |

Existing repository contracts already cover accessible names, `aria-invalid`, `aria-describedby`, status/alert regions, semantic state text, dialog focus restoration, participant response regions and design-token contrast.

## Defects and Remediation

| Route / component | Problem | Severity | Remediation | Evidence | Remaining evidence |
| --- | --- | --- | --- | --- | --- |
| Project detail / `PublicationReadinessPanel` | Technical disclosure lacked consistent explicit keyboard focus indication | Medium | Reused existing design-token focus-visible ring on native `<summary>` | Typecheck and workflow tests PASS; disclosure regression PASS | Browser focus evidence |
| Project detail / `PublicationPreparationPanel` | Publication technical disclosures lacked consistent explicit keyboard focus indication | Medium | Reused existing focus-visible contract | Typecheck and workflow tests PASS | Browser focus evidence |
| Project detail / `ProjectAssistiveChecks` | Diagnostic disclosures lacked consistent explicit keyboard focus indication | Medium | Reused existing focus-visible contract while retaining native semantics | Assistive-check tests PASS | Browser focus evidence |
| Import batch detail | Advanced-details disclosure lacked consistent explicit keyboard focus indication | Medium | Reused existing focus-visible contract | Typecheck PASS | Import keyboard evidence |

No new colour system, UI framework, schema, RLS, role model or validation behaviour was introduced.

## Required Test Matrix

| Test | Projects index | Import | Project detail | Participant preview |
| --- | --- | --- | --- | --- |
| Keyboard desktop | PENDING | PENDING | PENDING | PENDING |
| 200% desktop zoom | PENDING | N/A | PENDING | PENDING |
| Mobile 360-430 px | PENDING | PENDING | PENDING | PENDING |
| Controlled error | N/A | PENDING | PENDING | PENDING |
| Role/action availability | PENDING | PENDING | PENDING | N/A |
| Long content | PENDING | PENDING | PENDING | PENDING |

### Keyboard acceptance

Verify:

- all interactive controls are reachable and operable;
- tab order is logical;
- there are no keyboard traps;
- focus is visibly perceivable;
- dialogs return focus sensibly;
- table/card/bulk actions remain keyboard operable;
- no arbitrary positive `tabIndex` determines navigation order;
- sticky UI does not obscure focused controls.

### Forms, errors and status

Verify:

- every field has an accessible name;
- required/invalid state is semantic and not colour-only;
- errors are associated with the relevant field or region;
- important loading, success and failure states are announced without noisy duplication;
- icon-only controls have reliable accessible names;
- warning/destructive/corrective actions are not colour-only;
- raw backend errors are not exposed.

### Structure and assistive technology

Verify:

- heading hierarchy and landmarks remain meaningful;
- table headers and sorting semantics are exposed;
- mobile cards preserve equivalent meaning and actions;
- status badges contain readable text;
- disclosures expose expanded/collapsed state;
- participant evidence precedes response controls;
- repeated project/media controls are distinguishable.

Required assistive-technology evidence:

- Participant preview — **PENDING**
- One major Admin workflow — **PENDING**

NVDA is preferred on Windows. If unavailable, record the actual browser accessibility-tree/tool used and document that limitation.

## Zoom and Mobile

At 200% desktop zoom verify representative project index, project detail and participant preview routes.

At approximately 360-430 CSS px verify project index, import results, project detail and participant preview.

Check for:

- disappearing critical operations;
- overlap or clipping;
- inappropriate two-dimensional scrolling;
- sticky UI covering focus/error/action regions;
- safe wrapping of long titles, errors, filenames, statuses and summaries;
- practical mobile target sizes.

Status: **PENDING**

## Contrast

Existing design-token contrast tests passed at baseline.

Representative manual review is still required for warning, success and destructive text, focus indicators and small mobile controls.

Do not introduce one-off colours to address contrast defects.

Status: **PENDING**

## Evidence Required Before PR

Capture meaningful evidence for:

1. Project index keyboard/focus behaviour.
2. Import keyboard or controlled-error behaviour.
3. Project detail showing a remediated disclosure with keyboard focus.
4. Participant preview reading order and controls.
5. Representative 200% desktop zoom.
6. Representative 360-430 px mobile viewport.
7. One controlled validation/failure case.
8. Accessibility-tree or screen-reader review of participant preview.
9. Accessibility-tree or screen-reader review of one major Admin workflow.

Automated Lighthouse, axe or WAVE evidence should only be recorded if available locally without adding a large dependency solely for this task.

## Regression Gate

Before opening the PR:

```text
npm run typecheck:admin
npm run lint:admin
npm run test:run --workspace=apps/admin-cmsgit status --short