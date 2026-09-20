# Closure Audit Disposition Register

**STATUS:** Current — maintained alongside the [release and closure status record](release-closure-status.md)
**PURPOSE:** Operations and handover
**LAST VERIFIED:** 2026-09-21

The 2026-09-20 independent closure audit of `main` at `5c88a6c1ff9a435cb1d4299d617543465175afa1`
raised the findings below. Each has exactly one disposition:

- **FIXED** — corrected and verified to the evidence boundary stated for that finding;
- **VERIFIED NON-APPLICABLE** — inspected against the actual code path and found not to apply;
- **DEFERRED WITH REASON** — a real item that is deliberately not changed in the closure candidate;
- **EXTERNALLY PENDING** — needs an action by the School or another institution;
- **UNVERIFIED** — could not be proven either way with the available evidence.

"Proposed for acceptance" is not acceptance. Nothing here records a risk as accepted by the
School, and no institutional owner is named.

## Findings

| ID | Finding | Disposition | Evidence / reason |
| --- | --- | --- | --- |
| F-01 | Repository docs described `95fe…`/58 or `79fe…`/61 as the current release while staging ran `9690…`/62 | **FIXED** | Single record created: [release-closure-status.md](release-closure-status.md); entry-point documents now link to it; dated paragraphs kept as history |
| F-02 | Migration counts 57/58/59/61 presented as current in onboarding and governance documents | **FIXED** | Counts replaced by links to the status record; `checkOnboardingDocs.ts` now asserts the record's count and latest migration equal `infra/supabase/migrations/` and rejects other counts presented as current in entry-point documents |
| F-03 | Node `24.14.1` pin behind upstream security releases 24.17.0 and 24.18.1 | **FIXED / VERIFIED_STAGING** | Baseline moved to `24.21.0` across `.nvmrc`, engines, workflows, Dockerfiles and deployment manifest; exact npm `11.11.0` is asserted at execution sites. Staging Admin/CMS and the accepted continuous-worker image now run the `7e85…` release built from this baseline. Applicability of individual upstream CVEs to this application was not separately claimed |
| F-04 | 39 of the last 40 PRs self-merged with zero approvals; `enforce_admins` false, no required status checks | **DEFERRED WITH REASON** (settings) / **FIXED** (documentation) | The project owner authorised the human-approval bypass for PP1 PRs on 2026-09-17; the exception and its limits are now recorded in the status record and `CONTRIBUTING.md` §G.7. Branch-protection changes are a School action after ownership transfer and were not made in this task |
| F-05 | Handoff ZIP: stale demo instructions, no repository URL, candidate-vs-deployed not stated | **FIXED** | Reproducible builder `npm run handoff:build` (`tools/handoff/build-handoff-package.mjs`) generates START-HERE from the source commit, states that the repository snapshot is authoritative, carries no demo-state assertions and includes the repository URL |
| F-06 | Three unmanifested package files; 26 dangling links in copied guides | **FIXED** | The new package embeds the complete tracked-source snapshot so repository-relative links resolve; the manifest covers every regular file except itself; the verifier rejects unmanifested, missing or tampered files |
| F-07 | ZIP entries used backslash separators | **FIXED** | Builder writes forward-slash entry names and the verifier checks every entry name, path traversal and duplicates on the actual archive |
| F-08 | 20 open, untriaged CodeQL alerts | **FIXED** (triage recorded below) / **DEFERRED WITH REASON** (no remote dismissals) | See §CodeQL triage. Alert dismissal in GitHub is an owner/maintainer action and was not performed. "Verified non-applicable" in that table means the assessed code path was inspected and found not to carry the alert's precondition; it is a source-inspection judgement, not a dynamic proof |
| F-09 | Dependabot alerts and secret-scanning alerts disabled on the public repository | **FIXED (settings)** | Free repository secret scanning, push protection and vulnerability alerts were enabled on 2026-09-21. The immediate point-in-time APIs reported zero open secret/dependency alerts, which is not treated as proof that future scans cannot find issues. Automatic dependency-security update PRs remain disabled deliberately |
| F-10 | Unused Gemini extraction module and `@google/genai` production dependency | **DEFERRED WITH REASON** | Removal is a dependency/config change outside the bounded closure scope; the module has no importer and cannot execute. Routine post-handoff maintenance |
| F-11 | Dead root `apps/admin-cms/proxy.ts`; executed `src/proxy.ts` never refreshes sessions | **DEFERRED WITH REASON** | Behaviour deliberately unchanged in this patch. Impact assessment: `requireAdmin()` re-verifies claims on every server request and fails closed, so this is not an authorisation bypass; the effect is that a long-idle browser session is not silently refreshed by the proxy and depends on Route Handler/Server Action cookie writes. Maintenance note added to the developer handover guide; a reviewed change should delete the root file and decide the intended session lifetime |
| F-12 | "Approved-only" feed wording | **FIXED** | Wording corrected to "published-only feed; `approved` records are publication candidates" in the current documents that had it |
| F-13 | `BrowserImportPreviewClient.tsx` size/cohesion | **DEFERRED WITH REASON** | Tested and working; refactor is optional post-handoff maintenance, not a closure defect |
| F-14 | Staging worker runs on a team member's Windows PC, undisclosed in repository docs | **FIXED** (disclosure) / **EXTERNALLY PENDING** (institutional host) | Disclosed in the status record and environment matrix; provisioning an institutional executor host remains a School action |
| F-15 | Stray root `pr_body.md` | **FIXED** | Removed |
| F-16 | Local machine paths in `docs/release-evaluation-integration-audit.md` | **DEFERRED WITH REASON** | Dated evidence document; paths are not secrets. Left unchanged to preserve historical evidence |
| F-17 | Six ESLint warnings versus the "0 warnings" contract | **FIXED** | Mechanical unused-variable removals only; no rule loosened |
| F-18 | CI job label "0048 to 0058" while the verifier replays to 0062 | **FIXED** | Display labels updated; job identifier, triggers and skip behaviour unchanged |
| F-19 | 5,929-line single-file upgrade verifier | **DEFERRED WITH REASON** | Works and is CI-exercised; splitting is optional maintenance |
| F-20 | No Git tag or release for the handoff baseline | **FIXED** | Runtime commit `7e85f1198a9fb8e5d73f2292ea657cbf1fc21477` is tagged `pp1-closure-runtime-20260921`; the final handoff package separately records its documentation-source commit and runtime identity |
| F-21 | README and START_HERE disagreed on macOS verification | **FIXED** | README aligned to the START_HERE statement (native corrective verification on the recorded checkout; not an independent fresh-clone human trial) |
| F-22 | `@types/node ^20` with a Node 24 runtime; duplicate list numbering; incomplete directory map | **DEFERRED WITH REASON** | Cosmetic; `@types/node` bump is routine dependency maintenance outside the bounded scope |
| F-23 | ~100 root npm scripts | **DEFERRED WITH REASON** | Discoverability only |

## Additional finding from this closure pass

| ID | Finding | Disposition | Evidence / reason |
| --- | --- | --- | --- |
| C-01 | `technicalShape()` in `languagePolicy.ts` used `^[A-Za-z0-9]*[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*$`, which backtracks polynomially: a 10,001-character `aA…aA_` token exceeded a 3-second child-process timeout on Node 24.21.0 | **FIXED** | Replaced by a one-pass equivalent (`internalUppercaseCompound`) of the same language; covered by `languagePolicyMaskRedos.test.ts`. Reachability requires the local LanguageTool provider to report a spelling match spanning such a token, which was not demonstrated |
| C-02 | Remaining mask patterns (`email`, `relative_slash_path`) backtrack super-linearly on hostile near misses | **DEFERRED WITH REASON** (measured, bounded; not a proof of non-applicability) | Measured scope: 17 hostile input families at 5,000 repetitions (up to 20,002 characters) on Node 24.21.0, one process each, 3 s timeout — worst observed 181.8 ms (`relative_slash_path`, 20,002 chars) and 169.6 ms (`email`, 20,002 chars); growth is consistent with quadratic behaviour, so the 25,000-code-unit provider field bound implies a worst case in the same order of magnitude (hundreds of milliseconds per field, four fields per project), which is why the patterns were left unchanged. Remaining uncertainty: other input families, other V8 versions and the concurrent-field case were not measured; this is a bounded measurement, not a universal denial-of-service assurance |

## CodeQL triage (post-merge scan 2026-09-21; no alerts dismissed remotely)

| Alert | Rule | Path | Assessment | Disposition |
| --- | --- | --- | --- | --- |
| 1 | `js/redos` | `apps/admin-cms/src/assistive-validation/domain/languagePolicy.ts:63` | Reproduced (exponential). Fixed by the linear camel-case pattern | **FIXED** — post-merge CodeQL marks the production alert fixed |
| 25 | `js/redos` | `apps/admin-cms/src/assistive-validation/__tests__/languagePolicyMaskRedos.test.ts:21` | Test-only reference pattern intentionally preserves the old pathological expression so the child-process timeout regression proves the production fix; it is never imported by runtime code | **DEFERRED WITH REASON** — keep the test evidence and bounded subprocess; do not copy the old pattern into production |
| 26 | `js/incomplete-sanitization` | `apps/admin-cms/src/security/nodeToolchainBaseline.test.ts:36` | Test-only regex escaping of the fixed Node version string; input is a trusted constant such as `24.21.0`, not user data or a runtime trust boundary | **VERIFIED NON-APPLICABLE** for deployed behavior; optional test hardening only |
| 7 | `js/insufficient-password-hash` | `apps/admin-cms/src/auth/recoveryContext.ts:61` | `createHmac('sha256', secret)` signs a recovery-context payload and is compared with `timingSafeEqual`; it is a MAC, not password storage | **VERIFIED NON-APPLICABLE** |
| 18, 19 | `js/incomplete-url-substring-sanitization` | `apps/public-layer/duda/bodyend.html:217,223` | `getEmbedUrl` uses `includes("youtube.com")`/`includes("vimeo.com")` only to choose a parser; the emitted URL is always rebuilt as `https://www.youtube.com/embed/<11-char id>` or `https://player.vimeo.com/video/<digits>`, so an attacker-controlled host cannot reach the iframe. Feed URLs are additionally validated upstream | **VERIFIED NON-APPLICABLE** (exploitability); a stricter hostname parse remains optional hardening |
| 20, 23 | `js/bad-tag-filter` | `apps/public-layer/scripts/test-duda-feed-url-validator.js:11`, `test-duda-query-preservation.js:10` | Test harnesses extract the single `<script>` block from the repository's own `bodyend.html` with a regex; input is tracked source, not untrusted HTML | **VERIFIED NON-APPLICABLE** |
| 22 | `js/reflected-xss` | `apps/public-layer/scripts/test-duda-current-feed-browser.js:1510` | Loopback-only browser harness (`127.0.0.1`, ephemeral port) that renders its own fixtures from query parameters during CI; never deployed | **VERIFIED NON-APPLICABLE** |
| 9, 10, 11 | `js/incomplete-sanitization` | `onboardingCheck.ts` (`git -C` quoting), `verifyApprovalEditGateRuntime.ts:13`, `verifyLocalSupabase.ts:283` (`"` escaping in shell commands) | Local developer/CI scripts whose inputs are the repository path or fixed SQL literals, not user input; the quoting is defensive, not a trust boundary | **VERIFIED NON-APPLICABLE**; optional hardening is to pass arguments via `execFileSync` arrays |
| 12, 24 | `js/incomplete-sanitization` | `controlledPublicationMigration.test.ts:61`, `governedProjectMaintenanceMigration.test.ts:69` | Regex escaping of constant strings inside unit tests | **VERIFIED NON-APPLICABLE** |
| 2, 3, 4, 5, 6, 8, 13, 17 | various | `Prototype/**` | Historical feasibility prototype; not built, deployed or referenced by any active path | **DEFERRED WITH REASON** — dismiss as "won't fix — historical" from the repository settings, or exclude `Prototype/` from the CodeQL configuration in a reviewed change |

## Dependency advisories (`npm audit --omit=dev`, Node 24.21.0, 2026-09-20)

| Advisory | Package / path | Usage | Disposition |
| --- | --- | --- | --- |
| GHSA-w5hq-g745-h8pq (moderate) | `uuid@8.3.2` via `exceljs@4.4.0` | `exceljs` calls `uuid.v4()` only; the advisory concerns `v3`/`v5`/`v6` with a caller-supplied buffer. No non-major fix (`npm audit` proposes downgrading `exceljs` to 3.4.0) | **VERIFIED NON-APPLICABLE** for this usage; re-evaluate when `exceljs` publishes a release on `uuid` ≥ 11.1.1 |
| GHSA-w5vr-8v7q-w6rv (moderate) | `baseline-browser-mapping@2.10.33` via `next` | Build-time browserslist mapping; not in the request path | **DEFERRED WITH REASON** — routine lockfile bump after handoff; fix available (≥ 2.11.0) |
| Dev-only `browserslist`, `js-yaml` (high) | ESLint toolchain | Not shipped | **DEFERRED WITH REASON** — routine maintenance |
| Dependabot #306 (TypeScript 5.9 → 7.0) | major compiler upgrade | — | **DEFERRED WITH REASON** — never merge blindly; needs its own verification |
| Dependabot #314 (16 minor/patch), #307 (jsdom), #308 (paddlepaddle) | grouped updates | — | **DEFERRED WITH REASON** — routine post-handoff maintenance; the Supabase CLI pin and worker image digest have their own contracts |

## Institutional items (unchanged by code)

| Item | Disposition |
| --- | --- |
| Ownership transfer of GitHub, Supabase, Render, Duda | **EXTERNALLY PENDING** |
| Institutional executor host (Profile A or B) | **EXTERNALLY PENDING** |
| Managed backups / PITR, RPO/RTO acceptance | **EXTERNALLY PENDING** |
| Monitoring alert destination | **EXTERNALLY PENDING** |
| Email provider approval and exact-link qualification | **EXTERNALLY PENDING** |
| Staff accounts, training, UAT | **EXTERNALLY PENDING** |
| Live Duda publishing authority and cutover | **EXTERNALLY PENDING** |
| 50 % efficiency measurement | **EXTERNALLY PENDING** |
| M6 acceptance checklist sign-off | **EXTERNALLY PENDING** |
| Current hosted health / closure runtime | **VERIFIED_STAGING** — 2026-09-21 rollout at `7e85…`: health/readiness 200, 62 migrations/current capability, one compatible worker; institutional/live acceptance remains separate |
