# Final Huy machine-verifiable Accessibility/UAT pass

Base: `e57604f48ef0b65945260901804f4752e22c94fc` (integrated PP1). Branch: `fix/huy-final-machine-uat-gaps`.

The final pre-commit fetch observed main at `a167d006f66fdaeb31e9e5cae5e48b3db651bf05` (PR #263). Its delta adds staging migration upgrade verification, operational documentation and recovery-inventory diagnostics. It changes none of the import/history/media UI, services or migration bytes exercised here. The branch retains the original verified base; no rebase or main update was performed. Relevant-code inspection found no reason to trigger the requested rebase stop condition.

The remaining machine-verifiable import, safe history, long filename and long validation cases are PASS within the scope below. Overall acceptance remains PARTIAL: native NVDA/VoiceOver/TalkBack and stakeholder UAT are PENDING. This is neither WCAG certification nor public showcase/Duda acceptance. Other route conclusions remain the retained [September 4 evidence](../2026-09-04/README.md), not new audits in this pass.

## Browser method and import acceptance

An isolated installed Chrome browser used Local synthetic staff authentication at `http://localhost:3104`. Playwright drove Tab, Shift+Tab, Enter, Space and Escape on the actual application. Native file inputs received files programmatically only after keyboard activation; OS chooser accessibility is outside this evidence. Browser requests to non-loopback origins and consequential deployment endpoints were blocked. Local credentials were loaded in memory, never retained here.

The repository's `createSyntheticWorkbookBuffer` generator supplied the project workbook. A real School reference workbook used supported group/title/program columns. The unique project folder was `huy-final-machine-20260904-keyboard`, with a workbook, PNG poster, PNG snapshot and PDF. Existing inspection, preview, confirmation, metadata and media services handled the files; there was no import bypass.

| Stage | Actual result |
| --- | --- |
| 1. School spreadsheet | Guide Enter/Space expansion/collapse, reference file activation, controlled invalid workbook alert, successful inspection, worksheet select, column matching disclosure and automatic matching confirmation. Failed inspection restores Check spreadsheet; success focuses Worksheet, then confirmed matching focuses Choose project folder. |
| 2. Project folder | Directory selection, change selection and Clear selection exercised. Clear selection restores Choose project folder; a final production-build browser check also verifies reverse/forward traversal at 375px. |
| 3. Check files | Valid package results and legitimate invalid packages exercised; result heading receives focus. Show/Hide issues supports Enter/Space, exposes expanded state and controls a named issues region. Package selection toggled off/on with Space. |
| 4. Confirm & save | Confirm selected projects advances focus to Import selected project details; saving creates one draft and advances focus to Import media and finish. Reverse traversal returns to earlier controls. |
| 5. Import media | Three private media objects imported through the normal service; completion focuses Open import details. Shift+Tab leaves and Tab returns without a trap. No review submission, preview creation or publication was needed. |

At 375x812, the late media action and completion link are visible, page width remains 375px, and a center-point hit test confirms the media action is unobscured and usable. Desktop traversal used 1440x1000. Focus measurements record rings/outline, viewport geometry and active control names, rather than relying on screenshots alone.

The [interaction record](keyboard-interactions.json) distinguishes pre-fix unchanged guide/mapping interactions from corrected transitions and final workflow. [Before measurements](defects-before.json) preserve the actual defects. Two completed browser imports (before and after fixes), each with one draft and three private objects, were deleted exactly.

## Safe deployment/history acceptance

**PASS — bounded non-consequential scope.** The canonical Local empty-history route exposed Choose a project to publish, Advanced publishing details and Technical setup details. A separate disposable Local stack then rendered two real database-backed history rows. Keyboard checks covered both version links, Activity details, Technical details, Advanced publishing details, Advanced rollback tools, safe preparation, acknowledgement input, collapse/reopen and navigation away.

The fixture reused the repository's safe Supabase Docker loopback proxy, Local staff provisioner and `cleanupDisposableLedgerRuntime`, following `runDisposableLedgerRuntime` setup with unchanged copied migrations. A unique disposable ledger stack on ports 55320–55327 held three synthetic staff/Auth users, two empty immutable version rows and completed fixture operation rows. The second row represented rollback history as a database fixture; **no rollback service was executed**. An isolated Storage path contained only the empty array artifact. No real project or canonical feed was published or overwritten, and no DOM state was fabricated.

The only deployment action request in the final browser history trace was `POST /api/public-feed/rollback/prepare`. Preparation makes no public write. It now focuses the acknowledgement input. An intentionally incorrect acknowledgement kept Execute prepared Local rollback disabled. Reverse traversal reached Prepare rollback; forward traversal returned to the input. Escape left focus in that input: this is a native details disclosure, not an Escape-dismissed dialog. Space closed and Enter reopened the disclosure with focus on its summary. Navigating to another version discarded the client preparation.

No Cancel button, filters, refresh or pagination were rendered for the two-row fixture. Repair showcase status and initial setup are consequential actions and were not activated. The first version navigation reset focus to body as an ordinary route transition; this evidence does not claim universal route-navigation focus restoration. Subsequent traversal reached all named safe controls without a trap.

Publication executed: **NO**. Removal executed: **NO**. Rollback executed: **NO**. Duda contacted: **NO**. The full ledger runtime verifier was not run because it executes publication/rollback scenarios outside the explicit task boundary. Its Local setup/cleanup utilities were reused for this bounded browser fixture; no full ledger-runtime acceptance is claimed.

## Long content and defects

| Defect / requirement | Root cause and minimal fix | Regression and browser result |
| --- | --- | --- |
| Async import focus | Disabled or unmounted controls dropped focus to body after inspection, matching, checking, preparation, metadata and media transitions. AdminReferenceDatasetSection and BrowserImportPreviewClient now focus the next result/action or retry control after state commits, respecting focus moved to another control. Clear selection restores its surviving folder button. | Import component tests cover the full focus chain, inspection failure/retry and no focus stealing, clear selection and disclosure semantics. Real browser rerun covers all five stages and both traversal directions. |
| History preparation focus | Disabling Prepare rollback dropped focus to body. PublicFeedHistoryControls now focuses acknowledgement on success or Prepare on failure, respecting another focused control. | History tests cover success, disabled execution, only the prepare request, failure/retry and no focus stealing. Browser re-preparation focuses the visible acknowledgement input. |
| Package issue semantics / filename overflow | Issue toggle lacked expanded/control association; unbroken filenames overflowed the package issue text. BrowserImportPreviewClient adds a named controlled region and filename wrapping without changing validation messages or contracts. | Disclosure regression and genuine invalid package browser checks. Before: page width 476 at 375px. After: page width 375; issue region client/scroll width both 309. Complete 80-character unsupported filename is retained. |
| Media filename overflow | MediaFileInfo already wrapped, but MediaAccessibilityReview's filename label and PdfMediaPreview's inline link did not. Filename spans now break long tokens; the PDF action is constrained and its text can shrink. | Media regressions retain complete action name/file facts. A verifier-owned imported draft's three media display filenames were temporarily set to long synthetic names; Storage paths/bytes were unchanged. Before: page width 703 at 375px. After: page width 375, all three file facts client/scroll width 283, and the focused PDF action wraps visibly. |

**Long filename: PASS for the inspected surfaces.** This covers reference selection, import package issues, MediaFileInfo, accessibility review labels and the PDF action. Native input ellipsis remains intentional browser behavior; the long reference workbook was successfully inspected. A filename exceeding the existing 100-character package contract was rejected normally; no limit was bypassed. [Filename measurements](long-filename-surfaces.json) retain complete synthetic names and geometry.

**Long validation: PASS for a legitimate existing error.** The folder `huy_final_machine_long_validation` produces the unchanged 118-character message: “Folder-derived public ID is invalid. Public ID must contain only lowercase alphanumeric characters and single hyphens.” At 375px it wraps in the named package issues region (client/scroll width 309, height 89). Validation results receive focus, then keyboard activation of the associated expanded disclosure retains visible focus. No artificial verbose error was introduced. [Interaction measurements](keyboard-interactions.json) and [validation capture](screenshots/import-long-validation-mobile.png) support this bounded result.

## Cleanup and safety

[Cleanup evidence](cleanup.json) confirms canonical Local baseline counts and complete-row hashes match across all 14 inspected tables after both native import verifiers finished. This includes projects, import batches, media, import commits, review response state, staff and deployment history. Remaining verifier-owned private Storage objects: **0**. The final read-only assertion deleted zero records because earlier exact cleanup had already removed the browser imports. Canonical staff/Auth and Participant Preview fixtures were not created by this pass.

The disposable history cleanup reports no containers, volumes, network or work directory. Its synthetic staff/Auth, history/preparation records and empty Storage fixture therefore leave zero residue; its temporary credential file was removed. Two earlier attempts hit Windows reserved ports and were cleaned before the working port range was used. Baseline Local fixtures were preserved; the canonical project was never reset.

No participant ownership, permissions/Auth implementation, schema, migrations, RLS, validation contracts, publication authority or Duda integration changed. No hosted Supabase, external email, public removal, real rollback or `/api/publish-cloud-feed` call occurred.

## Verification

| Exact command | Result |
| --- | --- |
| `npm run test:run --workspace=apps/admin-cms -- src/components/imports/__tests__/BrowserImportPreviewClient.test.tsx src/components/imports/BrowserImportPreviewClient.browser.test.tsx` | PASS: 29 tests / 2 files |
| `npm run test:run --workspace=apps/admin-cms -- src/components/admin-media/PdfMediaPreview.test.tsx src/components/admin-media/MediaAccessibilityReview.test.tsx src/components/admin-media/MediaPreview.test.tsx` | PASS: 17 tests / 3 files |
| `npm run test:run --workspace=apps/admin-cms -- src/components/admin/PublicFeedHistoryControls.test.tsx` | PASS: 13 tests / 1 file |
| `npm run verify:browser-metadata-stage-runtime` | PASS: all named scenarios, including rollback boundaries internal to import staging; [sanitized output](verify-browser-metadata-stage-runtime.log). This is import transaction cleanup, not public deployment rollback. |
| `npm run verify:browser-media-stage-runtime` | PASS: all eight named scenarios; [sanitized output](verify-browser-media-stage-runtime.log) |
| `npm run typecheck:admin` | PASS |
| `npm run lint --workspace=apps/admin-cms` | PASS: zero errors, six pre-existing warnings in untouched files |
| `npm run build:admin` | PASS: canonical Next 16.2.6 Turbopack production build |
| `npm run verify:accessibility-uat-evidence` | PASS: no findings, 54 PNGs / 54 unique hashes |
| `git diff --check` | PASS |

Node 24.14.1 / npm 11.11.0 and installed dependency versions match the lockfile. The full test suite was not rerun; focused tests cover each changed source area. An initial typecheck encountered extra page-export checks in generated webpack development types. Removing only this pass's generated development output and running the canonical production build/typecheck passed without changing the unchanged page exports or build configuration. The build warns about multiple worktree lockfiles; lint's existing warnings are outside these changes.

## Evidence integrity

Six new screenshots were opened and visually inspected individually. No sensitive values were observed. [Screenshot state index](screenshot-state-index.json) records each capture's scope. The long-filename issue crop is context-only because a development indicator overlaps its lower-left edge; JSON establishes full text and geometry. The PDF capture retains the complete action/filename, with the indicator overlapping only the lower-left MIME-label margin. Other captures support only their named state; operational conclusions use the interaction trace.

Historical screenshots and raw interaction records were not overwritten. The repository verifier hardcodes the September 3 manifest as the aggregate inventory for every dated directory; [that aggregate](../2026-09-03/screenshots-manifest.json) only gains these six PNG entries, with every previous entry unchanged. No token, signed Storage URL, JWT, authorization value, cookie, password, environment content or prohibited private identifier is retained in new evidence. Text scanning cannot inspect pixels; visual inspection is a separate check.
