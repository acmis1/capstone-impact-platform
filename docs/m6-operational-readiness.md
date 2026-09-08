# M6 Operational Readiness and Recovery Contract

This document is the canonical PP1 M6 operational-readiness contract for the active Admin/CMS. It defines what the repository can prove now, what a supervised hosted rehearsal must prove later, and which decisions remain with the institution. It does not authorize a deployment, hosted mutation, restore, rollback, DNS change, Duda change, email, or secret access.

Executable application code, migrations, and tests on the reviewed commit remain the source of truth. The current package contains 52 migration files ending at `20260906120000_public_removal_completion_reconciliation`; `npm run check:operational-readiness` verifies that exact manifest and fails closed when it changes unexpectedly.

## Evidence vocabulary

Every capability in this package uses exactly one status:

| Status | Meaning |
| --- | --- |
| `IMPLEMENTED_AND_TESTED` | Repository code exists and automated tests exercise the stated boundary. It is not automatically hosted proof. |
| `VERIFIED_STAGING` | Supplied independent evidence recorded the stated bounded result on the named staging target. It is not production, recovery, monitoring, human-acceptance, or institutional-approval proof. |
| `IMPLEMENTED_BUT_NOT_OPERATIONALLY_VERIFIED` | Code exists, but the required current hosted or supervised evidence has not been recorded. |
| `DOCUMENTED_ONLY` | A controlled procedure or template exists, but it has not been rehearsed. |
| `INSTITUTION_DEPENDENT` | An institutional owner, policy, account, provider, credential, or approval is required. |
| `MISSING` | No acceptable current evidence exists. |

`LOCAL`, `STAGING`, and `PRODUCTION` evidence are never interchangeable. `PROCEDURE DEFINED` is not `REHEARSAL PASSED`.

## Current constrained human-evidence boundary — 2026-09-08

Stakeholder/staff availability is constrained near the deadline. Completion
Plan risk R1 is therefore `R1_TRIGGERED` with `MITIGATION_ACTIVE`; it is not
closed. See the [stakeholder and constrained human-evidence audit](stakeholder-and-constrained-human-evidence-2026-09-08.md)
for the source-grounded distinction between historical industry requirements,
academic-supervisor demonstrations, and formal intended-user UAT.

Technical M6 and E3 evaluation may continue independently with synthetic data
where human participation is not required. Formal human acceptance remains
pending: KPI-01 has no comparable human measurement, KPI-12 has
`FORMAL_INTENDED_USER_UAT_PENDING`, and KPI-15 has
`HUMAN_TRAINING_AND_OWNERSHIP_PENDING`. This note does not weaken KPI-14 or
KPI-15 rules and does not turn machine evidence into human evidence.

## Current M6 / KPI-14 / KPI-15 gap matrix

| Capability | Status | Current evidence and remaining gap |
| --- | --- | --- |
| Repository release identity | `IMPLEMENTED_AND_TESTED` | The M6 checker records the full checkout SHA and optionally compares it with a separately reviewed SHA. |
| `/api/health` liveness | `IMPLEMENTED_AND_TESTED` | Route and contract tests prove application-process liveness only. |
| `/api/readiness` dependency readiness | `IMPLEMENTED_AND_TESTED` | Route and tests prove bounded configuration, staging identity, and a Supabase `HEAD` probe; they do not prove schema or workflows. |
| Read-only hosted smoke | `VERIFIED_STAGING` | On the 2026-09-08 verified Render deployment `dep-dafimfn9l3cc73c8blog`, deployed application commit `50d02632f4403f3acb5620d6b9a2e482e8ac5688`, the M6 GET/HEAD verifier passed `/api/health` and `/api/readiness` plus `GET /login`, with `HOSTED_MUTATIONS = NONE` and classification `READ_ONLY_HOSTED_CHECK_PASSED`. A separate read-only fetch confirmed the canonical public feed was `[]`, and the publication gate was restored to `CAPSTONE_STAGING_PUBLICATION_ENABLED=false`. This is point-in-time application evidence; later documentation-only repository commits do not by themselves change the deployed application baseline. It is not production, workflow, recovery, monitoring, or human-acceptance evidence. |
| Latest verified hosted application identity | `VERIFIED_STAGING` | Active Render service `capstone-admin-cms-staging-v2` targets branch `main`; the latest verified deployment is `dep-dafimfn9l3cc73c8blog` at deployed application commit `50d02632f4403f3acb5620d6b9a2e482e8ac5688`. The repository and hosted migration manifest at that verification point both contained 52 migrations, latest `20260906120000_public_removal_completion_reconciliation`. This is a separate deployment/release gate from migration-history evidence. |
| Migration manifest and readiness inspection | `VERIFIED_STAGING` | The repository manifest and active staging-v2 migration history both contain 52 migrations, from `20260601035138` through `20260906120000_public_removal_completion_reconciliation`. Historical 46-row and 48/48 observations remain earlier evidence. Alignment must still be rechecked for each release candidate. |
| Exact Gate 4 schema evidence | `VERIFIED_STAGING` | Independent hosted structural evidence matched the 52-migration Gate 4 contract: 44 tables, 514 columns, 387 constraints, 31 policies, 84 application RPC signatures across 83 names, 1 canonical staff-role helper, 4 dispatcher routines, and 4 Storage buckets; differences and validation errors were zero. This remains a separate structural evidence capture and does not prove row contents, Auth customizations, recovery, monitoring, or UAT. |
| Historical staging reconciliation | `DOCUMENTED_ONLY` | The runbook preserves the manual-repair background for the old paused staging instance. Active staging-v2 has separate current history evidence; any future repair consideration requires read-only mismatch evidence and separate authorization. |
| Local database recovery mechanics | `IMPLEMENTED_AND_TESTED` | The bounded verifier owns, backs up, destroys, restores, verifies, and cleans only its synthetic Local schema. |
| Local Storage recovery mechanics | `IMPLEMENTED_AND_TESTED` | The same verifier owns and restores only its synthetic Local bucket and verifies canonical buckets remain untouched. |
| Zero-cost portable database/Storage recovery | `IMPLEMENTED_AND_TESTED` | The repository captures a five-artifact logical database bundle, the two PP1-owned Auth triggers omitted by the standard schema dump, and all four canonical Storage buckets, including the migration-owned `participant-corrections-private` bucket created by Migration 0051. It restores a synthetic PostgreSQL 15 source into a disposable PostgreSQL 17 target, requires both Gate 4 and `MANAGED_SCHEMA_CUSTOMIZATIONS = MATCH`, verifies data/Auth/cost-fence/Storage checksums and application smoke, and cleans only marked resources. The current staging-origin result is recorded separately as bounded `VERIFIED_STAGING` evidence. |
| Public-feed artifact rollback | `IMPLEMENTED_AND_TESTED` | Disposable-Local deployment history rollback is tested. It is not database, Storage, configuration, or hosted disaster recovery. |
| Hosted database backup policy | `INSTITUTION_DEPENDENT` | Provider capability, cadence, retention, encryption/access, owner, and cost are not approved. |
| Hosted database restore rehearsal | `VERIFIED_STAGING` | Current 52-migration staging-origin logical capture and isolated PostgreSQL 17 restore passed with `ZERO_COST_RECOVERY_REHEARSAL_VERIFIED`. This is staging-origin → isolated Local/self-hosted evidence, not managed hosted restore, hosted-to-hosted recovery, or PITR. |
| Hosted Storage backup/restore | `VERIFIED_STAGING` | All four canonical buckets and 57 current objects were captured and restored with configuration/object/checksum verification. `participant-corrections-private` is empty in the actual current source state. This is staging-origin → isolated target evidence, not hosted-to-hosted Storage recovery. |
| Hosted configuration recovery | `DOCUMENTED_ONLY` | Names and categories are inventoried below; values must stay in institution-owned secret/configuration systems. |
| RPO/RTO measurement method | `IMPLEMENTED_AND_TESTED` | `apps/admin-cms/src/recovery/recoveryMeasurement.ts` implements the bounded staging measurement contract with fail-closed evidence validation; its focused tests preserve the canonical RPO/RTO boundaries and reject skipped application-smoke evidence. [Bounded staging recovery RPO/RTO measurement](operations/staging-recovery-rpo-rto-measurement.md) records the claim boundary. No achieved hosted/production result is implied. |
| Hosted RPO/RTO result | `MISSING` | No hosted measurement is recorded; Local timing must not be relabelled. |
| Admin/CMS web deployment procedure | `VERIFIED_STAGING` | The current exact-SHA Render deployment and bounded public smoke are recorded above. Production acceptance, recovery, monitoring, workflow/UAT, and institutional release acceptance remain separate gates. |
| Render web redeploy/rollback rehearsal | `VERIFIED_STAGING` | A genuine staging forward deployment, official Render rollback, and exact-SHA redeployment were completed on 2026-09-03. Application-release timings were 145.2 s forward, 52.7 s rollback, and 145.1 s final redeploy; `/api/health` 200, `/login` 200, `/api/readiness` `READY`, and deployment identity matched at each stage. This is application-release evidence, not database recovery RTO; auto-deploy remained disabled. |
| Repository-owned staging monitoring signal | `VERIFIED_STAGING` | [Zero-Cost Staging Monitoring](operations/zero-cost-staging-monitoring.md) implements a six-hour, cold-start-aware GitHub Actions probe of public `/api/health` and `/api/readiness`. A 2026-09-08 manual workflow run on merged `main` passed after 3/5 attempts. This is a best-effort technical signal, not an SLA, institutional alert-delivery proof, or production monitoring. |
| External monitoring and alert delivery | `INSTITUTION_DEPENDENT` | The repository-owned staging signal now exists, but approved recipients, alert delivery/acknowledgement, retention, escalation route, and any institution-required monitoring provider remain institutional decisions. |
| Workflow regression evidence | `IMPLEMENTED_AND_TESTED` | CI and focused runtime verifiers exist. The integrated release cohort evidence is owned by its separate workstream and is referenced, not duplicated. |
| Incident record and escalation practice | `DOCUMENTED_ONLY` | Contract exists below; no real incident exercise is fabricated. |
| Admin/operator guide | `DOCUMENTED_ONLY` | `docs/admin-operator-guide.md` provides routine operating instructions; real staff acceptance remains pending. |
| Developer handover guide | `DOCUMENTED_ONLY` | `docs/developer-handover-guide.md` provides maintenance and release guidance. |
| Release acceptance checklist | `DOCUMENTED_ONLY` | The canonical unchecked checklist exists; unchecked items remain unmet. |
| Ownership assignments | `INSTITUTION_DEPENDENT` | Roles are defined, but names remain `TBD — STAKEHOLDER DECISION REQUIRED`. |
| KPI-15 routine-task instrument | `DOCUMENTED_ONLY` | The scoring instrument exists; no human result is claimed. |

## Repository-owned evidence command

Run the offline repository check from the repository root:

```bash
npm run check:operational-readiness
npm --silent run check:operational-readiness -- --json
```

It records and validates:

- full Git commit and current branch;
- optional reviewed SHA equality;
- exact migration count, latest identifier, and full manifest equality;
- presence of the M6 runbooks, operator/developer guides, ownership/training instrument, and release checklist;
- release-checklist checkbox status without treating a checked box as independent proof;
- staging target identity as `VERIFIED`, `NOT_CONFIGURED`, or `INVALID` without printing environment values; and
- whether a hosted smoke was not run, passed, or failed.

For an explicitly approved unauthenticated staging observation:

```bash
npm run check:operational-readiness -- --base-url=https://staging.example --expected-commit=<full-40-hex-reviewed-sha>
```

The optional URL inherits the existing hosted-smoke safeguards: HTTPS except explicit loopback fixtures, no credentials/query/fragment, GET/HEAD only, no cookies, same-origin same-route redirects, bounded responses, and bounded timeouts. The M6 report does not print the supplied host or any environment value. It performs no hosted mutation.

Interpretation:

- `REPOSITORY_READY_HOSTED_CHECK_NOT_RUN`: the repository package is coherent; hosted readiness is not claimed.
- `READ_ONLY_HOSTED_CHECK_PASSED`: the bounded public smoke passed for the compared SHA; schema, workflow, recovery, monitoring, and UAT are still separate gates.
- `READ_ONLY_HOSTED_CHECK_FAILED`: the public hosted evidence failed closed.
- `REPOSITORY_EVIDENCE_INCOMPLETE`: source identity, manifest, document, or checklist-template evidence is incomplete.

## Exact Gate 4 schema evidence command

First prove that the evidence query and current migration manifest compose on a disposable Local Supabase stack:

```bash
npm run verify:gate4-schema-evidence:disposable
```

For hosted acceptance, an authorized operator executes the single SELECT in
[`infra/supabase/gate4-schema-evidence.sql`](../infra/supabase/gate4-schema-evidence.sql)
against the intended database and saves the one returned `gate4_evidence` JSON value without
editing it. The query reads only `pg_catalog`, `storage.buckets`, and
`supabase_migrations.schema_migrations`; it does not read application rows, Auth identities, or
Storage object names and does not invoke any application RPC. Compare that file from a checkout of
the exact reviewed commit:

```bash
npm run check:gate4-schema-evidence -- --evidence-file=<snapshot.json> --expected-git-sha=<full-40-hex-reviewed-sha>
npm --silent run check:gate4-schema-evidence -- --evidence-file=<snapshot.json> --expected-git-sha=<full-40-hex-reviewed-sha> --machine-readable
```

`GATE4_MATCH` proves that the hosted structural evidence exactly matches the fully migrated Local
catalog for that checkout across the covered dimensions. `GATE4_DRIFT` identifies bounded,
category-level differences. `EVIDENCE_INVALID` means the snapshot is malformed, incomplete, or
ambiguous and must never be treated as green. The output records the exact repository SHA used for
the comparison, and the command rejects tracked staged or unstaged changes so that SHA identifies
the actual query and comparison source. Migration-history equality alone is insufficient because it cannot prove the final
columns, constraints, RLS/policies, grants, function overloads/security modes, or bucket settings.

A match does not prove row contents, Auth users, Storage object completeness, application workflow
behavior, backup/restore, monitoring, deployment identity, or UAT. It does not authorize migration
application, migration-history repair, data changes, Storage changes, deployment, or any other
hosted mutation.

## Releasable build contract

A release candidate is eligible for supervised deployment only when every applicable Source, Database, Application, Core workflow, Security, Recovery, Monitoring, Documentation, and Handover item in [the M6 release checklist](m6-release-acceptance-checklist.md) has evidence. Repository readiness alone is not release acceptance.

The minimum identity chain is:

```text
reviewed pull-request SHA
→ green CI on that exact SHA
→ Render deploy of that exact SHA
→ /api/readiness deploymentCommit.value equals that SHA
→ repository and readiness migration expectations match
→ governed hosted migration/schema evidence
→ post-deploy smoke and supervised acceptance
```

A branch name, “latest”, a short SHA, deployment success, or HTTP 200 alone is not sufficient.

## Backup and restore scope

### Database

Protect the complete hosted Supabase/PostgreSQL state required to reconstruct the Admin/CMS, including:

- all application tables, relationships, audit/history ledgers, immutable publication ledgers, operational recovery state, and configuration stored in the database;
- Supabase Auth identities and provider-owned Auth state where the selected backup mechanism supports it;
- Storage metadata tables needed to relate object keys, buckets, and application records;
- migration history and the exact reviewed repository migration manifest; and
- database roles, grants, functions, triggers, constraints, RLS policies, and extensions needed by the application.

No provider backup feature is assumed until an authorized operator verifies it. The institution must decide and record:

| Decision | Current status |
| --- | --- |
| Backup mechanism and plan capability | `INSTITUTION_DECISION_REQUIRED` |
| Cadence and acceptable data-loss window | `INSTITUTION_DECISION_REQUIRED` |
| Retention and deletion policy | `INSTITUTION_DECISION_REQUIRED` |
| Encryption at rest/in transit and access roles | `INSTITUTION_DECISION_REQUIRED` |
| Isolated restore target and cost authority | `INSTITUTION_DECISION_REQUIRED` |
| Backup owner and backup technical owner | `TBD — STAKEHOLDER DECISION REQUIRED` |

Restore rehearsals should target a new isolated, non-production project unless the institution approves another safe target. Do not overwrite the source environment merely to demonstrate recovery. Verification must include migration history, required objects and grants, bounded integrity queries, Auth/Storage availability where included, application readiness, login surface, and the agreed workflow smoke. A backup existing is not restoration evidence.

### Storage

The canonical bucket roles are:

| Bucket | Role | Recovery requirement |
| --- | --- | --- |
| `project-drafts-private` | Private draft uploads and participant package artifacts | Preserve exact object bytes, private access, bucket configuration, content type, size, checksum, object key, and application linkage. Never publish these objects as a recovery shortcut. |
| `project-public-assets` | Approved public poster and snapshot assets | Preserve exact public object keys/bytes, bucket configuration, checksums, metadata, and database relationships. |
| `public-feeds` | Stable schema-validated public-feed artifacts | Preserve exact feed bytes, object metadata, version/head evidence, and linkage to the public deployment ledger. Storage alone does not reconstruct lifecycle truth. |

A hosted Storage backup manifest must record, without credentials or signed URLs:

- environment and bucket role;
- object key, byte length, content type, checksum, and last-modified/version evidence available from the provider;
- bucket privacy/public configuration and allowed content/size policy;
- corresponding database media/deployment identity where applicable; and
- backup time, operator role, mechanism, and retained evidence reference.

Restore verification compares the complete expected object set and checksums. Missing or extra objects are deviations. Draft/private assets, public assets, feeds, database rows, bucket metadata, or publication ledgers must never be silently deleted to make a rehearsal pass.

### Configuration inventory (names and categories only)

Store values only in institution-owned systems. The repository records names, not values.

| Category | Required recovery inventory |
| --- | --- |
| Render Admin/CMS web service | Repository, approved source branch policy, root directory, install/build/start commands, health route, region/plan/scale, deploy mode, custom domains, service owner, and environment variable names. |
| Core Supabase connection | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` or legacy `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SECRET_KEY` or temporary legacy `SUPABASE_SERVICE_ROLE_KEY`. |
| Runtime identity | `CAPSTONE_RUNTIME_ENV`, `CAPSTONE_EXPECTED_SUPABASE_HOST`, `CAPSTONE_STAGING_MUTATION_CONFIRMATION`, `RENDER_GIT_COMMIT`, `RENDER_EXTERNAL_URL`. |
| Application security | `CAPSTONE_AUTH_FLOW_SECRET`; credential ownership, rotation date, and recovery owner without storing the value. |
| Storage | `SUPABASE_DRAFT_BUCKET`, `SUPABASE_PUBLIC_ASSETS_BUCKET`, `SUPABASE_PUBLIC_FEEDS_BUCKET`, `SUPABASE_PUBLIC_FEED_FILE`. |
| Participant email | `PARTICIPANT_PREVIEW_EMAIL_ENABLED`, `PARTICIPANT_PREVIEW_EMAIL_SMTP_HOST`, `PARTICIPANT_PREVIEW_EMAIL_SMTP_PORT`, `PARTICIPANT_PREVIEW_EMAIL_SMTP_SECURE`, `PARTICIPANT_PREVIEW_EMAIL_SMTP_USER`, `PARTICIPANT_PREVIEW_EMAIL_SMTP_PASSWORD`, `PARTICIPANT_PREVIEW_EMAIL_FROM`, `PARTICIPANT_PREVIEW_REMINDERS_ENABLED`; provider and policy remain institution-dependent. |
| Staff/publication feature gates | `STAFF_PROVISIONING_ENABLED`, `CAPSTONE_STAGING_PUBLICATION_ENABLED`; both remain fail-closed unless the exact target/authority contract also passes. |
| Publication/Duda | Canonical feed bucket/path variables above, Duda test/live consumer boundary, and the institution-owned location of Duda configuration. No Duda credential belongs in the repository. |
| Optional assistive extraction | `GEMINI_ASSISTIVE_EXTRACTION_ENABLED`, `GEMINI_API_KEY`, `GEMINI_MODEL`; institutional vendor/privacy/cost approval remains required. |
| Assistive worker | `CAPSTONE_ASSISTIVE_HOSTED_EXECUTION_ENABLED`, `CAPSTONE_ASSISTIVE_SUPABASE_URL`, `CAPSTONE_ASSISTIVE_PADDLE_MODELS_DIR`, `CAPSTONE_ASSISTIVE_LANGUAGETOOL_ARCHIVE`, `CAPSTONE_ASSISTIVE_LANGUAGETOOL_JAR`, `CAPSTONE_EXPECTED_SUPABASE_HOST`, `SUPABASE_SECRET_KEY`, `RENDER_INSTANCE_ID`, `RENDER_GIT_COMMIT`; also preserve Blueprint/service identity and heartbeat ownership. |
| DNS/custom domains | Registrar/DNS owner, zone, public hostname, TLS ownership/renewal, validation records, and recovery contact. `INSTITUTION_DECISION_REQUIRED` until assigned. |

Do not place secret values, private dashboard URLs, signed URLs, user identities, or credential screenshots in Git, release checklists, logs, issues, or training evidence.

## Recovery evidence procedure

### Local mechanics

Follow [System Recovery Readiness](system-recovery-readiness.md) for the bounded legacy probe. Use
[Zero-Cost Hosted-Origin Recovery Rehearsal](operations/zero-cost-recovery-rehearsal.md) for the
complete logical database/Storage bundle and disposable restore workflow. A synthetic passing run is
labelled:

```text
ZERO_COST_RECOVERY_REHEARSAL_VERIFIED
VERIFIED_STAGING: staging-origin → isolated Local/self-hosted PostgreSQL 17
```

The current-52 capture and isolated restore are recorded in [Current-52 Recovery
Evidence — 2026-09-08](m6-current52-recovery-evidence-2026-09-08.md). This bounded
result does not prove managed hosted PITR, hosted-to-hosted restoration, or
production recovery.

Local duration and backup age may be recorded as `LOCAL`, but never reported as hosted RPO/RTO.

### Supervised hosted rehearsal

An authorized recovery lead should perform this later in an approved change window:

1. Record source release, source environment, selected backup mechanism, backup timestamp, declared scenario, owners, and authorization reference.
2. Create or select the approved isolated restore target and confirm it cannot affect Prototype, staging source, production, Duda, or public DNS.
3. Restore database/Auth scope supported by the verified mechanism.
4. Restore each canonical Storage role and its metadata from the matching recovery point.
5. restore configuration through institution-owned systems without copying values into evidence;
6. compare migration history and schema evidence with the exact source release;
7. deploy the compatible reviewed application commit to the isolated target;
8. run health, readiness, login, integrity, schema/grant, and agreed synthetic workflow smoke checks;
9. record RPO/RTO, deviations, and evidence references; and
10. destroy or retain the isolated target only under the approved retention/change record.

Until a separately authorized hosted-to-hosted or managed-provider rehearsal
satisfies the full contract, record `SUPERVISED_HOSTED_REHEARSAL_REQUIRED` for
that broader claim. The current bounded staging-origin → isolated result is
already recorded as `VERIFIED_STAGING`.

## RPO and RTO measurement contract

Use UTC ISO 8601 timestamps from an agreed authoritative clock.

- **Measured RPO** = `failure start − newest successfully restored recoverable backup timestamp`. It is the observed recoverable data-loss window for that scenario and mechanism, not a marketing target.
- **Measured RTO** = `application smoke completion − recovery start`. Recovery is not complete when a restore command finishes; it is complete when the agreed post-restore smoke passes.

The executable bounded measurement contract is in `apps/admin-cms/src/recovery/recoveryMeasurement.ts` and is described in [Bounded staging recovery RPO/RTO measurement](operations/staging-recovery-rpo-rto-measurement.md). It requires an authoritative complete-recovery-set watermark, recovery-start/service-acceptance timestamps, explicit evidence that the application-smoke contract matched, and a final `ZERO_COST_RECOVERY_REHEARSAL_VERIFIED` classification. The existing 2026-09-08 capture/restore/verifier durations do not satisfy that evidence contract and remain operational timings only; no achieved RPO/RTO is recorded from them.

If exact last-write evidence exists, also record the newest restored application write and calculate the observed write-loss interval. If the provider exposes only backup time, state that limitation. Do not round down or substitute a plan-advertised value for a measurement.

### RPO/RTO evidence template

| Field | Recorded value |
| --- | --- |
| Scenario |  |
| Evidence classification (`LOCAL` / `STAGING` / `PRODUCTION`) |  |
| Source release (full SHA) |  |
| Target environment |  |
| Failure start (UTC) |  |
| Recovery start (UTC) |  |
| Backup timestamp / recovery point (UTC) |  |
| Newest restored application write, if measurable (UTC) |  |
| Database restore completion (UTC) |  |
| Storage restore completion (UTC) |  |
| Application smoke completion (UTC) |  |
| Measured RPO |  |
| Measured RTO |  |
| Verification checks and exact results |  |
| Deviations / excluded provider scope |  |
| Operator role |  |
| Independent reviewer role |  |
| Evidence references |  |

## Monitoring and incident contract

The repository now has a bounded zero-cost staging signal in [Zero-Cost Staging Monitoring](operations/zero-cost-staging-monitoring.md): a six-hour GitHub Actions check with bounded cold-start convergence. Its 2026-09-08 manual merged-`main` run passed after 3/5 attempts. GitHub scheduling remains best-effort and the workflow does not prove recipient delivery, acknowledgement, retention, escalation, production monitoring, or an SLA.

The table below remains the proposed institution-level operating target, not a claim that an external service is configured or that the current six-hour free-tier signal meets the proposed one-minute cadence.

| Signal | What it proves | Proposed check | Alert threshold | Recovery confirmation |
| --- | --- | --- | --- | --- |
| Liveness `/api/health` | Next.js route execution only | GET/HEAD every 60 seconds, 5-second timeout | 3 consecutive failures → Severity 2 | 3 consecutive successes plus readiness check |
| Readiness `/api/readiness` | Configuration, staging identity, and bounded Supabase reachability | GET/HEAD every 60 seconds, 5-second timeout | 2 consecutive 503/timeouts → Severity 1; malformed response → Severity 1 | 3 consecutive exact-contract successes and dependency reachable |
| Deployment identity | Reviewed SHA equals valid deployed SHA | M6/hosted smoke after every deploy and rollback | Any missing/invalid/mismatch → Severity 1, block acceptance | Exact SHA match plus clean smoke |
| Schema/migration alignment | Hosted history/schema matches reviewed repository | Before deployment and after any authorized migration | Any missing, unexpected, or unverified required evidence → block deployment; Severity 1 if service already changed | Governed Gate 3/4 evidence plus readiness/smoke |
| Workflow behavior | Core staff lifecycle still works | CI on every commit; supervised synthetic workflow smoke per release | Any blocking regression → Severity 2 before release, Severity 1 if released workflow unavailable | Focused regression passes and supervised workflow recheck |
| Assistive worker availability | Compatible worker heartbeat is fresh | Existing 15-second heartbeat / 60-second freshness contract | Admin enqueue unavailable or stale; escalate per feature criticality | Fresh compatible heartbeat and bounded capability check |

Severity guidance:

- **Severity 1 — release/service blocking:** readiness dependency failure, deployment identity mismatch, suspected data loss/corruption, unauthorized public exposure, schema drift after deployment, or recovery required. Notify the recovery lead, deployment authority, Supabase administrator, and incident escalation contact immediately through the institution-approved route.
- **Severity 2 — degraded workflow:** liveness instability, a core routine workflow unavailable, or repeated controlled-operation failure without evidence of data loss. Notify the technical owner and monitoring recipient within the agreed support window.
- **Severity 3 — warning/follow-up:** single transient failure, documentation drift, or non-critical optional capability unavailable. Record and review in the next operating period.

The monitoring provider, notification channel, support hours, recipients, and retention are `INSTITUTION_DECISION_REQUIRED`. Proposed minimum evidence is monitor configuration version, check timestamp, endpoint class (not private URL), status, duration, consecutive-failure count, alert/recovery event, deployment SHA, owner, and incident reference. A provisional 90-day availability/alert retention is suggested for stakeholder decision; no retention claim applies until approved and configured.

Do not include response bodies, headers, tokens, cookies, query strings, user identities, or private URLs in monitoring evidence. A public HTTP check does not replace authenticated workflow monitoring.

## Render Admin/CMS deployment and rollback runbook

The authoritative application contract is in [Admin/CMS Hosted Staging Deployment](admin-cms-hosted-deployment.md): repository root, `npm ci`, `npm run build:admin`, `npm run start --workspace=apps/admin-cms`, and Render health path `/api/readiness`. There is no tracked Render Blueprint: the paid assistive background worker is withdrawn and assistive execution is governed by [Zero-Cost Assistive Executor](operations/zero-cost-assistive-executor.md).

### Pre-deploy gates

1. Record the exact reviewed full SHA, source branch, approval, and clean CI for that SHA.
2. Run `npm run check:operational-readiness -- --expected-commit=<sha>`.
3. Record hosted migration history/schema evidence against the exact reviewed 52-file manifest; do not infer applied migrations from `/api/readiness`.
4. Confirm backup/recovery evidence required by the change and the last known good release.
5. Confirm environment variable **names**, target identity, secret ownership, and rotation status without exposing values.
6. Confirm the Render web service uses the Admin/CMS root/commands and `/api/readiness`, not the Prototype service.
7. Confirm the deployment authority, rollback decision owner, monitoring recipient, and change window.

### Deploy and post-deploy evidence

An authorized Render operator selects the exact reviewed commit and records the Render deployment identifier/event reference. After the service becomes ready, run the read-only M6 command with the public staging base URL and exact SHA, then complete governed schema evidence and the release checklist. Deployment success alone is not acceptance.

### Last known good release

Record a release as last known good only when it has full SHA, approval/CI, compatible migration baseline, prior deployment identifier, successful exact-SHA hosted smoke, applicable workflow/UAT evidence, and no open Severity 1 recovery condition. Keep the evidence reference outside secrets and dashboards.

### Controlled redeploy or rollback

Only an authorized Render operator may execute this later:

1. Open an incident/change record and preserve the failing release SHA and evidence.
2. Decide whether a same-SHA redeploy addresses a build/runtime fault or whether the recorded last known good SHA is required.
3. Confirm database compatibility. Never roll application code back across an incompatible forward-only schema change.
4. Select the exact target SHA in Render; do not use an unverified branch head or “latest”.
5. Redeploy without changing secrets, DNS, Supabase, Duda, or environment values unless separately authorized.
6. Verify `/api/health`, `/api/readiness`, deployed SHA, migration expectation, login, schema evidence, monitoring recovery, and applicable workflow smoke.
7. Record outcome, timestamps, operator/reviewer roles, deviations, and evidence references.

Application rollback is insufficient when data is corrupt/missing, Storage bytes or metadata are lost, an incompatible migration changed schema/data, credentials/configuration are lost, DNS/TLS is wrong, or Duda/public-feed state requires its own governed recovery. In those cases stop and invoke the relevant database, Storage, configuration, or integration recovery plan.

### Historical staging application-release rehearsal — 2026-09-03

The supervised staging rehearsal proved exact-SHA forward deployment, official
Render rollback, exact-SHA redeployment, `/api/health` 200, `/login` 200,
`/api/readiness` `READY`, and deployment identity matched at every stage.
Timings were 145.2 s forward, 52.7 s rollback, and 145.1 s final redeploy;
auto-deploy remained disabled. This is `VERIFIED_STAGING` application-release
evidence only, not database recovery RTO.

### Hosted rehearsal evidence checklist

- [ ] Exact source and target SHA recorded.
- [ ] Authorized operator and independent reviewer roles recorded.
- [ ] Last known good release evidence recorded.
- [ ] Database compatibility decision recorded.
- [ ] Render deployment/redeploy/rollback event reference recorded.
- [ ] `/api/health`, `/api/readiness`, and deployment identity passed.
- [ ] Migration/schema evidence passed independently of HTTP readiness.
- [ ] Login and agreed synthetic workflow smoke passed.
- [ ] Monitoring alert and recovery delivery observed.
- [ ] Start, ready, and smoke-complete timestamps recorded.
- [ ] Deviations and incident/change record recorded.

Unchecked means `SUPERVISED_HOSTED_REHEARSAL_REQUIRED`.

## Evidence retention and acceptance

Store completed evidence in the institution-approved project record or release artifact location, not in secret-bearing screenshots or local environment files. Every evidence item needs environment, full SHA, timestamp, operator role, result, and reference. Independent review should verify the evidence before KPI status changes.

- **KPI-14 can use this package to prove:** repository readiness checks exist; a bounded read-only hosted smoke verified staging deployment `dep-dafimfn9l3cc73c8blog` at application commit `50d02632f4403f3acb5620d6b9a2e482e8ac5688`; current 52-migration staging-origin → isolated PostgreSQL 17 recovery is `VERIFIED_STAGING`; the four-bucket/57-object Storage recovery surface, Auth, Gate 4, cleanup, and bundle-preservation evidence are recorded; the bounded RPO/RTO measurement method is implemented/tested without claiming an achieved result; the repository-owned zero-cost staging monitoring signal has a successful merged-`main` run; and the 2026-09-03 Render application-release rehearsal is `VERIFIED_STAGING`.
- **KPI-14 cannot yet claim:** managed hosted PITR, hosted-to-hosted restoration, production acceptance/recovery/SLA, operational external monitoring/alert routing, approved backup ownership/policy, or formal hosted/production RPO/RTO.
- **KPI-15 can use this package to prove:** operator/developer documentation, an ownership template, a canonical release checklist, and an unaided routine-task measurement instrument exist.
- **KPI-15 cannot yet claim:** named institutional ownership, credential transfer, completed training, at least 80% human unaided completion, or stakeholder sign-off.

The exact next supervised actions are: assign owners; approve backup/retention/monitoring policy; retain or recapture release-specific migration/schema evidence when the schema changes; capture a qualifying RPO/RTO measurement with the required authoritative timestamps and smoke evidence; satisfy any managed hosted or hosted-to-hosted recovery requirement; activate and test alert routing; run staff documentation-based training; and obtain independent sign-off.
