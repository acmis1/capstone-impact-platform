# Staging Migrations 0049–0051 Rollout Plan

Release-specific operational packet for advancing hosted staging-v2
(`capstone-admin-cms-staging-v2-2026`, ref `sqkpceeltukbzxpsvinb`) from the historical
48-migration baseline to the current 51-migration repository target.

> [!IMPORTANT]
> **This document authorizes nothing.** It records the planned order, the read-only evidence that
> must exist first, the backup precondition, and the verification that must follow. Every mutating
> step named here stays blocked until the project owner authorizes it explicitly, after reviewing
> the complete read-only evidence and the recovery precondition. Nothing in this plan permits a
> hosted write, a Render deployment, a Duda publication, a public-feed write, or an outgoing email.

The canonical generic procedure remains the seven-gate
[staging reconciliation runbook](../../infra/supabase/staging-reconciliation-runbook.md). This
document does not replace it and does not restate its gates; it names them and adds only what is
specific to this one transition.

---

## A. Source state

| Item | Value |
| :--- | :--- |
| Repository source SHA at plan creation | `39c7edce84fbad8da480d0ad713db78afb14ad0d` |
| Repository migration count at that SHA | 51, latest `20260903130000_participant_owned_corrections.sql` |
| Known hosted historical baseline | 48 / 48 migrations through `20260831090000_postgres17_maintain_privilege_alignment` |
| Hosted deployment of migrations 0049–0051 | **NOT ASSERTED.** No hosted check has established it. |

The 48/48 observation is point-in-time evidence recorded earlier; an even earlier observation
recorded 46 rows through `20260828120000`. Neither proves that any particular `main` SHA is
deployed, and neither may be reused as the pre-mutation reading. **The latest hosted state must be
re-read read-only immediately before any action.** If a fresh reading disagrees with the 48-row
baseline recorded here, stop and reconcile before continuing; do not proceed on this document's
numbers.

---

## B. Migration effects

### Migration 0049 — `20260902010606_controlled_project_links_import.sql`

- Controlled video, live demo/prototype and source repository URLs parsed from
  `project-details.xlsx` are persisted into the existing `projects.video_url`,
  `projects.demo_url` and `projects.repository_url` columns during workbook intake.
- The migration is a single `CREATE OR REPLACE FUNCTION public.stage_browser_import_metadata(...)`
  plus a restatement of its existing `REVOKE`/`GRANT` contract. It creates, alters and drops no
  table, column, constraint, index, trigger or bucket, and it rewrites no existing row.
- These values remain project metadata. The migration introduces no binary video upload, no
  arbitrary embed, and no new publication media role.
- It makes **no** claim that a controlled link is participant-confirmed evidence. At this point a
  populated link is still content a participant may never have been shown.

### Migration 0050 — `20260903120000_participant_preview_controlled_links.sql`

- Projects the three controlled links into the single canonical participant-facing snapshot at all
  three authorities that build it: `generate_participant_preview` (issuance),
  `get_project_publication_readiness` (publication staleness gate) and
  `get_project_reconciliation_readiness` (deployment reconciliation staleness gate).
- Publication and reconciliation snapshot comparisons are updated together, so a controlled link
  that changes after confirmation invalidates the confirmation exactly like any other content
  change.
- **Historical previews are not backfilled.** No stored snapshot is rewritten. A preview issued
  before this migration carries none of the three keys and stays equivalent only while the project
  still has no controlled link at all; any populated controlled URL invalidates the confirmation
  rather than being grandfathered in.
- Three `CREATE OR REPLACE FUNCTION` statements plus restated grants. No table DDL, no data change.

### Migration 0051 — `20260903130000_participant_owned_corrections.sql`

- Creates the private `participant-corrections-private` Storage bucket (private, 20 MB limit,
  XLSX/PNG/JPEG/WebP/PDF) with `ON CONFLICT (id) DO NOTHING`.
- Creates four correction evidence tables: `participant_correction_submissions`,
  `participant_correction_prior_revisions`, `participant_correction_recovery_rows` and
  `participant_correction_events`. All four have RLS enabled, `REVOKE ALL` from
  `PUBLIC`/`anon`/`authenticated`/`service_role`, and then `GRANT SELECT` to `service_role` only.
- Adds six service-role-only correction RPCs and the participant/staff pre-preview complete-package
  workflow they implement.
- Retires the legacy staff shortcut: `start_participant_preview_correction_resolution` becomes
  fail-closed and returns `PARTICIPANT_CANDIDATE_REQUIRED`.
- Correction evidence is immutable: `BEFORE UPDATE OR DELETE` triggers raise
  `CORRECTION_EVIDENCE_IMMUTABLE`, no foreign key carries `ON DELETE CASCADE`, and there is no
  Storage deletion path in submission or acceptance.
- Manufactures no correction package or evidence row, and removes no Storage object.

---

## C. Pre-mutation read-only gates

Run the existing seven-gate procedure in
[staging-reconciliation-runbook.md](../../infra/supabase/staging-reconciliation-runbook.md).
Gates 1–5 are the read-only evidence layer; do not copy or paraphrase their steps here — run them.

All five readings must be **fresh** for this release candidate:

1. **Target identity** — the linked project ref is exactly `sqkpceeltukbzxpsvinb`, and no other
   project is linked in the workspace.
2. **Migration-history evidence** — the exact current row set of
   `supabase_migrations.schema_migrations`, expected to be the 48-row baseline through
   `20260831090000`. A different reading stops this rollout.
3. **Gate-4 snapshot** — a fresh SELECT-only catalog snapshot captured with
   `infra/supabase/gate4-schema-evidence.sql`. Against the current 51-migration contract this is
   expected to report `INCOMPLETE`/drift for the four correction tables, the six correction RPCs
   and the correction bucket, because they do not exist at the 48 baseline. That is the truthful
   pre-migration difference and must never be resolved by relaxing the repository contract.
4. **Current application deployment identity** — the exact deployed Render commit, read read-only.
5. **Zero unexpected schema drift** — no schema object outside the 48-migration baseline, and no
   unexplained grant, policy, or routine.

Record all five readings before any authorization request. `supabase migration repair` is not part
of this rollout; a count mismatch is never repaired to make numbers agree.

---

## D. Backup / recovery precondition

A restorable capture of the **pre-migration 48 state** must exist and be verified before any
migration is applied.

### Why the current tooling cannot capture it

`captureRecoveryBackup` deliberately derives its expectations from the repository checkout it runs
from. At the current 51-migration `main` it:

- requires the source migration history to equal `repositoryMigrationVersions()` — 51 versions;
- requires all four `CANONICAL_STORAGE_BUCKETS`, refusing with `SOURCE_CANONICAL_BUCKET_MISSING`
  before any dump when one is absent;
- validates the source Gate 4 evidence against the current 51-migration contract, refusing with
  `SOURCE_GATE4_CONTRACT_INVALID` otherwise.

A hosted source still at 48 migrations has three buckets and none of the correction objects, so the
current tooling **correctly refuses it**. This refusal is proven by
`apps/admin-cms/src/recovery/zeroCostRecovery.test.ts` ("pre-migration hosted baseline capture
boundary") and observed live by the disposable upgrade rehearsal in section H, which asserts that
the current Gate 4 contract rejects a real 48-state database.

### Chosen strategy: capture from a 48-migration-compatible checkout

Use a separate, reviewed checkout of the exact repository commit whose recovery contract matches the
48-state source, and run the capture from there:

| Item | Value |
| :--- | :--- |
| Capture checkout commit | `6125bb56a2c71c16a45cce44851696e8b09a3b4c` |
| Migrations at that commit | 48, latest `20260831090000_postgres17_maintain_privilege_alignment` |
| `CANONICAL_STORAGE_BUCKETS` there | `project-drafts-private`, `project-public-assets`, `public-feeds` |
| `EXPECTED_REPOSITORY_MIGRATION_COUNT` there | 48 |
| Relationship to current `main` | Direct first-parent parent of `744a3b7`, the commit that introduced 0049–0051 |

That commit is the newest 48-migration state on `main`, so it already carries the hardened recovery
work merged before the release: hosted Auth schema drift handling (#252), hosted platform role ACL
normalization (#256) and bounded Gate 4 restore portability (#258). Its capture path is the same
hardened path as today's, differing only in the inventory it expects.

The alternative — teaching the current tooling an explicit versioned historical-baseline contract —
was rejected. It would add a second expectation set inside the one component whose value is that it
has exactly one, and any bug in selecting between them would silently produce a bundle whose
manifest disagrees with the database it describes. Using a checkout whose single contract already
is the 48 contract keeps that impossible.

### Requirements the capture must satisfy

- Capture the authoritative 48-state database as the ordered five-artifact logical bundle.
- Capture that source's actual canonical Storage inventory — the three buckets that exist at 48.
- Preserve Auth, recovery and assistive cost-fence evidence applicable to that source, including
  the launch budget guard and reservation history.
- Never mutate the source. The capture is read-only; do not relink, repair, or reset it.
- Produce evidence sufficient to restore the pre-migration state into an **isolated** target, never
  back over the source.
- Write the bundle to an absolute, empty, private directory outside every Git working tree. The
  bundle contains private participant and staff data and role definitions; it is never committed.

Verify the bundle before authorizing any migration: manifest checksums valid, migration history
exactly the 48 baseline, Storage object set and byte checksums matching, and a restore into a
disposable isolated target reaching the source's own Gate 4 contract.

The real hosted capture is a separately authorized operation and has not been executed.

---

## E. Mutation stop point

> **NO migration is applied until explicit project-owner authorization occurs, after the complete
> read-only evidence in section C and the verified recovery precondition in section D have been
> independently reviewed together with the controlled migration-window procedure below.**

Record the exact currently deployed application SHA before entering the window. An approved
hosting/access procedure capable of preventing normal staff mutation traffic is a precondition
for authorization. The operator must enforce and verify that restriction **before applying 0049**
and maintain it through successful H2 completion. This repository does not supply a maintenance-mode
feature. If no approved mechanism exists, the hosted rollout is **BLOCKED** until one is defined.

Authorization is per-release and does not carry over. If any gate reading is stale, missing, or
disagrees with section A, this rollout stops.

---

## F. Apply order

Deterministic, forward-only, one migration at a time:

```text
48 existing baseline
  -> 0049  20260902010606_controlled_project_links_import
  -> 0050  20260903120000_participant_preview_controlled_links
  -> 0051  20260903130000_participant_owned_corrections
```

- No step is skipped, reordered, or combined.
- No `supabase migration repair` is used to force a count to match.
- No historical migration file is edited, renamed, or deleted. Migrations 1–51 are immutable.
- After each migration, confirm the recorded head advanced by exactly one and that the expected
  effects for that migration (section B) are observable using database-only evidence before
  applying the next. Compare existing row counts/content, stored snapshots, Storage inventory and
  byte checksums, and grants to the pre-migration evidence. Do not exercise staff mutation workflows.

---

## G. Application deployment order

Compatibility of the current application (`main` at the source SHA) against each database state:

| Database state | Current application | Notes |
| :--- | :--- | :--- |
| Pre-migration 48 | **Incompatible** | The application expects the four correction tables, the six correction RPCs and `participant-corrections-private`. Correction and pre-preview package surfaces fail. Gates 3 and 4 establish the missing migration/schema contract; `/api/readiness` cannot detect it. |
| After 0049 | **Still incompatible** | Controlled-link intake works, but the correction contract is still absent. |
| After 0050 | **Still incompatible** | Snapshot authorities are current; the correction contract is still absent. |
| After 0051 | **Compatible** | The full 51-migration contract the application targets exists. |

The old application is also behaviorally incompatible with the 0051 database. At historical
commit `6125bb56a2c71c16a45cce44851696e8b09a3b4c`, `ParticipantPreviewPanel.tsx` offers a POST to
`/api/projects/[publicId]/participant-preview/correction-resolution`; that route calls
`SupabaseParticipantPreviewRepositoryCore.startCorrectionResolution`, which expects `SUCCESS` or
`ALREADY_IN_PROGRESS` from `start_participant_preview_correction_resolution`. Migration 0051
instead always returns `PARTICIPANT_CANDIDATE_REQUIRED`, so that old workflow fails. The addition
of new objects does not make 0051 backward compatible.

The safe order is **controlled window, database, application, verified reopening**:

1. Complete fresh read-only Gates 1–5 (section C).
2. Complete and independently verify the 48-state recovery bundle and isolated restore (section D).
3. Record the exact currently deployed application SHA.
4. Obtain explicit authorization for the controlled migration window and enforce the approved
   hosting/access restriction. Verify that normal staff mutation workflows are unavailable.
5. Apply 0049, then perform its database-only verification (sections B and F).
6. Apply 0050, then perform its database-only verification (sections B and F).
7. Apply 0051, then complete H1, including the exact Gate 4 match and fail-closed legacy shortcut.
8. Only after H1 passes, deploy the exact reviewed 51-compatible application SHA.
9. Complete H2 against that deployed application.
10. Restore normal staff workflow access only after **every H2 check passes**.
11. Stakeholder UAT / Duda TEST remains a later, separately governed step (section I).

The new 51-contract application must not become active before the database reaches 0051. Normal
staff mutation access stays unavailable for the entire window, including deployment or verification
failures. Green database verification alone never authorizes reopening.

**Never roll the application backward across this transition.** Migrations 0049–0051 are
forward-only. An older build cannot un-create the correction tables, cannot restore the retired
`start_participant_preview_correction_resolution` shortcut, and would present a stale contract
against a database that has already advanced. Any application revert must retain a reviewed
51-compatible build and pass H2 before reopening; keep access blocked if none is available.
Treat the database state as the fixed forward baseline; a database rollback
is a restore from the section D bundle into an isolated target plus a separately authorized
cutover decision, never an in-place downgrade.

---

## H. Verification stages

### H1. Post-database / pre-application verification

Complete these database-only checks before deploying the new application. Keep normal staff
mutation workflows unavailable:

- **Migration history**: 51 / 51 rows, latest `20260903130000`, matching the repository manifest
  exactly.
- **Gate 4**: exact match against a freshly collected snapshot — no drift in tables, columns,
  constraints, RLS, policies, schema and table grants, exposed and non-public routines, relevant
  roles, or bucket configuration.
- **Tables**: 44 / 44 — 41 public application tables plus 3 non-public
  assistive-execution-control tables.
- **RPCs**: 84 / 84 service-role application RPC signatures across 83 / 83 names.
- **Dispatcher routines**: 4 / 4 non-public execution-control routines, each search-path-pinned
  `SECURITY DEFINER` and executable only by `capstone_assistive_dispatcher`.
- **Storage buckets**: 4 / 4 canonical buckets, with `participant-corrections-private` private and
  carrying its exact size and MIME contract.
- **Grants, RLS and policies**: exact. In particular `PUBLIC`, `anon` and `authenticated` hold no
  authority on any correction table, and `service_role` holds `SELECT` only.
- **Legacy shortcut**: verify the definition of `start_participant_preview_correction_resolution`
  unconditionally returns `PARTICIPANT_CANDIDATE_REQUIRED`. Use read-only definition inspection;
  the disposable rehearsal separately tests the return value.
- **Preservation**: existing rows in all 37 baseline public tables and all 3 execution-control
  tables, historical snapshots, and existing Storage object keys/bytes/checksums are unchanged
  through each migration. Never clear cost-fence reservations to obtain a match.

Gates 3 and 4 supply migration/schema evidence. `/api/readiness` supplies application
configuration, target identity, credential-shape and dependency-liveness evidence via a bounded
service-role HEAD query to `public.programs`. It reports the migration manifest the **bundle
expects**, plus valid commit metadata when available; it does not inspect migration history,
correction tables, exact RPC signatures, grants, RLS, policies or bucket inventory. It can be
green on a 48-state database and cannot replace H1.

### H2. Post-application deployment verification

After H1 passes and the exact reviewed 51-compatible build is deployed, verify:

- **Deployment identity**: the deployed commit equals the exact reviewed SHA.
- **`/api/health`**: HTTP 200.
- **`/api/readiness`**: expected readiness classification for the staging target.
- **`/login`**: the login surface returns the expected HTML.
- **Read-only hosted smoke**: the existing GET/HEAD-only verifier passes — health, readiness,
  login, deployment SHA, redirects, timeouts and migration expectation.

Any single failure stops acceptance and keeps normal staff mutation access unavailable. Restore
normal staff workflow access only after H2 passes. Do not relax a contract to make a check pass.

### Repository rehearsal preconditions

Repository-side evidence that must already be green before hosted work begins:

```bash
npm run verify:staging-migration-upgrade:disposable
```

```bash
npm run verify:gate4-schema-evidence:disposable
```

```bash
npm run verify:zero-cost-recovery-rehearsal
```

The first provisions exactly the 48-migration baseline on a disposable owned stack, seeds
representative synthetic 48-state evidence, applies 0049, 0050 and 0051 one at a time, and asserts
after each step that counts/content in all 37 baseline public tables and all 3 execution-control
tables, snapshots and grants are unchanged. It uploads a nonzero synthetic object into an existing
pre-0051 bucket through the supported Local Storage API, then verifies the complete object set,
metadata, byte lengths and SHA-256 checksums after each migration. Migration 0051 alone creates the
correction bucket. The rehearsal contacts no hosted system.

---

## I. UAT handoff

Technical staging acceptance is a precondition for, not a substitute for, stakeholder acceptance.

Once every check in section H passes, hand off to the existing stakeholder UAT and Duda TEST
process described in [M6 Release Acceptance Checklist](../m6-release-acceptance-checklist.md) and
[M6 Operational Readiness & Recovery](../m6-operational-readiness.md). This rollout implements none
of that process.

**No live Duda publication is part of this rollout.** Public-feed writes, public media storage
writes, `/api/publish-cloud-feed`, and outgoing participant email remain separately governed and
out of scope here.
