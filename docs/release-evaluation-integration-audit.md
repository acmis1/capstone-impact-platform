# Binh release-evaluation integration audit

Date: 2026-09-03. Scope: independent review and local integration of PR #258, **Integrated 120-Project Release-Evaluation Harness and KPI Evidence**. This records Local evaluation acceptance, not release/merge approval.

## Final integrated machine closure — 2026-09-04

This section and the requirement matrix supersede the historical observations below for the final Binh machine pass. Base `origin/main` was fetched and exactly matched `5b99382bdb73724540c10f0d0a185442799c44cc`, including the integrated participant corrections and final Huy closure. Work used fresh branch `fix/binh-final-release-evidence` in an isolated worktree; the original dirty checkout was preserved. No PR or merge is authorized by this pass. Resolve the final source SHA from this document's commit; push identity is recorded in the handoff.

**F and G are PASS. KPI-01 remains NOT TESTED / PENDING HUMAN MEASUREMENT; overall release acceptance remains INCOMPLETE.**

Retained sanitized evidence (outside Git):

`C:/Users/Admin/.codex/visualizations/2026/09/04/01a06d01-75f6-7030-b767-8caf9d6b52dd/binh-final`

- `runtime-1/release-evaluation-run-1.json`, `release-evaluation-run-2.json` and the final JSON/Markdown report: two uninterrupted complete runs, both gates PASS; normalized comparison true with no mismatch fields. `runtime-2` contains the fresh single evidence-mode run, which resumed normally, exited zero and passed after browser capture.
- Each current run: 132 cases, 120 persisted, 12 deliberate rejects, zero unaccounted; critical 32/32, non-critical 20/20, controls 110/110, zero blocking false positives; **180/180 audit rows**, 20 candidates, zero verifier records in the ordinary published feed, no publication. The manifest digest is `5364547f4d39b0835a4d7b888a63558440450a30137e2ba8cd00e375a31264a2`.
- The difference from historical 185 audits/55 Approved is legitimate integrated behavior, not a relaxed gate: merge `b4f8f16` changed the five participant-correction cases to open requests before package submission, without starting resolution. Each retains two audits (submission and approval), stays Approved, and is excluded by `CORRECTION_UNRESOLVED`. Current final states are Approved 60, archived 10, changes requested 10, draft 20, submitted 20. The fixture and production observations agree; this pass changes neither.
- `independent-residue-after-two-runs.txt` and `independent-residue-after-browser.txt`: verifier projects, batches and Storage objects zero; all media remains at the four-row ordinary baseline, with four ordinary projects preserved. Evaluator reports independently cover all 13 owned residue scopes at zero and all six baseline checks true, including the forced-failure cleanup probe. `disposable-residue.json` confirms no owned containers, volumes, networks or temporary workdir after owner teardown.

### Independent timing

An optional server-only observer brackets the real synchronous `reconcilePackagesAgainstAdminReference` call within the same `analyzeBrowserImportServer` invocation. It starts after reference worksheet parsing and argument preparation, and ends before projecting results into previews. The observer receives only milliseconds; its clock/observer exceptions cannot alter output. Unused diagnostics read no clock and add no output fields. No HTTP, preview, fingerprint or commit contract changes; no replay or subtraction.

| Observation (milliseconds) | Uninterrupted run 1 | Uninterrupted run 2 |
| --- | ---: | ---: |
| `adminReconciliation` | 1.100 | 1.481 |
| `importAnalysis` / `packageParsingValidationAndReconciliation` (same combined value) | 388.457 | 302.022 |
| Total | 23259.683 | 16676.244 |

The child field sums actual accepted/rejected batch reconciliation calls, excluding later staging revalidation calls. Parent/child measurements overlap and must not be summed. Evidence-mode total includes its inspection pause and is excluded above. Runtime: Windows x64, Node 24.14.1, npm 11.11.0, pinned Supabase CLI 2.109.1, disposable PostgreSQL 17 and all 51 current migrations. These are Local observations, not a performance SLA or human effort.

### Authenticated annual-scale browser

`browser-complete.json` is the authoritative, uninterrupted browser record; `capture-browser.cjs` and `browser-capture.log` retain the sequence and assertions. A fresh isolated Chromium context attached console, page-error, failed-request and HTTP-response listeners before its first navigation to `http://127.0.0.1:3058/login`, then signed in through the real form with synthetic Local staff credentials. Credentials remained in the disposable provisioning file/in memory and were removed by owner teardown. No cookies, session values, headers, response bodies, preview/recovery tokens, signed Storage URLs or UUIDs are retained in browser evidence. The generic STAGING badge is application wording; the actual app and Supabase endpoints were loopback Local.

- Desktop 1440×1000: cohort search 120; page size 50; 50 selected; next page clears hidden selection; final 20 rows and disabled Next; Previous; sizes 25 and 10 reset to first page with disabled Previous; Approved 60; Approved + 2022 gives 12; compatible program/discipline keeps 12; incompatible program produces the explicit empty state; exact public-ID search yields one.
- Mobile 375×812: cohort 120, ten cards with intact title/ID/status/validation/program/discipline/year/group/partner/updated/detail data; selection and next-page clearing; Previous boundary; expanded filters, Approved/year/compatible taxonomy, final two-card filtered page and Next boundary, incompatible empty state and restored cohort. All 14 sampled mobile states have document/body width 375, matching the viewport.
- Console errors **0**; page errors **0**; failed requests **0**; HTTP responses >=400 **0**, including expected controlled errors **0**. Two Supabase SDK session-user advisories were retained as warnings, not suppressed or counted as errors. Source inspection confirms the Projects page calls `requireAdmin` first and authorizes using verified `getClaims()` plus the durable recovery gate; this pass does not alter Auth or claim a separate security audit.
- Ten retained screenshots: `final-desktop-50-selected.png`, `final-desktop-final-20.png`, `final-desktop-compatible.png`, `final-desktop-empty.png`, `final-desktop-exact-id.png`, `final-mobile-card.png`, `final-mobile-selected.png`, `final-mobile-filters.png`, `final-mobile-pagination.png`, `final-mobile-cohort.png`. Desktop selection and mobile card screenshots were also visually inspected.

The earlier `browser-runtime.json` is explicitly incomplete: its interactive automation runtime reset during mobile inspection. The complete fresh context above reran the entire sequence against the same intentionally paused cohort. No incomplete capture is used to establish G. The evaluator itself was never terminated while paused.

### Final verification and boundaries

| Command | Result |
| --- | --- |
| `npm ci --offline --no-audit --no-fund` | PASS; 691 packages, no dependency/lockfile change. |
| `npm run test:admin -- src/evaluation src/fixtures/releaseEvaluationCorpus.test.ts src/components/admin-dashboard/ProjectTableContainer.integration.test.tsx src/import/__tests__/browserImportAnalysisDiagnostics.test.ts src/import/__tests__/browserImportPreview.test.ts src/import/adminReferenceReconciliation.test.ts` | PASS, 182 tests / 7 files. |
| `npm run test:admin -- src/import/__tests__/browserImportAnalysisDiagnostics.test.ts` | PASS, five focused production-phase/order/output/unused/observer-failure tests. |
| `node --conditions=react-server --import tsx apps/admin-cms/src/scripts/verifyReleaseEvaluation.ts --output-dir=<evidence>/runtime-1` | PASS, default uninterrupted pair. This is the executable behind `npm run verify:release-evaluation`; the repository disposable owner passes matching Local configuration in memory. |
| Same evaluator with `--output-dir=<evidence>/runtime-2 --runs=1 --evidence` | PASS, normal resume/cleanup/exit after authenticated browser evidence. |
| `node <evidence>/capture-browser.cjs` | PASS, complete desktop/mobile workflow and runtime record. |
| `node --import tsx <evidence>/inspect-local.cjs after-two-runs` and `after-browser` | PASS, independent SQL residue/baseline checks. |
| `npm run typecheck:admin` | PASS. |
| `npm run lint --workspace=apps/admin-cms` | PASS, zero errors; six unchanged warnings. |
| `npm run build:admin` (telemetry disabled) | PASS; existing worktree-root/file-tracing warnings retained in `build.log`. |
| `git diff --check` | PASS. |

No full-suite or exact-head CI pass is claimed by this focused final run; historical full-suite observations below remain historical. The manual template now specifies comparable activities/counts, interruptions/exclusions and total-time reduction calculation, without human measurements or a >=50% claim. The release checklist remains unchecked/INCOMPLETE. No migration, schema, RLS, Auth, validation/reconciliation semantics or publication-authority changes; no hosted Supabase, Duda, publication endpoint, public promotion or removal. Hosted capacity/recovery, stakeholder UAT, production SLA, staff-effort reduction and institutional sign-off remain outside this pass.

## Historical source and integration (2026-09-03)

- Audited Binh head: `f004d39d9e4f5744018dd17efd9094afa77acb7f`.
- Current main used: `6cee51d5a7b4bbf9d6add26726347d0dcedaa699`; common base: `045cce114775c89ea83be59200532ce3641bc6e8`.
- Branch: `integration/binh-release-evaluation-audit`, in a clean dedicated worktree. Original dirty main checkout was preserved.
- Normal merge commit: `c712cca20b45446e7d3427516a19de67d9f284af`; Binh's commits/history retained. Initial correction: `b5fd6ed0c8ecc6c8cd996b7f78762044ec01eee6`. The subsequent independent-review correction is recorded below.
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
| F. Observational timing | PASS | Final integrated pass observes actual reconciliation within the same production analysis call; 1.100 / 1.481 ms. Combined parent timing retained; no SLA claim. |
| G. Annual-scale UI | PASS | Fresh complete authenticated desktop/mobile record on 120 projects: zero console/page errors, failed requests or HTTP >=400; two SDK advisories retained. See final section above. |
| H. Repeatability and cleanup | PASS | Independent review changed the original PASS to FAIL for orphaned Storage recovery. The correction below proves namespace-only recovery after DB deletion, all 13 residue scopes zero, ordinary data preservation, and two fresh uninterrupted evaluator runs without reset. |
| I. Human efficiency / KPI-01 | NOT TESTED | Timing instrument ready (preparation PASS); comparable real human measurements and >=50% reduction remain pending. |
| J. Reporting | PASS | JSON and Markdown share the evidence model; per-run JSON retained. Local gate, browser, CI and human acceptance distinguished. |

## Historical corpus coverage and observations

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

Cleanup after success and the injected failure reports zero projects, batches, metadata/media commits, media, taxonomy links, flags, audits, previews, confirmations, correction requests and private objects. Whole-row baseline fingerprints for ordinary data plus admin, taxonomy and publication/feed state match. Independent SQL after the passing pair and after the browser run found owned projects/batches/Storage objects 0, ordinary projects 4 and media 4, audits/flags/previews 0, and publication ledger/head 0. Disposable containers, volumes, networks and temporary workdirs are absent after teardown. These original live-run observations did not prove interrupted recovery after a Storage deletion failure; that defect and its subsequent correction are recorded below.

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

## Interrupted recovery correction after independent review

Date: 2026-09-03. This section records only the follow-up to the independent **CHANGES_REQUIRED** decision. Earlier successful-run metrics and review history above are retained. Starting HEAD was verified as `b5fd6ed0c8ecc6c8cd996b7f78762044ec01eee6` on `integration/binh-release-evaluation-audit`, with no tracked, staged or untracked worktree changes. Both the recorded main integration base and original Binh head were verified as ancestors. The separate dirty primary checkout was preserved.

**Root cause (P2):** the CLI recovery helper rebuilt `ownedPublicIds` exclusively from surviving project rows. Its Storage discovery and final residue count both depended on those IDs. If Storage removal failed but later database deletion succeeded, a fresh process found no projects, skipped the orphaned draft objects, and falsely reported zero Storage residue and completed cleanup. The earlier fix to continue later cleanup operations after an error was correct and remains intact; it made the missing durable Storage discovery observable.

**Correction:** recovery now lists private `drafts` folders directly, with stable name ordering and pagination. It accepts only the exact `release-<validated run namespace>-synthetic-YYYY-NNNN` folder shape, then combines those identities with surviving database identities. Discovery needs neither the prior process's ownership sets nor a seed value. Only the three existing private media directories are eligible. Unexpected folders, nested entries, invalid path segments, or failed enumeration prevent a success result; recovery leaves ambiguous entries untouched and refuses mutation if discovery is incomplete. Storage residue is enumerated again after deletion, independently of whether project rows remain. Both folder and object listings cover pages beyond 1,000 entries.

No application deletion semantics, public promotion, publication planning behavior, workflow, authorization/RLS, migrations, dependencies, or CLI argument contract changed. Live intended-identity/path tracking and non-short-circuit cleanup sequencing remain in place. No persistent cleanup registry was added.

### Regression and disposable Local evidence

The new regression first failed against unchanged `b5fd6ed0` production source: the post-recovery assertion found the owned Storage object still present. The fixture had already verified failed first cleanup and retry, zero owned project/media rows, and one actual Storage object. After the correction it passes using only the namespace in the recovery call, with every residue scope zero. Additional regressions cover continued removal failure (one reported object, incomplete), listing failure, ambiguous project/asset/nested paths, more than 1,000 folders and objects, and ordinary/similar-run objects left intact. All 24 harness tests and the 69-test focused group pass.

New evidence is retained outside Git at:

`C:/Users/Admin/.codex/visualizations/2026/09/03/01a06516-7e9f-7ce3-84b5-470ce3d0a1ef/binh-correction`

`local-recovery.cjs` uses the repository disposable-stack owner and cached Local images. Its bounded failure injection intercepts only removal of one exact verifier object at the client Storage boundary; all database operations and other Storage requests use the real disposable services. It does not simulate the database or the later CLI process.

| Observation | Actual result |
| --- | --- |
| First cleanup / live retry | Both incomplete; later DB deletions still executed. |
| Independent SQL after failure | Owned projects 0; actual owned Storage objects 1. |
| Fresh `--cleanup-run=<namespace>` process | Exit 0, complete; supplied only the durable namespace plus in-memory Local connection configuration. |
| Final Storage residue | API count 0 and independent SQL count 0. |
| All cleanup scopes | Projects, batches, metadata commits, media commits, media assets, discipline links, industry links, flags, approval records, previews, confirmations, correction requests, private Storage objects: all 0. |
| Ordinary state | Full-row fingerprints across 25 DB tables unchanged; both ordinary and similar-run Storage control bytes unchanged. |
| Two uninterrupted evaluations afterward | Both PASS, normalized repeatability comparable, both forced-failure probes and final cleanups complete; no reset. |
| Independent SQL after pair | Verifier projects 0; Storage excluding the two preserved controls 0; ordinary projects 4 and media rows 4. |
| Disposable teardown | Owned containers, volumes, networks absent; temporary workdir absent. Other Local stacks untouched. |

Retained artifacts: `reproduction.log`, `focused.log`, `local-recovery-evidence.json`, `cleanup-cli.log`, `local-runtime.log`, both per-run JSON files and final JSON/Markdown under `two-runs/`, `after-two-runs-sql.txt`, and `disposable-residue.json`. The initial probe stopped on a verification-only SQL table-name typo, before creating its verifier project; its stack was removed. That log is retained as `local-runtime-initial.log`; the probe was corrected to the existing `feed_rollback_preparations` table and rerun. No schema change was needed.

Both fresh evaluations retain exactly: cases 132; persisted 120; deliberate rejects 12; unaccounted 0; critical 32/32; non-critical 20/20; controls 110/110; blocking false positives 0; audit rows 185; publication candidates 20; ordinary published feed records 0. Manifest digest and final status counts match the earlier evidence. New total timings were 25,572.931 ms and 26,805.131 ms, including the additional cleanup enumeration and concurrent Local verification load; these do not replace the earlier observations or establish a performance target.

**Requirement reconciliation:** H changes from the independent review's FAIL to PASS on the new regression and real fresh-process Local recovery evidence. G remains PARTIAL because the previous browser workflow did not retain a complete authenticated console record; rebuilding that evidence setup was deferred for this narrow correction. F remains PARTIAL: the truthful combined parsing/validation/reconciliation timer is unchanged.

### Follow-up verification commands

Commands ran in the integration worktree. Evidence filenames below are relative to the new evidence directory. No hosted verification flags were used.

| Exact command | Result |
| --- | --- |
| `npm run test:run --workspace=apps/admin-cms -- src/evaluation/releaseEvaluationHarness.test.ts -t 'recovers orphaned Storage'` | Before source correction: one expected failure, orphan still present (`reproduction.log`). An initial fixture setup attempt lacked a mocked bucket config and was corrected before this reproduction. |
| `npm run test:run --workspace=apps/admin-cms -- src/evaluation/releaseEvaluationHarness.test.ts` | First implementation check: 18/18 passed, before adding the remaining six safety/pagination cases (`harness-first.log`). |
| `npm run test:admin -- src/evaluation src/fixtures/releaseEvaluationCorpus.test.ts src/components/admin-dashboard/ProjectTableContainer.integration.test.tsx` | 69/69 tests, four files passed (`focused.log`). Covers report, corpus, cleanup/forced failure and ProjectTableContainer. |
| `node --conditions=react-server --import tsx C:/Users/Admin/.codex/visualizations/2026/09/03/01a06516-7e9f-7ce3-84b5-470ce3d0a1ef/binh-correction/local-recovery.cjs` | Final probe exit 0; real recovery, both full evaluations, baseline preservation and teardown pass. Initial verification-script typo described above. |
| `node --conditions=react-server --import tsx apps/admin-cms/src/scripts/verifyReleaseEvaluation.ts --cleanup-run=<generated namespace>` | Actual exact argument retained in `cleanup-cli-command.json`; fresh process exit 0 and all residue scopes zero. CLI source/argument parsing unchanged. |
| `node --conditions=react-server --import tsx apps/admin-cms/src/scripts/verifyReleaseEvaluation.ts --output-dir=C:/Users/Admin/.codex/visualizations/2026/09/03/01a06516-7e9f-7ce3-84b5-470ce3d0a1ef/binh-correction/two-runs` | Default two uninterrupted runs, exit 0, both gates PASS (`two-runs.log`). |
| `npm run lint --workspace=apps/admin-cms` | Final PASS: zero errors, six unchanged warnings (`lint-final.log`). The earlier run found one new test warning, subsequently removed (`lint.log`). |
| `npm run lint --workspace=apps/admin-cms -- src/evaluation/releaseEvaluationHarness.ts src/evaluation/releaseEvaluationHarness.test.ts` | Final changed files: zero errors or warnings (`lint-changed.log`). |
| `npm run typecheck:admin` | PASS (`typecheck.log`). |
| `npm run build:admin` | Attempted with telemetry disabled and HTTP/HTTPS/ALL proxy set to closed loopback `http://127.0.0.1:9`. Build cannot fetch existing Geist/Geist Mono Google Fonts with external requests blocked (`build.log`). No product/font/config change made to bypass this restriction; the earlier build PASS is not represented as a fresh PASS. |
| `npm run test:admin` | 4,304 passed, 11 five-second timeouts, 14 skipped; three unhandled errors, including the explicitly terminated stalled worker. The browser test temporarily removes global Buffer; timeout stack formatting in Vite then failed on `Buffer.from`, leaving one worker stalled. Only this verified worktree worker was terminated after over five minutes without progress; total run 397.94 seconds (`test-admin.log`, `test-admin-termination.txt`). |
| `npm run test:run --workspace=apps/admin-cms -- src/components/imports/BrowserImportPreviewClient.browser.test.tsx --maxWorkers=1` | Isolated recheck also stalled; three unhandled errors, no completed test. Only its verified worker was terminated after more than three minutes; total 218.70 seconds (`browser-test-recheck.log`, `browser-recheck-termination.txt`). This unchanged browser unit test remains an unresolved verification gap. |
| `git diff --check` and `git diff --cached --check` | PASS; exact three-file correction scope reviewed. |

The eleven timed-out files were rechecked with unchanged limits using this exact command (254/254 passed, 27.34 seconds; `timeout-recheck.log`):

```powershell
npm run test:run --workspace=apps/admin-cms -- src/recovery/zeroCostRecovery.test.ts src/security/controlledPublicationMigration.test.ts src/security/controlledPublicRemovalMigration.test.ts src/security/participantPreviewCorrectionResolutionMigration.test.ts src/security/passwordRecoverySessionProvenanceMigration.test.ts src/security/postgres17MaintainPrivilegeAlignmentMigration.test.ts src/security/privateMediaApprovalGateMigration.test.ts src/security/transactionalImportBatchReviewSubmitMigration.test.ts src/security/transactionalMediaStageMigration.test.ts src/assistive-validation/__tests__/duplicateRanker.test.ts src/components/admin-dashboard/ProjectTableContainer.integration.test.tsx --maxWorkers=1
```

The final correction changes only this audit, `apps/admin-cms/src/evaluation/releaseEvaluationHarness.ts`, and `apps/admin-cms/src/evaluation/releaseEvaluationHarness.test.ts`. The existing integration commit is not amended. The final correction SHA is retained after commit in `correction-commit.json` beside the evidence and in the final handoff; resolve it from this document's commit with `git log -1 --format=%H -- docs/release-evaluation-integration-audit.md` (a commit cannot embed its own hash).

Remaining gaps are the fresh offline production build, one wholly green canonical full-suite run and the isolated unchanged browser unit test, the authenticated browser-console record, independent reconciliation timing, and the previously recorded human efficiency/hosted CI boundaries. No hosted Supabase, Duda, Render, Azure, private dashboard, or publish-cloud-feed access; no public Storage promotion or publication/removal; no migration/auth/RLS/production lifecycle changes; no push, PR creation, merge, or modification of main/Binh refs. All application service requests in this correction used disposable loopback Local endpoints.
