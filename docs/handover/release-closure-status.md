# Release and Closure Status Record

**STATUS:** Current — the single current-state record for release identity
**PURPOSE:** Operations and handover
**LAST VERIFIED:** 2026-09-21

This is the one place that states *what is in the repository*, *what was observed running*, and *what
is still pending*. Every other current document links here instead of repeating counts or commit
identifiers. When a release, deployment, or worker replacement happens, update this record first
and cite the receipt; do not edit historical evidence documents to match.

The automated check `npm run check:onboarding-docs` asserts that the migration count and latest
migration named in this record equal the tracked `infra/supabase/migrations/` directory, and that
the entry-point documents do not present another count as current.

---

## 1. Identity summary

The machine-readable declaration below records the *current runtime identities* used by the
drift check. Because a tracked file cannot contain the hash of the commit that contains itself,
`main` means the latest **runtime-bearing** commit merged to `main`, not a later documentation-only
receipt/status commit. The released handoff package records its own exact source commit separately.
Every other commit mentioned in prose is a receipt, package source, candidate, or dated history.

<!-- current-identity
main: 7e85f1198a9fb8e5d73f2292ea657cbf1fc21477
deployed-backend: 7e85f1198a9fb8e5d73f2292ea657cbf1fc21477
public-layer: 5c88a6c1ff9a435cb1d4299d617543465175afa1
-->

| Item | Value | Evidence class | Provenance |
| --- | --- | --- | --- |
| Repository | `https://github.com/acmis1/capstone-impact-platform` | Source | GitHub |
| Migration inventory (tracked) | **62** files; latest `20260918120000_governed_project_maintenance.sql` | Source (byte-identity manifest in `apps/admin-cms/src/deployment/hostedDeploymentReadiness.ts`) | Repository |
| Assistive pipeline identity | `assistive-deterministic-checks/v4` | Source | `apps/admin-cms/src/assistive-validation/domain/persistenceContract.ts` |
| Runtime-bearing `main` release | `7e85f1198a9fb8e5d73f2292ea657cbf1fc21477` (PR #320, tag `pp1-closure-runtime-20260921`) | Source + exact-head/post-merge CI | PR and post-merge workflows all passed; the dispatched disposable annual-volume job also verified 120 governed publications |
| Deployed Admin/CMS backend | `7e85f1198a9fb8e5d73f2292ea657cbf1fc21477`, Render deploy `dep-dao2bgh42hec7386cm6g` | `VERIFIED_STAGING` | 2026-09-21 closure rollout: `/api/health` 200; `/api/readiness` 200 with `deploymentCommit=7e85…`, 62 expected migrations, `databaseCapability=current`, `readiness=ready`; exact npm-pinned build command observed in the successful Render build log |
| Hosted migration/schema evidence | 62 applied through `20260918120000`, migration file SHA-256 `bf0e3f2465841d08b3cfc1d974e7ccab0f34a6917f306fa9b4a1e0f928b0b73a`, 51 pre-existing table contents preserved, no physical asset deletion | Team-produced deployment receipt, not an independently repeated test | Receipt `43-m62-applied-receipt.json` (2026-09-18T15:11Z). No independent Gate 4 (full schema/grants) capture exists for the 62-migration state; the last full `GATE4_MATCH` capture is the historical 57-migration one |
| Worker identity (staging, continuous profile) | image `capstone-assistive-worker:7e85f1198a9fb8e5d73f2292ea657cbf1fc21477`, image id `sha256:ae428451ed0b79041054f52cf2454474ed4d7a5bb2e789ffc07ad163ccc203f5`, mode `CONTINUOUS`, non-root, read-only, all capabilities dropped | `VERIFIED_STAGING` | Canonical image and running verifiers passed; a fresh v4 heartbeat for deployment `7e85…` returned `AVAILABLE` with exactly one compatible worker. The host remains a project-team member's Windows machine running Docker Desktop; see §4 |
| Installed public-layer identity (Duda TEST site) | renderer assets at `5c88a6c1ff9a435cb1d4299d617543465175afa1`, Save-installed only (no Duda Publish/Republish) | Team browser verification | The closure runtime changed no `apps/public-layer/duda/**` asset; the live public site remains untouched |
| Composite running identity | Admin/CMS + worker `7e85…`; Duda TEST renderer `5c88…` | `VERIFIED_STAGING` + TEST-editor evidence | The closure release did not change Duda renderer assets, so the saved TEST renderer legitimately remains at `5c88…`; do not publish or redeploy merely to equalise unrelated identities |

The technical closure runtime at `7e85…` is deployed and verified on staging. A later
documentation-only status/receipt commit may advance repository `main`; it is **not** a new runtime
release and must not be deployed merely to make source and runtime SHAs equal.

---

## 2. What the evidence does and does not prove

- **Repository files and readiness expectations prove intent**, not hosted state. `/api/readiness`
  compares the running build's manifest with a database capability sentinel; it proves the
  deployed commit and that the database advertises the expected capability tags. It does not
  prove full migration history or schema equality (that needs Gate 3/4 of the
  [staging reconciliation runbook](../../infra/supabase/staging-reconciliation-runbook.md)).
- **A team-produced receipt is evidence with that provenance.** The receipts cited above were
  produced by the project team's own rollout tooling and were not independently repeated.
- **Current staging runtime was re-verified during the 2026-09-21 closure rollout.** Render deploy
  `dep-dao2bgh42hec7386cm6g` serves runtime commit `7e85…`; health and readiness returned HTTP 200,
  readiness reported 62 expected migrations and a current database capability, and a fresh matching
  continuous-worker heartbeat returned `AVAILABLE` with one compatible worker. This remains staging
  self-verification, not staff UAT or institutional production acceptance.
- **CI on macOS is not human macOS onboarding.** Native macOS corrective verification was run on
  the recorded local checkout after the loopback-binding fix (see `START_HERE.md`); an
  independent fresh-clone human trial on macOS or Linux has not been performed.
- **A contributor CI build is not staff UAT.** Staff acceptance testing was unavailable and is
  recorded as pending in the [M6 acceptance checklist](../m6-release-acceptance-checklist.md).

---

## 3. Technical closure release — MERGED AND VERIFIED ON STAGING

PR #320 was squash-merged as runtime commit `7e85f1198a9fb8e5d73f2292ea657cbf1fc21477` and tagged `pp1-closure-runtime-20260921`. The release contains:

1. **Node 24 maintenance baseline `24.21.0`** (was `24.14.1`; Node 24.17.0 and 24.18.1 were
   upstream security releases). Updated together: `.nvmrc`, workspace `engines`, lockfile engine
   metadata, every maintained workflow, the three maintained Dockerfiles, the staging deployment
   manifest, `onboardingCheck.ts`, and a new `nodeToolchainBaseline.test.ts` that fails if any of
   them drift apart. npm stays `11.11.0`; the Supabase CLI stays `2.109.1`; no framework or
   application dependency version changed.
2. **Language-mask regular-expression denial-of-service correction** in
   `apps/admin-cms/src/assistive-validation/domain/languagePolicy.ts`: the camel-case mask pattern
   and the `internal_uppercase_compound` technical-shape rule were rewritten as linear equivalents
   of the same languages, with `languagePolicyMaskRedos.test.ts` covering hostile near-miss inputs
   up to the 25,000-code-unit provider bound in a child process with an OS-enforced timeout. The
   frozen policy (`policySha256` `3984b958…`), the pipeline version, evidence schemas and migration
   bytes are unchanged, because the accepted-input sets are identical.
3. **Current-state documentation reconciliation** (this record, entry-point links, stale counts and
   commit identifiers, published-only feed wording, executor host disclosure, governance note).
4. **Mechanical lint clean-up** (six unused variables), removal of the stray root `pr_body.md`, and
   a CI display-label correction for the disposable migration-upgrade job.

The [release rollout runbook](../operations/release-rollout-runbook.md) was executed for staging on
2026-09-21: independent review and exact-head PR CI passed; PR #320 merged; post-merge `main` CI and
the separately dispatched disposable 120-project publication exercise passed; the exact merged-commit
worker image was built and accepted; the previous worker stopped gracefully; Render was updated to
expect the same worker commit and deployed that exact commit; the new worker started from the accepted
immutable image; then application readiness and worker availability were verified separately.

The assistive-only transition window lasted about 250 seconds. Read-only before/after retention
fingerprints were identical for 50 application/execution-control tables (1,371 rows), two Auth tables
(4 rows), and Storage bucket/object metadata (284 rows); the volatile worker-heartbeat table was
intentionally excluded. The canonical public feed also remained byte-identical: 46,858 bytes, 10
records, SHA-256 `c3ab0db4595ec8ed67d010e40df3be09f1e2ce33f04cbcb064daa97ef4efe6a6`.
There was no schema change, no business-data deletion, no email send, and no Duda Publish/Republish.

5. **Corrective independent-review closure (2026-09-21):** the rollout identity contract is pinned
   by `rolloutIdentityContract.test.ts`; the handoff verifier validates raw ZIP inventory before
   extraction; the documentation drift guard uses bounded explicit claim conventions; npm `11.11.0`
   is pinned and asserted in CI, Docker build stages, and the Render build command.
6. **Repository/handoff hardening:** free GitHub secret scanning, push protection, and vulnerability
   alerts are enabled. CodeQL's original production language-policy ReDoS alert is fixed; remaining
   alerts are retained/triaged rather than silently dismissed. The first completed Dependabot scan
   exposed 25 alerts: 17 are in immutable historical `Prototype/`; the active root has no critical/high
   runtime alert, but retains four high development-only, two medium development-only, and two medium
   runtime-scope advisories recorded in the disposition register. Automatic dependency-update PRs
   remain disabled to avoid an unreviewed post-closure dependency sweep.

---

## 4. Operational disclosures

- **Staging assistive executor host.** The continuous worker recorded in §1 runs on a project-team
  member's Windows PC (Docker Desktop, `linux/amd64` container). Staging assistive processing stops
  whenever that machine sleeps or Docker Desktop is closed. The School has not provisioned Profile
  A (cloud on-demand executor) or Profile B on institutional compute; see the
  [resource ownership matrix](resource-ownership-matrix.md) and the
  [environment matrix](environment-matrix.md).
- **Review governance during the PP1 project phase.** On 17 September 2026 the project owner explicitly
  authorised merging PP1 pull requests without waiting for a human teammate approval, including
  future PP1 PRs. Under that exception the closure PRs (#313 onward) were authored and merged by
  the repository administrator after AI-assisted independent review and exact-head CI, with zero
  GitHub approvals. That exception does **not** waive independent technical review, exact-head CI,
  final diff inspection, migration/data-integrity review, generated-file checks, or post-merge
  verification, and it is not the School's future policy: once ownership transfers, the School
  should enable `enforce_admins` and required status checks on `main` and restore the
  human-approval rule in `CONTRIBUTING.md` §G.7. Do not read "independent review passed" in
  rollout receipts as human peer review.
- **Optional voting feature.** Deferred by accepted scope; not a defect.

---

## 5. Institutional acceptance

**NOT EVIDENCED.** Ownership transfer of every hosted resource, a School-controlled executor host,
email provider approval and exact-link qualification, managed backups/PITR and RPO/RTO acceptance,
monitoring alert destination, real staff accounts and training, staff UAT, live Duda publishing
authority and cutover, the 50 % efficiency measurement, and formal sign-off all remain pending. The
[M6 release acceptance checklist](../m6-release-acceptance-checklist.md) must be completed and
signed by the School; nobody on the project team may fill it in on the School's behalf.

The finding-by-finding disposition of the 2026-09-20 independent closure audit is in the
[closure audit disposition register](closure-audit-disposition-register.md).
