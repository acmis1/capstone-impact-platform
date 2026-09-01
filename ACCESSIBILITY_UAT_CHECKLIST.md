# Admin/CMS Accessibility and Stakeholder UAT Checklist

## Scope

This document records the repeatable accessibility and usability acceptance pass for the staff-facing Admin/CMS and the participant preview.

Testing is local-data-only. Duda, hosted Supabase/Render operations, schema/RLS/auth-role changes, broad visual redesign, and public-site accessibility are outside this task.

### This is not the final project-wide accessibility sign-off

This checklist covers the staff-facing Admin/CMS, the participant preview, and local accessibility/UAT evidence only. It must not be cited as proof of public showcase or Duda accessibility acceptance.

Final project-wide accessibility acceptance additionally requires, and is tracked separately from this document:

- public showcase / Duda listing and detail behaviour;
- merged gallery and public media accessibility, where applicable;
- manual accessibility evaluation beyond automated tooling;
- stakeholder and UAT acceptance sign-off.

## Status definitions

- **PASS** — supported by evidence another reviewer can reproduce from this repository.
- **PENDING** — browser or manual evidence is still required before accessibility/UAT sign-off. A check stays PENDING when it was observed locally but left no reproducible artefact.
- **N/A** — outside task scope.

A row is only recorded as PASS when its evidence column names a command, test or file that can be re-run. Author-reported observations that left no artefact are labelled as such and remain PENDING.

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
| ESLint | PASS | `npm run lint --workspace=apps/admin-cms` — 0 errors, 6 pre-existing warnings in files this change does not touch |
| Full Vitest suite | PASS | `npm run test:run --workspace=apps/admin-cms` — 274 files passed, 1 skipped; 3889 tests passed, 14 skipped |
| Design-token and preview contrast | PASS | `src/lib/designTokenContrast.test.ts`, `src/previews/participantPreviewContrast.test.ts` |
| Dashboard metrics list semantics | PASS | `src/components/admin-dashboard/projectIndexStates.test.tsx` |
| Publication disclosure semantics and focus contract | PASS | `src/components/admin/PublicationWorkflowPanels.test.tsx` |
| Assistive-check workflow after remediation | PASS | `src/components/admin/__tests__/ProjectAssistiveChecks.test.tsx` |
| Lighthouse Accessibility — Projects index | PENDING | Unreconciled; see below |

Existing repository contracts already cover accessible names, `aria-invalid`, `aria-describedby`, status/alert regions, semantic state text, dialog focus restoration, participant response regions and design-token contrast.

### Automated browser evidence

- Tool: Chrome DevTools Lighthouse, run locally by the change author.
- Route: Projects index (`/admin`).
- Author-reported baseline before remediation: Accessibility 88.
- Author-reported findings included definition-list structure, contrast, heading-order and identical-link checks.
- Author-reported post-remediation score: **conflicting.** Two different values were recorded in the same change, 96 and 100.
- No Lighthouse report or artefact was retained, so neither post-remediation value can be reproduced and no final score is selected here.
- To move this row to PASS: perform one Lighthouse Accessibility run on `/admin` against the current head, retain the report, and record the score and run date in this section.
- The `DashboardMetricsSummary` definition-list defect is independently confirmed by source review and is protected by a focused semantic regression test. That remediation does not depend on the Lighthouse score.
- Automated scanning covers only a subset of accessibility requirements. Keyboard, responsive and accessibility-tree checks are tracked separately below.

## Defects and Remediation

| Route / component | Problem | Severity | Remediation | Evidence | Remaining evidence |
| --- | --- | --- | --- | --- | --- |
| Projects index / `DashboardMetricsSummary` | `<dt>`/`<dd>` sat two levels below the `<dl>`, so they formed no valid definition-list group | Medium | Replaced with an explicit `role="list"` / `role="listitem"` structure, preserving metric order, text and layout | `projectIndexStates` regression PASS; typecheck PASS | Lighthouse re-run with retained report |
| Project detail / `PublicationReadinessPanel` | Technical disclosure lacked consistent explicit keyboard focus indication | Medium | Reused the existing design-token focus-visible ring on the native `<summary>` | Typecheck and workflow tests PASS; disclosure regression PASS | Browser focus evidence |
| Project detail / `PublicationPreparationPanel` | Publication technical disclosures lacked consistent explicit keyboard focus indication | Medium | Reused the existing focus-visible contract | Typecheck and workflow tests PASS | Browser focus evidence |
| Project detail / `ProjectAssistiveChecks` | Diagnostic disclosures lacked consistent explicit keyboard focus indication | Medium | Reused the existing focus-visible contract while retaining native semantics | Assistive-check tests PASS | Browser focus evidence |
| Import batch detail | Advanced-details disclosure lacked consistent explicit keyboard focus indication | Medium | Reused the existing focus-visible contract | Typecheck PASS | Import keyboard evidence |

Every `<summary>` control under `apps/admin-cms/src` was reviewed. All of them now carry the same
`focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2`
contract, either inline or through a shared class constant, so no control of this defect class remains
in the scoped staff workflows.

No new colour system, UI framework, schema, RLS, role model or validation behaviour was introduced.

## Required Test Matrix

These rows require an interactive browser session and are not evidenced by the automated suite.

| Test | Projects index | Import | Project detail | Participant preview |
| --- | --- | --- | --- | --- |
| Keyboard desktop | PENDING | PENDING | PENDING | PENDING |
| 200% desktop zoom | PENDING | N/A | PENDING | PENDING |
| Mobile 360-430 px | PENDING | PENDING | PENDING | PENDING |
| Controlled error | N/A | PENDING | PENDING | PENDING |
| Role/action availability | PENDING | PENDING | PENDING | N/A |
| Long content | PENDING | PENDING | PENDING | PENDING |

Author-reported: these checks were exercised locally in Chrome. No screenshots, exported reports or
other capturable evidence were attached and they have not been independently reproduced, so they
remain PENDING under the status definitions above.

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

Automated tests can assert that a control is a native `<summary>` inside `<details>`, that it starts
collapsed, that it carries the focus-ring contract, and that the disclosure still toggles. They cannot
assert keyboard activation: jsdom does not implement Enter/Space activation for `<summary>`. Keyboard
operation is therefore a browser/UAT check, and a click-only test must not be described as proving it.

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

Author-reported: Participant Preview was reviewed for semantic project evidence, accessible control
names, labelled response controls and evidence-before-response order; Project Detail was reviewed for
heading/section structure, accessible form/control names, semantic status regions, review-action names
and native disclosure state, using the Chrome DevTools Accessibility Tree. No accessibility-tree
capture was retained, so both rows remain PENDING.

Limitation: no NVDA screen-reader session was performed.

## Zoom and Mobile

At 200% desktop zoom verify representative Projects index, project detail and participant preview routes.

At approximately 360-430 CSS px verify Projects index, import results, project detail and participant preview.

Check for:

- disappearing critical operations;
- overlap or clipping;
- inappropriate two-dimensional scrolling;
- sticky UI covering focus/error/action regions;
- safe wrapping of long titles, errors, filenames, statuses and summaries;
- practical mobile target sizes.

Author-reported as exercised locally. No capture was retained and the checks have not been
independently reproduced.

Status: **PENDING**

## Contrast

Existing design-token contrast tests pass and are reproducible via
`src/lib/designTokenContrast.test.ts` and `src/previews/participantPreviewContrast.test.ts`.

Status (automated design-token contrast): **PASS**

Author-reported: representative manual review of warning, success and destructive text, visible focus
indicators, status/badge readability and practical mobile control sizing. Not evidenced here.

Status (manual contrast review): **PENDING**

Do not introduce one-off colours to address contrast defects.

## Project-wide Acceptance Boundary

The gates below are deliberately separate.

- **Regression Gate Before Merge** — automated, reproducible, and the gate that applies to a scoped
  code-hardening change such as this one. It must be green before merge.
- **Evidence Required Before Accessibility/UAT Sign-off** — browser and manual evidence for the whole
  accessibility/UAT acceptance pass. Outstanding items here do not by themselves block a scoped code
  change whose automated regression gate is green; they block accessibility/UAT sign-off.

Neither gate covers the public showcase/Duda surfaces described under Scope.

## Evidence Required Before Accessibility/UAT Sign-off

Capture and retain meaningful evidence for:

1. Project index keyboard/focus behaviour.
2. Import keyboard or controlled-error behaviour.
3. Project detail showing a remediated disclosure with keyboard focus.
4. Participant preview reading order and controls.
5. Representative 200% desktop zoom.
6. Representative 360-430 px mobile viewport.
7. One controlled validation/failure case.
8. Accessibility-tree or screen-reader review of participant preview.
9. Accessibility-tree or screen-reader review of one major Admin workflow.
10. One Lighthouse Accessibility run on `/admin` against the current head, with the report retained and the score and run date recorded.

Automated Lighthouse, axe or WAVE evidence should only be recorded if available locally without adding a large dependency solely for this task.

## Regression Gate Before Merge

```text
npm run typecheck:admin
npm run lint --workspace=apps/admin-cms
npm run test:run --workspace=apps/admin-cms
git status --short
```
