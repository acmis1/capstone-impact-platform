# Binh release-evaluation integration audit

Date: 2026-09-03. Scope: independent review and local integration of PR #258, **Integrated 120-Project Release-Evaluation Harness and KPI Evidence**. This records Local evaluation acceptance, not release/merge approval.

## Source and integration

- Audited Binh head: `f004d39d9e4f5744018dd17efd9094afa77acb7f`.
- Current main used: `6cee51d5a7b4bbf9d6add26726347d0dcedaa699`; common base: `045cce114775c89ea83be59200532ce3641bc6e8`.
- Branch: `integration/binh-release-evaluation-audit`, in a clean dedicated worktree. Original dirty main checkout was preserved.
- Normal merge commit: `c712cca20b45446e7d3427516a19de67d9f284af`; Binh's commits/history retained. The correction commit containing this document is the local audit result.
- Reviewed the complete effective 16-file PR diff and current authorities. Main's later #259 recovery-portability changes have no conflicting file edits; their semantic boundaries were checked and their focused regressions rerun. No reconciliation-only source change was needed. Recovery contracts and migrations were unchanged.
- PR #258 remains open/unmerged, at the audited head. No integration push/new PR, teammate rewrite, or Tan/Huy branch integration.

## Requirement matrix

| Requirement | Result | Evidence and boundary |
| --- | --- | --- |
| A. Representative deterministic corpus | PASS | 132 cases; explicit profile, issue and lifecycle assignments below; existing synthetic workbook/package generator reused. |
| B. Independent expected manifest | PASS | Static profile expectations compared to production observations per import/readiness/review/planning/feed stage. Field-specific critical issues; missing evidence fails. |
| C. Real integrated Local workflows | PASS | Production import services/repositories, readiness, bounded bulk review, preview/correction, archive, audit and read-only publication planning. Existing correction authority exercised without redesign. |
| D. End-to-end accounting | PASS | All 132 cases classified, 120 persisted, 12 deliberate rejects, zero unexpected/unaccounted. Exact cohort identity checks and per-stage ledger. |
| E. Seeded issues and controls | PASS | Critical 32/32, non-critical 20/20, zero misses; all 110 controls observed, zero blocking false positives. |
| F. Observational timing | PARTIAL | Two complete uninterrupted runs and runtime context retained. Parsing/validation/reconciliation is one combined measurement; independent reconciliation time is not available. No SLA claim. |
| G. Annual-scale UI | PASS | Real authenticated Local browser at 1440x900 and 390x844; screenshots, search, filters, 10/25/50 pages, current-page selection, pagination and bounded-query inspection. |
| H. Repeatability and cleanup | PASS | Two consecutive complete runs without reset; forced failure after real media staging; 13 residue scopes zero; ordinary data fingerprints unchanged; independent SQL and disposable teardown. Evidence-mode exit fix separately rerun. |
| I. Efficiency preparation | PASS | Manual comparison template retained; matching stages present. Human/manual comparison and >=50% reduction remain NOT TESTED. |
| J. Reporting | PASS | JSON and Markdown share the evidence model; per-run JSON retained. Local gate, browser, CI and human acceptance distinguished. |

## Corpus coverage

Case numbers refer to `release-case-NNN` in `releaseEvaluationCorpus.ts`. The default seed is 3557236774. The corrected manifest digest observed in the passing pair is `87ecb079dcafbe508a4d335ebc94d4af5a606873c4644e48021c71633ca2f571`.

| Cases | Deliberate package coverage |
| --- | --- |
| 001-055 | Valid workbook, one gallery image |
| 056-080 | Three gallery images |
| 081-090 | Maximum supported gallery boundary: ten images |
| 091-100 | Zero optional gallery images, non-blocking warning |
| 101-110 | Duplicate team-member workbook warning, one gallery image |
| 111-120 | Legacy JSON missing both poster full text and accessibility text; persists but review blocked; zero gallery |
| 121-124 | Missing title; invalid year; Admin field mismatch; no Admin reference match |
| 125-127 | Unknown database taxonomy; missing poster image; missing poster PDF |
| 128-130 | Missing gallery alt; oversized gallery alt; duplicate gallery position |
| 131-132 | Malformed XLSX rejected before persistence; repeated identity of case 001 rejected by authoritative metadata staging |

Lifecycle assignments independently cover: 001-010 eligible draft/preflight only; 011-020 already submitted; 021-030 stale approval; 031-040 already approved; 041-085 successful approval; 086-095 staff request changes; 096-100 participant correction; 101-110 archive; 111-120 accessibility-blocked drafts. Cases 041-060 have confirmed previews (20 candidate plans); 061-070 unconfirmed previews; 071-085 no preview. Together with 031-040, 25 approved cases lack active previews. Accepted gallery distribution is zero 20 / one 65 / multiple 25 / maximum 10.

## Findings and corrections

Locations below refer to the original Binh head. Confidence is **high** throughout: direct source evidence plus focused reproduction or Local runtime. No underlying production defect was established; corrections target evaluation, test and report behavior. No validators, permissions, lifecycle rules or participant correction product behavior were relaxed.

| Severity / location | Concrete failure and contract | Disposition |
| --- | --- | --- |
| P1: `ProjectTableContainer.integration.test.tsx:364` | Missing test closure causes parser failure at 500:0. Exact-head CI run 33663595496 failed static gates on all three OS matrices. The PR body's ESLint-pass claim is stale. | Restored closure; additionally scoped the new 50-checkbox test to the desktop table, since jsdom includes both responsive renderings. |
| P1: `releaseEvaluationHarness.ts:884` | Guard checks a separate API string while staging uses a cached environment-derived client; mismatched clients could contact a hosted target. | Strict HTTP(S) loopback/origin checks on supplied, configured and cached production clients before queries; verify private draft bucket. Adversarial URL/mismatch tests. |
| P1: `releaseEvaluationHarness.ts:803` | `cleanupFailed ||= await delete` skips subsequent deletes after an error. Post-RPC ownership tracking can miss committed writes when responses are lost. | Always execute scoped deletes; require an initially empty namespace; own intended IDs before writes; discover matching batches/previews; reject unrelated storage paths; retain cleanup failures and unchanged-data checks. Injected-error regression and real forced-failure probe. |
| P1: `releaseEvaluationReport.ts:301` | Both independent accessibility issues match the same generic blocker, allowing one observed issue to count as two critical detections. | Field-specific manifest expectations and independent production readiness reasons; expected detection flags no longer dictate actual results. Regression proves one reason detects one issue. |
| P1: `releaseEvaluationReport.ts:261`, harness `:1051` | Final persistence alone can pass accounting; intermediate/readiness/bulk outcomes are not enforced, and only expected candidate inclusions are planned. | Compare every declared stage/attempt and exact bulk identity set; plan all 120, including 100 exclusions; compare ordinary-feed exclusion per case. |
| P2: `releaseEvaluationReport.ts:351` | Unobserved controls look like zero false positives; supplemental controls inflate primary stage input counts. | Require observed controls and fail missing evidence; separate primary counts from controls/reasons. Two failing probes corrected. |
| P2: `releaseEvaluationHarness.ts:391` | Same analysis duration reported as separate parsing and reconciliation; readiness timing includes most of the run. | Truthful combined analysis label; separately time real readiness. Independent reconciliation timing remains PARTIAL. |
| P2: `verifyReleaseEvaluation.ts:157` | Evidence mode writes a successful report and cleans data but keeps stdin flowing, preventing CLI exit and owner teardown. | Pause and unref stdin on resume and handle EOF; the Windows pipe probe shows pause alone still keeps Node alive. A disposable evidence-mode rerun verifies normal exit. |

Additional reporting corrections retain each run's JSON, propagate any run failure, remove unconditional two-run claims, label the gate as Local-only, and keep browser acceptance separate. The first stricter Local run exposed ten legacy warning expectation mismatches: production correctly returns `RECOMMENDED_FIELD_MISSING` for `accessibilityText`. The manifest was corrected against `validateImportPackage` recommendations; product validation was unchanged. That failed report is retained, not substituted for passing evidence.

## Observed Local accounting

The uninterrupted passing pair agrees after removing generated IDs/timestamps/timings. Each run observes:

- Inputs 132; parser accepted 118 / warning 10 / rejected 4.
- Package validation accepted 101 / warning 23 / rejected 4 / not run 4.
- Administrative reconciliation accepted 122 / rejected 2 / not run 8.
- Commit intent and server revalidation accepted 122 each; metadata staging accepted 120 / rejected 2; media and final persistence accepted 120. Remaining cases explicitly not run.
- Initial readiness accepted 90 / warning 20 / blocked 10.
- Main submit preflight: selected 120, eligible 90, blocked 20, already complete 10; execution 80/80 successful.
- Main approval preflight: selected 80, eligible 70, already complete 10; execution selected 60, successful 50, stale 10. All ten stale cases remain submitted.
- Request changes 10/10 and archive 10/10 successful. Setup and participant-correction transitions are separately retained in workflow evidence.
- Final states: approved 55; archived 10; changes requested 15; draft 20; submitted 20.
- Audit rows 185/185; exact transition/comment signatures and actor attribution match; duplicate audits 0.
- Publication readiness: READY 20, PREVIEW_NOT_CONFIRMED 10, NO_ACTIVE_PREVIEW 25, CORRECTION_UNRESOLVED 5, INVALID_PROJECT_STATE 60.
- Read-only planning: READY_TO_STAGE 20, NOT_READY 100. Ordinary published-only feed: 0 verifier records, valid. No publication performed.
- Issues: 32 critical + 20 non-critical = 52 detected / 52 seeded (100%); zero missed. Controls 110 observed / 110 declared; zero blocking false positives. Unexpected/unaccounted 0.

Cleanup after success and the injected failure reports zero projects, batches, metadata/media commits, media, taxonomy links, flags, audits, previews, confirmations, correction requests and private objects. Whole-row baseline fingerprints for ordinary data plus admin, taxonomy and publication/feed state match. Independent SQL after the passing pair and after the browser run found owned projects/batches/Storage objects 0, ordinary projects 4 and media 4, audits/flags/previews 0, and publication ledger/head 0. Disposable containers, volumes, networks and temporary workdirs are absent after teardown. A hard kill/power loss still requires the documented namespace-scoped recovery path.

## Retained evidence and browser result

Evidence directory (outside Git):

`C:/Users/Admin/.codex/visualizations/2026/09/03/01a064cb-25aa-7e11-aba7-c0ab4151f197/binh-audit`

- `runtime-1`: failed intermediate pair and the legacy warning mismatch investigation.
- `runtime-2`: passing uninterrupted two-run JSON/Markdown, individual JSON reports and command log; forced-failure cleanup and normalized comparison included.
- `runtime-3`: passing evidence report with live browser cohort. The original stdin hang required terminating only the finished evaluator after independent zero-residue checks; this is not claimed as a clean CLI exit.
- `stdin-exit-check`: disposable evidence reruns; runtime-1 confirmed pause alone is insufficient on a Windows pipe, runtime-2 verifies the final pause/unref correction, plus owner teardown evidence. `stdin-probe.cjs` retains the minimal process-lifecycle reproduction.
- `browser-evidence.json`, `desktop-50-selected.png`, `mobile-10-selected.png`, `mobile-project-card.png`, `mobile-filters.png`.
- `independent-residue-after-two-runs.txt`, `independent-residue-after-browser.txt`, `disposable-residue.json` and retained verification logs.

The browser used real synthetic Local staff login at loopback. The generic application badge says Staging; the actual configured client/stack was disposable Local. Search `release-run-` yielded exactly 120; overall summary 124 includes four preserved seed projects. Desktop 50-row selection checked exactly 50 rows, page two cleared selection, final page contained 20; 25/10 page sizes reset to page one. Approved filter yielded 55, approved + year 2022 yielded 11, compatible program/discipline filters retained 11, incompatible program yielded the proper empty state, exact public ID search yielded one. Mobile selection showed 10 selected (ten row checkboxes plus page checkbox), page two cleared selection, filters expanded and cards fit the viewport without horizontal overflow.

Source inspection: `app/admin/page.tsx:70` calls paged records, count-only summaries and facet options. `SupabaseProjectRepositoryCore.ts:359` ranges full project rows with the 50-row cap. Filter options deliberately scan only year/program/discipline in 500-row chunks, with a maximum-iteration guard; they currently visit all 124 metadata rows. This is not proof of constant-cost queries at arbitrary scale. No 120-record full project list is sent for a ten-row page.

Runtime context: Windows x64, Node 24.14.1, npm 11.11.0, pinned Supabase CLI 2.109.1, disposable PostgreSQL 17, 48 repository migrations. Exact host CPU/OS context and millisecond observations are retained outside Git. The two uninterrupted totals were approximately 16 seconds each; values are observations only, not permanent performance targets. Evidence-mode totals include the manual inspection pause and are excluded from the comparison.

## Verification commands and outcomes

All commands ran in the integration worktree; no hosted inspection flags were supplied. Log names below are relative to the evidence directory.

| Command | Actual result |
| --- | --- |
| `npm ci --offline --no-audit --no-fund` | 691 packages installed; lockfile/dependencies unchanged. |
| `npm run lint --workspace=apps/admin-cms -- src/components/admin-dashboard/ProjectTableContainer.integration.test.tsx` before correction | Reproduced original parser error at 500:0. |
| `npm run test:admin -- --reporter=dot src/evaluation/releaseEvaluationReport.test.ts` before correction | Four new evidence probes failed as expected; npm did not forward reporter option. Retained reproduction log. |
| `npm run test:admin -- src/evaluation src/fixtures/releaseEvaluationCorpus.test.ts src/components/admin-dashboard/ProjectTableContainer.integration.test.tsx` | 62 tests / 4 files passed after correction. |
| `npm run test:admin -- src/fixtures/syntheticImportPackages.test.ts src/projects/bulkProjectReview.test.ts src/projects/bulkProjectReviewService.test.ts src/projects/publicationPlanService.test.ts src/projects/publicationArtifact.test.ts src/feed/compilePublicFeed.test.ts src/feed/validatePublicFeed.test.ts src/recovery/gate4RecoveryPortability.test.ts src/recovery/disposableSupabaseStack.test.ts` | 245 tests / 9 files passed. |
| `node --conditions=react-server --import tsx apps/admin-cms/src/scripts/verifyReleaseEvaluation.ts --output-dir=<outside-Git evidence directory>` | Production script behind `npm run verify:release-evaluation`; disposable owner passes matching Local environment in memory. Passing pair: both gates PASS, repeated without reset. |
| Same executable with `--runs=1 --evidence` | Real browser cohort captured, report PASS; fresh corrected run verifies stdin exit. |
| `node --import tsx <evidence>/inspect-local.cjs after-two-runs` and `after-browser` | Independent SQL residue checks passed. |
| `npm run test:admin` | 4303 passed / 6 timed out / 14 skipped, 285 files. All failures were 5-second Git-based migration byte comparisons. |
| `npm run test:run --workspace=apps/admin-cms -- --maxWorkers=2` | 4307 passed / 2 timed out / 14 skipped. Original six failures passed; two different migration comparisons timed out. |
| `npm run test:run --workspace=apps/admin-cms -- src/security/accessibleFullTextGateMigration.test.ts src/security/passwordRecoverySessionProvenanceMigration.test.ts --maxWorkers=1` | Both remaining files passed, 29 tests, unchanged 5-second limit. |
| `git diff origin/main -- apps/admin-cms/src/security/*Migration.test.ts infra/supabase/migrations` | Empty: migration tests and bytes are unchanged from current main. Timeout evidence indicates host/process contention; no test assertions or limits changed. Full suite is not described as one wholly green run. |
| `npm run lint --workspace=apps/admin-cms` | PASS, zero errors and six warnings in unchanged files. |
| `npm run typecheck:admin` | PASS. |
| `npm run build:admin` | PASS production build. |
| `npm run check:feed`, `npm run check:terminology`, `npm run check:yaml`, `npm run check:markdown-links`, `npm run check:onboarding-docs`, `npm run check:zero-cost`, `npm run check:managed-schema-recovery-inventory` | All passed. Managed inventory 48 migrations, auth customizations 2/2, Storage customizations 0/0. |
| `npm run check:operational-readiness` | REPOSITORY_READY_HOSTED_CHECK_NOT_RUN; hosted smoke NOT_RUN, mutations NONE. |
| `git diff --check` and final staged diff review | Passed; only the ten listed evaluation/test/documentation files changed beyond the normal integration merge. |

Exact-head GitHub run 33663595496 is FAILED for original Binh head. Log-download API returned 403; local parser reproduction independently supports the known defect. Final local integration has no GitHub CI run because no push is authorized. All required exact-head CI must pass if publication is later authorized.

## PR traceability and changed files

GitHub review POST returned **HTTP 401 Requires authentication**. No review/comment/approval was posted. Exact proposed inline comments, including severity, original commit, paths, line numbers and full text, are retained in `proposed-pr-review.json` in the evidence directory; its findings match the table above. This is a prepared COMMENT review, not an approval.

Corrections beyond Binh's integrated work touch only:

- `apps/admin-cms/src/components/admin-dashboard/ProjectTableContainer.integration.test.tsx`
- `apps/admin-cms/src/evaluation/releaseEvaluationHarness.ts` and `.test.ts`
- `apps/admin-cms/src/evaluation/releaseEvaluationReport.ts` and `.test.ts`
- `apps/admin-cms/src/fixtures/releaseEvaluationCorpus.ts`
- `apps/admin-cms/src/scripts/verifyReleaseEvaluation.ts`
- `docs/release-evaluation-harness.md`, `docs/m6-release-acceptance-checklist.md` and this audit.

Remaining limits: independent reconciliation timing; no single wholly green default full-suite run on this host; GitHub authentication for posting review; no final-head CI; no comparable human efficiency measurements. Browser evidence is a representative Local smoke, not institutional UAT or comprehensive accessibility certification. Candidate planning does not prove 100+ published projects, Duda integration, production capacity, Render limits, hosted recovery or stakeholder acceptance. Content-correction ownership was observed through current authority, not redesigned.

**Hosted application/infrastructure contacts/mutations: NONE.** GitHub source/CI metadata was read and the authorized review submission failed authentication. No hosted Supabase, Render, Azure, Duda or publish-cloud-feed call; no public promotion/removal, publication ledger mutation, production load test, teammate branch rewrite, push or merge.
