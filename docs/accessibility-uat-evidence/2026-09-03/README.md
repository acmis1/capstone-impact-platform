# Local Accessibility/UAT correction evidence

Overall acceptance: **PARTIAL**. This directory contains current correction measurements and explicitly labelled historical captures. It is not a WCAG-compliance or project-wide UAT sign-off. Testing used synthetic Local data. The UI's “Staging” label is not a hosted-environment claim: the application connection was checked as loopback before browser work.

## Reproduce the publication gate

From the repository root, using the pinned Node/npm toolchain and installed dependencies:

```text
npm run verify:accessibility-uat-evidence
npm run --silent verify:accessibility-uat-evidence -- --manifest
npm run verify:accessibility-uat-evidence -- --committed
```

The first command scans the entire working evidence tree and the root checklist. The last reads all committed evidence and the checklist directly from HEAD. Neither command writes files or contacts services. The middle command emits the canonical PNG manifest; save its stdout to [screenshots-manifest.json](./screenshots-manifest.json) when captures change. It calculates dimensions, byte lengths, SHA-256 values and duplicate groups from file bytes. Do not hand-edit these measurements.

The verifier handles Markdown, JSON, HTML, text and UTF-8/UTF-16 logs. It checks token paths, signed URLs, credentials, session data and prohibited UUIDs, optionally checking the ignored local synthetic credential store without printing values. Failure output contains categories and locations only. It parses Lighthouse Accessibility data and checks local evidence references. Focused fixtures cover safe input, forbidden input without value disclosure, encoded paths, UTF-16, broken references and duplicate images.

The scanner does not prove screenshot meaning or detect secrets in pixels. All screenshots used for acceptance were opened visually. [screenshot-state-index.json](./screenshot-state-index.json) states the accepted visible facts. Context-only images are not interaction evidence. The duplicate Projects zoom captures show the same state and are not assigned incompatible claims. The pre-correction skip-link capture is a source JPEG, [skip-link-before.jpg](./screenshots/skip-link-before.jpg); the generated PNG manifest does not count it.

## Code and settled browser measurements

- The skip link now uses the existing foreground token on the background token. [skip-link-contrast.json](./skip-link-contrast.json) records 4.3788:1 before and 17.0629:1 after. Its 1px clipped hidden state is unchanged. Tab reveals it; Enter focuses main. [Focused skip link](./screenshots/skip-link-after.png).
- The valid layered anchor reset, primary-button hover correction, section-heading changes and MultiSelect ring are retained.
- [contrast-after.json](./contrast-after.json) records settled default, hover and keyboard-focus states of New import. White text on opaque primary red measures at least 4.5:1 in each state. Hover has the larger shadow. Keyboard focus uses a red box-shadow ring with a white offset; outline-style is none. [Focused primary button](./screenshots/contrast-after.png).
- [headings-after.json](./headings-after.json) is the retained heading inventory. A screenshot alone cannot prove semantic heading levels.

## Six rejected screenshot claims

| Rejected claim | Current disposition | Retained proof |
| --- | --- | --- |
| MultiSelect image showed navigation drawer | FIXED: visible Search disciplines input with focus ring; typing filters options; Escape restores trigger focus | [capture](./screenshots/multi-select-search-focus.png), [interaction record](./keyboard-interaction-evidence.json) |
| Import image showed only selected filename | FIXED: actual Check Failed alert is visible after Check spreadsheet | [capture](./screenshots/import-workflow-controlled-failure.png) |
| Project disclosure had no visible focus | FIXED: keyboard-expanded summary visibly has a red focus ring | [capture](./screenshots/project-detail-disclosure-focus.png) |
| Participant correction field had no validation message | PENDING: invalid capture removed. Local Generate participant preview returned Access denied; no authorization changes were made | [interaction record](./keyboard-interaction-evidence.json) |
| Long validation image showed a title | PENDING: invalid capture removed; no meaningfully long actual validation message was captured | [long-content record](./long-content-measurements.json) |
| Long summary image did not show summary | FIXED: actual 950-character synthetic summary is visible, with equal content scroll/client widths; original summary restored | [capture](./screenshots/long-content-summary.png), [measurements](./long-content-measurements.json) |

The accepted [Project Detail error](./screenshots/project-detail-controlled-failure.png) was inspected and retained. It visibly shows the error summary and required-title error. The historical [Preview Unavailable](./screenshots/participant-preview-controlled-failure.png) remains boundary evidence only. A long filename was selected in the new import-error capture, but the native file input elides it; long-filename wrapping remains PARTIAL. The accepted [long title](./screenshots/long-content-title.png) remains unchanged.

## Keyboard and responsive coverage

[keyboard-interaction-evidence.json](./keyboard-interaction-evidence.json) records all seven required route labels, roles, actual sequences, activation results, focus restoration and limitations. Six routes have partial interaction coverage; active Participant Preview remains pending. No complete-route PASS is inferred from an isolated focus screenshot. Staff invitations are paused; publication, repair and setup actions were not activated.

[mobile-measurements.json](./mobile-measurements.json) records the 375 x 812 CSS viewport, document/client widths and relevant sticky rectangles. Projects, Import and Project Detail have no page horizontal overflow and their sampled focused controls do not overlap the sticky header/navigation. A fixed full-viewport div overlaps geometrically; its visual obstruction was not separately resolved, so overall focus-obstruction acceptance remains PARTIAL. The Participant measurement covers the unavailable-preview boundary only, not an active form. No mobile touch-target size claim is made.

The retained native-zoom captures and [zoom context](./browser-zoom-200-context.json) are historical evidence. They do not prove a new complete 200% interaction pass. The retained [participant accessibility tree](./a11y-tree-participant-preview.json) and [project accessibility tree](./a11y-tree-project-detail.json) are sanitized historical inventories, not screen-reader testing.

## Before-state provenance

[before-evidence-provenance.json](./before-evidence-provenance.json) records actual git output for detached base 6125bb56a2c71c16a45cce44851696e8b09a3b4c, Local port 3101, capture time and produced files. [contrast-before.json](./contrast-before.json), [headings-before.json](./headings-before.json) and [base capture](./screenshots/contrast-before.png) were recaptured from that worktree. The temporary server and worktree were removed. No credentials were retained.

## Lighthouse report boundary

The retained [JSON](./lighthouse-admin.json) and [HTML](./lighthouse-admin.html) are the **historical** audit from 2026-09-03T13:17:09.774Z, not a fresh audit of the final skip-link correction. Fresh authenticated Local /admin Lighthouse acceptance remains **PENDING**. The available audit tool does not expose raw authenticated JSON/HTML export through the selected browser session; no replacement result is invented.

The actual historical report contains Accessibility only: score 100/100, color-contrast score 1, heading-order score 1, Lighthouse 13.4.1, mobile emulation 412 x 823, DPR 1.75, no run warnings and no runtimeError property. It contains no Best Practices, SEO or Agentic Browsing scores. A score of 100 is not WCAG compliance.

## Verification evidence

The raw final command outputs are retained in [typecheck](./verification/typecheck.log), [lint](./verification/lint.log), [build](./verification/build.log), [full Vitest](./verification/test-admin.log), [focused tests](./verification/focused-tests.log), [evidence gate](./verification/evidence-verifier.log) and [diff check](./verification/git-diff-check.log). See [verification results](./verification/results.json) for actual exits and totals. No success summary is appended to a failing log.

The full suite was started after the task's browser tabs and two dev servers were closed. Existing unrelated browser/process instances were left intact. Any failed canonical run remains a failed run even if the affected files pass in isolation. [skip-link-regression-before.log](./verification/skip-link-regression-before.log) retains the genuine failing pre-fix contrast regression.

### Actual verification outcomes

Typecheck and build exited 0. Lint exited 0 with 0 errors and 6 warnings. Final focused checks passed 7 files / 118 tests. The genuine final canonical suite exited 1: 1 failed, 284 passed, 1 skipped test files (286 total); 1 failed, 4332 passed, 14 skipped tests (4347 total). The migration baseline timed out at 5000ms. The four diagnostic files passed in isolation (102 tests).

The [clean-main raw run](./verification/test-main-comparison.log) also timed out in the migration-baseline comparison and a table-preference test; [provenance](./verification/main-comparison-provenance.json) records its base and conditions. This establishes that the migration timeout also occurs without this branch. It does not establish full-suite acceptance. No timeout values or unrelated tests were changed.

The [first canonical attempt](./verification/test-admin-attempt1.log) and [expanded focused attempt](./verification/focused-expanded-attempt.log) stalled and were interrupted. Their worker-exit errors are retained exactly and are not application failures or passing runs. The scoped Git attribute for this verification log directory preserves raw trailing whitespace and final blank lines without changing command output.
