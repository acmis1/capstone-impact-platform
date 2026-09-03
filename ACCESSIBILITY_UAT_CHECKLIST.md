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
| Participant form validation | PENDING | Local preview generation returned Access denied. Invalid validation screenshot removed. |
| Preview unavailable boundary | PASS | [retained visible boundary](docs/accessibility-uat-evidence/2026-09-03/screenshots/participant-preview-controlled-failure.png); does not establish active-form behavior |
| Long title wrapping | PASS | [accepted retained long title](docs/accessibility-uat-evidence/2026-09-03/screenshots/long-content-title.png) |
| Long summary visibility/reflow | PASS | [actual summary](docs/accessibility-uat-evidence/2026-09-03/screenshots/long-content-summary.png), [950-character measurements](docs/accessibility-uat-evidence/2026-09-03/long-content-measurements.json); original fixture restored |
| Long validation message | PENDING | No meaningfully long actual error message captured; invalid title-only capture removed. |
| Long filename wrapping | PARTIAL | New import capture uses a longer filename, but the native input elides it. No wrapping PASS. |
| Fresh final Lighthouse Accessibility | PENDING | Only the [historical report](docs/accessibility-uat-evidence/2026-09-03/lighthouse-admin.json) exists; it contains Accessibility only. |
| Evidence integrity | PASS | [repository-native gate output](docs/accessibility-uat-evidence/2026-09-03/verification/evidence-verifier.log): 67 files, 31 PNGs, 30 unique hashes, zero findings; [canonical PNG manifest](docs/accessibility-uat-evidence/2026-09-03/screenshots-manifest.json). Text scanning does not inspect pixels; accepted screenshots were reviewed visually. |

## Route-level keyboard matrix

All rows reference the [sanitized interaction record](docs/accessibility-uat-evidence/2026-09-03/keyboard-interaction-evidence.json). Isolated screenshots do not establish full keyboard operation.

| Route | Status | Remaining scope |
| --- | --- | --- |
| Login | PARTIAL | Sign-in exercised; password-recovery activation not tested |
| Projects | PARTIAL | Skip link and search exercised; complete sorting/pagination/bulk sequence outstanding |
| Import | PARTIAL | Invalid-file validation and guide disclosure exercised; full import workflow outstanding |
| Project Detail | PARTIAL | Disclosure, MultiSelect and metadata controls exercised; all other actions outstanding |
| Staff access | PARTIAL | Account menu exercised; invitation controls unavailable |
| Admin deployment/history | PARTIAL | Advanced disclosure exercised; empty history and consequential actions not tested |
| Participant Preview | PENDING | Active preview entry unavailable in this session |

## Responsive and assistive acceptance

[Machine-readable measurements](docs/accessibility-uat-evidence/2026-09-03/mobile-measurements.json) record viewport 375 x 812 and document/client width 360/360 on the measured routes. Projects, Import and Project Detail sampled focus controls avoid the sticky header/navigation, but a geometrically overlapping fixed div was not evaluated for visual obstruction; overall focus-obstruction acceptance remains PARTIAL. Participant Preview covers the unavailable boundary only. Full active-form mobile coverage remains PENDING. Touch target dimensions were not measured.

Complete 200% route interaction, complete field/status/landmark evaluation, active participant keyboard/mobile coverage, screen-reader evaluation and stakeholder UAT sign-off remain PENDING. The [evidence README](docs/accessibility-uat-evidence/2026-09-03/README.md) describes historical captures, accepted visible facts and reproducibility limits.
