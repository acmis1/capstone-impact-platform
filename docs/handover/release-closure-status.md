# Release and Closure Status Record

**STATUS:** Current — the single current-state record for release identity
**PURPOSE:** Operations and handover
**LAST VERIFIED:** 2026-09-20

This is the one place that states *what is in the repository*, *what was observed running*, and *what
is still pending*. Every other current document links here instead of repeating counts or commit
identifiers. When a release, deployment, or worker replacement happens, update this record first
and cite the receipt; do not edit historical evidence documents to match.

The automated check `npm run check:onboarding-docs` asserts that the migration count and latest
migration named in this record equal the tracked `infra/supabase/migrations/` directory, and that
the entry-point documents do not present another count as current.

---

## 1. Identity summary

| Item | Value | Evidence class | Provenance |
| --- | --- | --- | --- |
| Repository | `https://github.com/acmis1/capstone-impact-platform` | Source | GitHub |
| Migration inventory (tracked) | **62** files; latest `20260918120000_governed_project_maintenance.sql` | Source (byte-identity manifest in `apps/admin-cms/src/deployment/hostedDeploymentReadiness.ts`) | Repository |
| Assistive pipeline identity | `assistive-deterministic-checks/v4` | Source | `apps/admin-cms/src/assistive-validation/domain/persistenceContract.ts` |
| Latest merged `main` (public-layer hotfix) | `5c88a6c1ff9a435cb1d4299d617543465175afa1` (PR #319, 2026-09-20) | Source; exact-head CI passed | GitHub Actions runs `35495228238`, `35495228243`, `35495228235`, `35495228285` |
| Previously observed deployed Admin/CMS backend | `9690ee0faa37fda502a15b4403f1e293f79b519f` (PR #318, 2026-09-18) | Staging self-verified (team receipt); one later independent credential-free read | Team rollout receipt `78-final-handoff-summary.json` (`/api/readiness` `ready`, release `9690…`); independent `GET /api/readiness` during the 2026-09-20 audit returned `READY`, `deploymentCommit=9690…`, `expectedMigrations.count=62`, `databaseCapability=current` |
| Hosted migration/schema evidence | 62 applied through `20260918120000`, migration file SHA-256 `bf0e3f2465841d08b3cfc1d974e7ccab0f34a6917f306fa9b4a1e0f928b0b73a`, 51 pre-existing table contents preserved, no physical asset deletion | Team-produced deployment receipt, not an independently repeated test | Receipt `43-m62-applied-receipt.json` (2026-09-18T15:11Z). No independent Gate 4 (full schema/grants) capture exists for the 62-migration state; the last full `GATE4_MATCH` capture is the historical 57-migration one |
| Worker identity (staging, continuous profile) | image `capstone-assistive-worker:9690ee0faa37fda502a15b4403f1e293f79b519f`, image id `sha256:6416800492161df12e55f07ad577760b557802e301361414e8f956d316197f46`, mode `CONTINUOUS`, non-root, read-only, all capabilities dropped | Team receipt | Receipt `44-worker-replacement.json` (2026-09-18T15:13Z). The host is a project-team member's Windows machine running Docker Desktop, i.e. Profile B on a non-institutional host; see §4 |
| Installed public-layer identity (Duda TEST site) | renderer at `5c88a6c1…`, Save-installed only (no Duda Publish/Republish) | Team browser verification | Hotfix note in the 2026-09-20 rollout record; live public site untouched |
| Composite running identity | Admin/CMS + worker `9690…`; Duda TEST public layer `5c88…` | — | The `9690…` → `5c88…` difference is only `apps/public-layer/duda/detail-page.css` and its browser regression, so the pair is legitimate and the Admin/CMS is deliberately **not** redeployed to equalise SHAs |

Anything newer than `5c88a6c1…` — including the closure candidate described in §3 — is **repository
source only** until a dated rollout receipt is added here.

---

## 2. What the evidence does and does not prove

- **Repository files and readiness expectations prove intent**, not hosted state. `/api/readiness`
  compares the running build's manifest with a database capability sentinel; it proves the
  deployed commit and that the database advertises the expected capability tags. It does not
  prove full migration history or schema equality (that needs Gate 3/4 of the
  [staging reconciliation runbook](../../infra/supabase/staging-reconciliation-runbook.md)).
- **A team-produced receipt is evidence with that provenance.** The receipts cited above were
  produced by the project team's own rollout tooling and were not independently repeated.
- **The 2026-09-20 readiness observation is dated.** A later credential-free `GET /api/readiness`
  the same day (11:48 UTC) exceeded a 15-second timeout. Free-tier web-service sleep is a plausible
  cause but was not verified. Treat current hosted health as **NOT VERIFIED** until re-read.
- **CI on macOS is not human macOS onboarding.** Native macOS corrective verification was run on
  the recorded local checkout after the loopback-binding fix (see `START_HERE.md`); an
  independent fresh-clone human trial on macOS or Linux has not been performed.
- **A contributor CI build is not staff UAT.** Staff acceptance testing was unavailable and is
  recorded as pending in the [M6 acceptance checklist](../m6-release-acceptance-checklist.md).

---

## 3. Closure candidate (source only — NOT MERGED, NOT DEPLOYED)

Branch `fix/final-handoff-closure-20260920`, based on `5c88a6c1…`, contains:

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

Deployment of this candidate requires, in order: independent review → exact-head CI → merge →
post-merge `main` CI → worker image rebuild from the merged commit and replacement of the running
continuous worker (its heartbeat compatibility is by pipeline version and capabilities, so the old
worker keeps working, but it would still run the old Node and old regex) → Admin/CMS redeploy →
fresh `/api/readiness` read → update of §1 with the new receipts. None of that has happened.

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
