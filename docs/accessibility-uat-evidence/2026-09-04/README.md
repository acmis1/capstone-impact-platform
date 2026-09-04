# Integrated Accessibility/UAT Evidence (2026-09-04)

Overall acceptance: **PARTIAL (Integrated PP1 scoped automated gates pass; Import and deployment/history remain PARTIAL; native screen readers and stakeholder UAT remain PENDING human verification)**.

This directory records the final machine-verifiable Accessibility and User Acceptance Testing (UAT) evidence on the integrated PP1 application (`acmis1/capstone-impact-platform`), incorporating merged PR #262 (`feat(participant): integrate owned correction workflow (#262)`).

All browser interactions were executed against a local Next.js dev server on loopback `http://127.0.0.1:3000` backed by local Supabase on port `54321`. No external or cloud services (hosted Supabase, Duda, Render, Vercel, Azure) were contacted.

## Opus Review Correction Dispositions

This evidence pass directly addresses and closes all four independent review findings:

| Finding | Defect / Ambiguity | Resolution & Proof |
| --- | --- | --- |
| 1. Preflight Cancel Focus Restoration | Cancelling inline preflight in `BulkProjectReviewPanel.tsx` unmounted the Cancel button without restoring focus to the triggering action button, reverting focus to `body`. | **FIXED**: In `apps/admin-cms/src/components/admin-dashboard/BulkProjectReviewPanel.tsx`, added trigger button refs, `handleCancel` focus restoration, and Escape key listener. Verified in unit tests [BulkProjectReviewPanel.test.tsx](../../../apps/admin-cms/src/components/admin-dashboard/BulkProjectReviewPanel.test.tsx) (passing 8/8 tests, including Request changes Cancel/Escape after a prior Approve preflight) and automated browser keyboard test in [keyboard-interaction-evidence.json](./keyboard-interaction-evidence.json). |
| 2. Projects Multi-Page Pagination & Selection | 2026-09-03 evidence did not exercise real multi-page pagination or current-page selection with >10 records. | **FIXED**: Seeded synthetic projects in local database (12 total); multi-page Next/Previous navigation and boundary states were exercised against the 12-record Local dataset. Select current page selected all visible rows with focus retained. No per-page row identities or explicit numeric selected-row count are retained. The [Projects screenshot](./screenshots/projects-index-desktop-keyboard.png) is context-only; operational facts are recorded in [keyboard-interaction-evidence.json](./keyboard-interaction-evidence.json). |
| 3. Target Size SC 2.5.8 Analysis | Historical evidence made invalid "spacing exception" claims on 0x0 nodes and keyboard-only disclosures. | **FIXED**: Rigorous route-by-route audit in [admin-target-size-analysis.json](./admin-target-size-analysis.json). Delineates displayed controls (e.g. skip link 122x36 CSS px) vs hidden nodes; evaluates effective clickable regions (e.g. `<label>` elements >=24x24px for 16px checkboxes); evaluates neighbor distances/circles without misapplying spacing exceptions to non-pointer elements. |
| 4. Integrated Participant Workflow Post-#262 | Participant correction workflow was merged in PR #262; required verification under integrated authority. | **FIXED**: Generated legitimate active preview via local API with `{ sendEmail: false }`; validated reading order (project evidence preceding response controls); expanded Request corrections disclosure via keyboard; submitted empty textarea and observed native constraint validation in the interaction record; verified single-column reflow at 375x812 mobile and 200% zoom. Visible context (without a focused skip link or validation bubble) retained in [participant-preview-reading-order.png](./screenshots/participant-preview-reading-order.png) and [participant-preview-validation-failure.png](./screenshots/participant-preview-validation-failure.png). Revoked preview cleanly via DELETE API. |

## Machine-Verifiable Reproduction Gates

To verify evidence integrity:

```bash
npm run verify:accessibility-uat-evidence
npm run --silent verify:accessibility-uat-evidence -- --manifest
npm run verify:accessibility-uat-evidence -- --committed
```

- The first command verifies the uncommitted working-tree evidence against credential, secret, session, and reference rules.
- The middle command verifies the PNG screenshot manifest matches byte-for-byte in dimensions, hashes, and size.
- The third command verifies all committed evidence directly from Git HEAD.

## Retained Evidence Inventory

- [keyboard-interaction-evidence.json](./keyboard-interaction-evidence.json): Sampled keyboard interactions, role, key sequence, and focus restoration records across Login, Projects (including multi-page pagination and bulk review cancel restoration), Import, Staff access, Public feed deployment, Project detail, and Participant preview.
- [admin-target-size-analysis.json](./admin-target-size-analysis.json): Route-by-route analysis under WCAG 2.2 SC 2.5.8 Target Size (Minimum, Level AA).
- [mobile-measurements.json](./mobile-measurements.json): Viewport measurements at 375 x 812 CSS px across Projects, Import, Project detail, and Participant preview demonstrating zero horizontal overflow.
- [browser-zoom-200-interaction.json](./browser-zoom-200-interaction.json): Interaction evidence under 200% browser host zoom verifying reflow and keyboard focus visibility.
- [screenshot-state-index.json](./screenshot-state-index.json): State index for all 16 accepted visual captures.
- [screenshots-manifest.json](./screenshots-manifest.json): Canonical PNG dimensions, byte counts, and SHA-256 hashes.

## Lighthouse 13.4.1 Audit

A fresh authenticated audit of Local `/admin` was performed using Lighthouse 13.4.1:
- [lighthouse-admin-final.json](./lighthouse-admin-final.json)
- [lighthouse-admin-final.html](./lighthouse-admin-final.html)

Audit results:
- **Accessibility Score**: 100/100
- **Color Contrast**: 1 (PASS)
- **Heading Order**: 1 (PASS)
- **Run Warnings**: 0
- **Runtime Errors**: None

## Final route scope

Login and Projects: **PASS — bounded**. Project Detail and Participant Preview: **PASS — integrated post-#262 sampled scope**. Staff: **PASS**.

Import: **PARTIAL**. All imports navigation, preparation-guide disclosure, file input, Check spreadsheet, controlled Check Failed alert and mobile state were sampled. Full traversal through School spreadsheet, Project folder, Check files, Confirm & save and Import media is not established.

Admin deployment/history: **PARTIAL**. The publish-project link received focus; **PASS** applies only to the tested Advanced publishing details expand/collapse interaction. No publishing activity existed. Technical setup details, Advanced rollback tools (Local test only) and version-detail rows/history controls when data exists remain untested. Publication and removal were not executed.

Long filename: **PARTIAL**. Long validation, native screen reader and stakeholder UAT: **PENDING**. Seven corrected screenshots are context-only in the state index; interaction/DOM records support operational conclusions. Historical 2026-09-03 results do not raise this final route scope.
