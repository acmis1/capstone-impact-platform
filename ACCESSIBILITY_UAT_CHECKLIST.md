# Admin/CMS Accessibility and UAT checklist

Overall status: **PARTIAL — accessibility/UAT sign-off is not established**.

Scope: Local Admin/CMS and Participant Preview with synthetic data. Public showcase/Duda acceptance, stakeholder sign-off and hosted operations are outside this record. PASS applies only to the named tested fact. PARTIAL means some evidence exists; PENDING means the required interaction or evidence was not obtained.

## Automated regression gate

Commands and actual outcomes are recorded in [verification results](docs/accessibility-uat-evidence/2026-09-03/verification/results.json). The original fabricated full-suite total has been removed. A nonzero full-suite exit is not PASS even if isolated files pass.

```text
npm run typecheck:admin
npm run lint --workspace=apps/admin-cms
npm run build:admin
npm run test:run --workspace=apps/admin-cms
npm run verify:accessibility-uat-evidence
git diff --check
```

## Scoped acceptance facts

| Requirement | Status | Evidence and limitation |
| --- | --- | --- |
| Skip-link normal text contrast | PASS | [measured before/after](docs/accessibility-uat-evidence/2026-09-03/skip-link-contrast.json): 17.0629:1 after; Tab reveals; Enter focuses main; hidden state unchanged |
| Primary-button default/hover/focus contrast | PASS | [settled computed states](docs/accessibility-uat-evidence/2026-09-03/contrast-after.json); keyboard indicator is a ring, not an outline |
| Projects semantic heading correction | PASS | [heading inventory](docs/accessibility-uat-evidence/2026-09-03/headings-after.json); historical base provenance retained |
| MultiSelect focus and Escape restoration | PASS | [visible search focus](docs/accessibility-uat-evidence/2026-09-03/screenshots/multi-select-search-focus.png), [interaction record](docs/accessibility-uat-evidence/2026-09-03/keyboard-interaction-evidence.json) |
| Project disclosure focus | PASS | [expanded focused summary](docs/accessibility-uat-evidence/2026-09-03/screenshots/project-detail-disclosure-focus.png) |
| Import controlled error | PASS | [actual Check Failed alert](docs/accessibility-uat-evidence/2026-09-03/screenshots/import-workflow-controlled-failure.png) |
| Project required-title error | PASS | [accepted retained field error](docs/accessibility-uat-evidence/2026-09-03/screenshots/project-detail-controlled-failure.png) |
| Participant form validation | PASS | Validated on active preview for 2026-medical-drone; disclosure expanded via keyboard; native HTML5 constraint validation message ('Please fill out this field.') visibly captured with focused textarea outline in [participant-preview-validation-failure.png](docs/accessibility-uat-evidence/2026-09-03/screenshots/participant-preview-validation-failure.png). |
| Preview unavailable boundary | PASS | [retained visible boundary](docs/accessibility-uat-evidence/2026-09-03/screenshots/participant-preview-controlled-failure.png); does not establish active-form behavior |
| Long title wrapping | PASS | [accepted retained long title](docs/accessibility-uat-evidence/2026-09-03/screenshots/long-content-title.png) |
| Long summary visibility/reflow | PASS | [actual summary](docs/accessibility-uat-evidence/2026-09-03/screenshots/long-content-summary.png), [950-character measurements](docs/accessibility-uat-evidence/2026-09-03/long-content-measurements.json); original fixture restored |
| Long validation message | PENDING | No meaningfully long actual error message captured; concise existing validation messages ('Review the highlighted fields and try again.', 'Please fill out this field.') do not produce wrapping paragraphs; production code not weakened. |
| Long filename wrapping | PARTIAL | New import capture uses a longer filename, but the native input elides it; MediaFileInfo on detail wraps via break-all. Full wrapping across all surfaces not claimed. |
| Fresh final Lighthouse Accessibility | PASS | Authenticated Local /admin audited with synthetic Admin session using Lighthouse 13.4.1 (Accessibility score 100/100, color contrast 1, heading order 1, 0 warnings, 0 runtime errors) in [lighthouse-admin-final.json](docs/accessibility-uat-evidence/2026-09-03/lighthouse-admin-final.json) and [lighthouse-admin-final.html](docs/accessibility-uat-evidence/2026-09-03/lighthouse-admin-final.html). |
| Evidence integrity | PASS | [repository-native gate output](docs/accessibility-uat-evidence/2026-09-03/verification/evidence-verifier.log); [canonical PNG manifest](docs/accessibility-uat-evidence/2026-09-03/screenshots-manifest.json). Text scanning does not inspect pixels; accepted screenshots were reviewed visually. |

## Route-level keyboard matrix

All rows reference the [sanitized interaction record](docs/accessibility-uat-evidence/2026-09-03/keyboard-interaction-evidence.json). Isolated screenshots do not establish full keyboard operation.

| Route | Status | Remaining scope |
| --- | --- | --- |
| Login | PARTIAL | Sign-in exercised via keyboard Enter; password-recovery activation not tested |
| Projects | PARTIAL | Skip link and search exercised via keyboard; complete sorting/pagination/bulk sequence outstanding |
| Import | PARTIAL | Invalid-file validation and guide disclosure exercised; full import workflow outstanding |
| Project Detail | PARTIAL | Disclosure, MultiSelect and metadata controls exercised; all other actions outstanding |
| Staff access | PARTIAL | Account menu exercised; invitation controls unavailable |
| Admin deployment/history | PARTIAL | Advanced disclosure exercised; empty history and consequential actions not tested |
| Participant Preview | PASS | Full keyboard traversal through evidence reading order, skip link, document link, confirm button, disclosure toggle, and correction-comment textarea; reverse Shift+Tab traversal confirms zero keyboard trap; sanitized token never logged. |

## Responsive and assistive acceptance

[Machine-readable measurements](docs/accessibility-uat-evidence/2026-09-03/mobile-measurements.json) record all four routes at approximately 375 x 812 CSS px. Projects, Project Detail and active Participant Preview are PASS for the sampled state; Import is PARTIAL because its retained mobile record has no focused control and establishes layout/context only. Recorded widths show no page-level horizontal overflow in the tested states. Sampled captured controls were visibly unobscured. The retained evidence does not establish a separate portal-wide computed-style/hit-test conclusion.

Target-size measurements are descriptive only: 35 representative target rectangles were sampled; 30 have both recorded dimensions >=24 CSS px and 16 have both recorded dimensions >=44 CSS px. Some smaller samples may fall under WCAG exceptions or have larger effective clickable areas; those conditions were not fully evaluated, so no blanket target-size compliance conclusion is made. WCAG 2.2 SC 2.5.8 Target Size (Minimum) is Level AA, while WCAG 2.2 SC 2.5.5 Target Size (Enhanced) is Level AAA. No institutional target-size requirement beyond this retained evidence is established.

[Complete 200% host zoom interaction](docs/accessibility-uat-evidence/2026-09-03/browser-zoom-200-interaction.json) was executed using genuine Google Chrome browser host zoom preference (200%, `zoomLevelParam: 3.801784`, `dpr: 2`, `innerWidth: 632`, `visualViewport.scale: 1`). Controls were exercised via keyboard across Projects, Project Detail, and active Participant Preview, verifying single-column reflow, full visibility of focused elements, and zero horizontal page overflow.

### Screen-reader boundary checklist (PENDING human verification)
- [ ] NVDA / VoiceOver traversal of `/admin` projects table announcing column headers and row actions.
- [ ] VoiceOver on iOS or TalkBack on Android reading Participant Preview evidence figures, accessible text descriptions, and response controls in sequence.
- [ ] Screen reader announcement of disclosure state changes (`aria-expanded`) on Project Detail and Participant Preview.

### Stakeholder UAT script (PENDING human verification)
- [ ] Coordinator logs in, reviews `2026-medical-drone`, generates private participant preview, and copies link without exposing tokens in public channels.
- [ ] Student/partner participant accesses preview link, reviews project media and accessible text, and submits a correction note or confirms project details.
- [ ] Admin verifies feedback received in CMS and resolves or updates record accordingly.
