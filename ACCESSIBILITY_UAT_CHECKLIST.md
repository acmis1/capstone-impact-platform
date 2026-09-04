# Admin/CMS Accessibility and UAT checklist

Overall status: **PARTIAL (Final Huy machine-verifiable gaps pass within their stated Local scope; native screen readers and stakeholder UAT remain PENDING human verification)**.

Scope: Local Admin/CMS and Participant Preview with synthetic data on integrated PP1 (`acmis1/capstone-impact-platform` incorporating merged PR #262). Public showcase/Duda acceptance, stakeholder sign-off and hosted operations are outside this record. PASS applies only to the named tested fact. PARTIAL means some evidence exists; PENDING means the required interaction or evidence was not obtained.

## Automated regression gate

Current focused commands and actual outcomes are recorded in the [final Huy pass](docs/accessibility-uat-evidence/2026-09-04-final/README.md). The [earlier integrated verification](docs/accessibility-uat-evidence/2026-09-04/README.md) remains historical evidence for the broader commands below.

```text
npm run typecheck:admin
npm run lint --workspace=apps/admin-cms
npm run build:admin
npm run test:run --workspace=apps/admin-cms
npm run verify:accessibility-uat-evidence
git diff --check origin/main...HEAD
```

## Scoped acceptance facts

| Requirement | Status | Evidence and limitation |
| --- | --- | --- |
| Skip-link normal text contrast | PASS | [measured before/after](docs/accessibility-uat-evidence/2026-09-03/skip-link-contrast.json): 17.0629:1 after; Tab reveals (122x36 CSS px in [2026-09-04 target size analysis](docs/accessibility-uat-evidence/2026-09-04/admin-target-size-analysis.json)); Enter focuses main; hidden state unchanged |
| Primary-button default/hover/focus contrast | PASS | [settled computed states](docs/accessibility-uat-evidence/2026-09-03/contrast-after.json); keyboard indicator is a ring, not an outline |
| Projects semantic heading correction | PASS | [heading inventory](docs/accessibility-uat-evidence/2026-09-03/headings-after.json); historical base provenance retained |
| MultiSelect focus and Escape restoration | PASS | [visible search focus](docs/accessibility-uat-evidence/2026-09-03/screenshots/multi-select-search-focus.png), [interaction record](docs/accessibility-uat-evidence/2026-09-04/keyboard-interaction-evidence.json) |
| Project disclosure focus | PASS | [expanded focused summary](docs/accessibility-uat-evidence/2026-09-03/screenshots/project-detail-disclosure-focus.png); [project detail desktop keyboard](docs/accessibility-uat-evidence/2026-09-04/screenshots/project-detail-desktop-keyboard.png) |
| Import controlled error | PASS | [actual Check Failed alert](docs/accessibility-uat-evidence/2026-09-04/screenshots/import-workflow-controlled-failure.png); invalid spreadsheet upload triggers controlled Check Failed alert with visible recovery |
| Project required-title error | PASS | [accepted retained field error](docs/accessibility-uat-evidence/2026-09-03/screenshots/project-detail-controlled-failure.png) |
| Participant form validation | PASS | Validated on active preview for 2026-medical-drone; disclosure expanded via keyboard; native constraint validation was observed in the keyboard interaction record; the focused empty required textarea state, without the browser validation bubble, is retained in [participant-preview-validation-failure.png](docs/accessibility-uat-evidence/2026-09-04/screenshots/participant-preview-validation-failure.png). |
| Preview unavailable boundary | PASS | [retained visible boundary](docs/accessibility-uat-evidence/2026-09-03/screenshots/participant-preview-controlled-failure.png); boundary behavior verified alongside active preview |
| Long title wrapping | PASS | [accepted retained long title](docs/accessibility-uat-evidence/2026-09-03/screenshots/long-content-title.png) |
| Long summary visibility/reflow | PASS | [actual summary](docs/accessibility-uat-evidence/2026-09-03/screenshots/long-content-summary.png), [950-character measurements](docs/accessibility-uat-evidence/2026-09-03/long-content-measurements.json); original fixture restored |
| Long validation message | PASS — bounded | Existing 118-character invalid folder-ID error wraps at 375px in a named package issues region (client/scroll width 309). Results receive focus; issue disclosure exposes expanded state and control association with keyboard focus retained. [Final interaction record](docs/accessibility-uat-evidence/2026-09-04-final/keyboard-interactions.json). Validation text/contracts unchanged. |
| Long filename wrapping | PASS — inspected surfaces | Long reference workbook inspected successfully; native ellipsis retained. Package issue filenames, MediaFileInfo, accessibility review labels and PDF action retain complete text with safe wrapping at 375px after observed overflow fixes. [Final filename evidence](docs/accessibility-uat-evidence/2026-09-04-final/long-filename-surfaces.json). Existing filename limits unchanged. |
| Fresh final Lighthouse Accessibility | PASS | Authenticated Local /admin audited with synthetic Admin session using Lighthouse 13.4.1 (Accessibility score 100/100, color contrast 1, heading order 1, 0 warnings, 0 runtime errors) in [lighthouse-admin-final.json](docs/accessibility-uat-evidence/2026-09-04/lighthouse-admin-final.json) and [lighthouse-admin-final.html](docs/accessibility-uat-evidence/2026-09-04/lighthouse-admin-final.html). |
| Evidence integrity | PASS | Repository-native gate output; canonical PNG manifest in [2026-09-03/screenshots-manifest.json](docs/accessibility-uat-evidence/2026-09-03/screenshots-manifest.json) and [2026-09-04/screenshots-manifest.json](docs/accessibility-uat-evidence/2026-09-04/screenshots-manifest.json). Text scanning does not inspect pixels; accepted screenshots were reviewed visually in [screenshot-state-index.json](docs/accessibility-uat-evidence/2026-09-04/screenshot-state-index.json). |

## Route-level keyboard matrix

Import and deployment/history now reference the [final pass interaction record](docs/accessibility-uat-evidence/2026-09-04-final/keyboard-interactions.json). Other rows retain the [2026-09-04 sanitized interaction record](docs/accessibility-uat-evidence/2026-09-04/keyboard-interaction-evidence.json). Isolated screenshots do not establish full keyboard operation. The Projects, Login, Staff invitation, publishing, Participant Preview reading-order/validation, and Import mobile screenshots are context-only; interaction and DOM records support operational conclusions.

| Route | Status | Tested keyboard interactions & remaining scope |
| --- | --- | --- |
| Login | PASS — bounded | Recorded login/recovery-request sequence: Email -> Forgot password -> Password -> Sign in; Shift+Tab to recovery; Enter opens /auth/forgot-password; invalid email triggers aria-invalid alert; synthetic email triggers success alert; Back to sign in returns to /login; keyboard sign-in redirects to /admin. [login-keyboard-focus.png](docs/accessibility-uat-evidence/2026-09-04/screenshots/login-keyboard-focus.png). |
| Projects | PASS — bounded | Recorded keyboard interactions: Skip link focuses main; search filters and resets; Title and Status column headers sort table; multi-page Next/Previous navigation and boundary states were exercised against the 12-record Local dataset; Select current page selected all visible rows with focus retained; row checkboxes toggle; inline preflight opened and cancelled with focus successfully restored to triggering action button without dropping to body. [projects-index-desktop-keyboard.png](docs/accessibility-uat-evidence/2026-09-04/screenshots/projects-index-desktop-keyboard.png). |
| Import | PASS — Local app-owned stages 1–5 | School spreadsheet inspection/matching, project folder selection/clear, Check files/results/issues, confirmation/draft metadata save, and private media completion exercised through the real workflow. Forward/reverse keyboard traversal and focus after transitions verified; late media step passes 375x812 visibility/overflow/hit-test checks. Two synthetic imports cleaned exactly; no publication. [Final pass](docs/accessibility-uat-evidence/2026-09-04-final/README.md). Native chooser supplied programmatically only after keyboard activation. |
| Project Detail | PASS — integrated post-#262 sampled scope | Section navigation, poster disclosure expansion, MultiSelect and metadata controls exercised; merged PR #262 participant section verified; reflow verified at mobile 375x812 and 200% zoom. [project-detail-desktop-keyboard.png](docs/accessibility-uat-evidence/2026-09-04/screenshots/project-detail-desktop-keyboard.png). |
| Staff access | PASS | Account menu opened and dismissed with Escape restoring focus to trigger; Reviewer role checkbox toggled via Space; synthetic invitation safely submitted to local Mailpit loopback (STAFF_PROVISIONING_ENABLED enabled in local test environment, no real external emails sent). [staff-access-invitation-keyboard.png](docs/accessibility-uat-evidence/2026-09-04/screenshots/staff-access-invitation-keyboard.png). |
| Admin deployment/history | PASS — bounded non-consequential scope | Empty-history Choose project link and Technical setup details; disposable Local version links, Activity/Technical/Advanced publishing/Advanced rollback disclosures, preparation/incorrect acknowledgement, collapse/reopen and navigation away exercised with forward/reverse traversal. No filters/refresh/pagination/Cancel rendered for the two-row fixture. Setup/repair and publication/removal/rollback execution excluded. [Final pass and limitations](docs/accessibility-uat-evidence/2026-09-04-final/README.md). Disposable fixture residue zero; Duda not contacted. |
| Participant Preview | PASS — integrated post-#262 sampled scope | Legitimate active preview generated via local API with { sendEmail: false }; sampled keyboard traversal through evidence reading order, skip link, document link, confirm button, Request corrections disclosure toggle, and correction-comment textarea (native constraint validation observed on empty submit; PNG retains focused empty textarea, without the bubble); reverse Shift+Tab traversal confirms zero keyboard trap; preview cleanly revoked via DELETE API. [participant-preview-reading-order.png](docs/accessibility-uat-evidence/2026-09-04/screenshots/participant-preview-reading-order.png), [participant-preview-validation-failure.png](docs/accessibility-uat-evidence/2026-09-04/screenshots/participant-preview-validation-failure.png). |

The final pass adds six visually inspected screenshots and a passing repository evidence scan: [evidence integrity](docs/accessibility-uat-evidence/2026-09-04-final/README.md#evidence-integrity). Earlier raw evidence is preserved; the canonical aggregate PNG manifest only gains the six new entries.

## Responsive and assistive acceptance

[Machine-readable measurements](docs/accessibility-uat-evidence/2026-09-04/mobile-measurements.json) record all four routes at approximately 375 x 812 CSS px. Projects, Import, Project Detail and active Participant Preview are PASS for the sampled state. Recorded widths show no page-level horizontal overflow in the tested states. Sampled captured controls were visibly unobscured. The retained evidence does not establish a separate portal-wide computed-style/hit-test conclusion.

The final import media step and completion state also pass at 375x812: page width 375, visible keyboard focus, and an unobscured primary action confirmed by hit test. [Final interaction record](docs/accessibility-uat-evidence/2026-09-04-final/keyboard-interactions.json).

Target-size measurements: [admin-target-size-analysis.json](docs/accessibility-uat-evidence/2026-09-04/admin-target-size-analysis.json) records route-by-route analysis across Admin surfaces under WCAG 2.2 SC 2.5.8 Target Size (Minimum, Level AA). Displayed controls (e.g. skip link 122x36 CSS px) and effective clickable regions (e.g. `<label>` regions >=24x24px for checkboxes) are accurately evaluated, with geometric spacing circles evaluated without misapplying spacing exceptions to non-pointer elements. No blanket target-size compliance conclusion is made. WCAG 2.2 SC 2.5.5 Target Size (Enhanced) is Level AAA. No institutional target-size requirement beyond this retained evidence is established.

[Complete 200% host zoom interaction](docs/accessibility-uat-evidence/2026-09-04/browser-zoom-200-interaction.json) was executed using genuine Google Chrome browser host zoom preference (200%, `zoomLevelParam: 3.801784`, `dpr: 2`, `innerWidth: 632`, `visualViewport.scale: 1`). Controls were exercised via keyboard across Projects, Project Detail, and active Participant Preview, verifying single-column reflow, full visibility of focused elements, and zero horizontal page overflow.

### Screen-reader boundary checklist (PENDING human verification)
- [ ] NVDA / VoiceOver traversal of `/admin` projects table announcing column headers and row actions.
- [ ] VoiceOver on iOS or TalkBack on Android reading Participant Preview evidence figures, accessible text descriptions, and response controls in sequence.
- [ ] Screen reader announcement of disclosure state changes (`aria-expanded`) on Project Detail and Participant Preview.

### Stakeholder UAT script (PENDING human verification)
- [ ] Coordinator logs in, reviews `2026-medical-drone`, generates private participant preview, and copies link without exposing tokens in public channels.
- [ ] Participant accesses the preview link, reviews project media and accessible text, and submits a correction note or confirms project details.
- [ ] Admin verifies feedback received in CMS and resolves or updates record accordingly.
