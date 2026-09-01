# M6 Operational Readiness and Recovery Contract

This document is the canonical PP1 M6 operational-readiness contract for the active Admin/CMS. It defines what the repository can prove now, what a supervised hosted rehearsal must prove later, and which decisions remain with the institution. It does not authorize a deployment, hosted mutation, restore, rollback, DNS change, Duda change, email, or secret access.

Executable application code, migrations, and tests on the reviewed commit remain the source of truth. The current package contains 48 migration files ending at `20260831090000_postgres17_maintain_privilege_alignment`; `npm run check:operational-readiness` verifies that exact manifest and fails closed when it changes unexpectedly.

## Evidence vocabulary

Every capability in this package uses exactly one status:

| Status | Meaning |
| --- | --- |
| `IMPLEMENTED_AND_TESTED` | Repository code exists and automated tests exercise the stated boundary. It is not automatically hosted proof. |
| `IMPLEMENTED_BUT_NOT_OPERATIONALLY_VERIFIED` | Code exists, but the required current hosted or supervised evidence has not been recorded. |
| `DOCUMENTED_ONLY` | A controlled procedure or template exists, but it has not been rehearsed. |
| `INSTITUTION_DEPENDENT` | An institutional owner, policy, account, provider, credential, or approval is required. |
| `MISSING` | No acceptable current evidence exists. |

`LOCAL`, `STAGING`, and `PRODUCTION` evidence are never interchangeable. `PROCEDURE DEFINED` is not `REHEARSAL PASSED`.

## Current M6 / KPI-14 / KPI-15 gap matrix

| Capability | Status | Current evidence and remaining gap |
| --- | --- | --- |
| Repository release identity | `IMPLEMENTED_AND_TESTED` | The M6 checker records the full checkout SHA and optionally compares it with a separately reviewed SHA. |
| `/api/health` liveness | `IMPLEMENTED_AND_TESTED` | Route and contract tests prove application-process liveness only. |
| `/api/readiness` dependency readiness | `IMPLEMENTED_AND_TESTED` | Route and tests prove bounded configuration, staging identity, and a Supabase `HEAD` probe; they do not prove schema or workflows. |
| Read-only hosted smoke | `IMPLEMENTED_AND_TESTED` | The existing verifier checks health, readiness, login, deployment SHA, redirects, timeouts, and migration expectation using GET/HEAD only. A current accepted hosted run is not recorded by this change. |
| Current hosted deployment identity | `IMPLEMENTED_BUT_NOT_OPERATIONALLY_VERIFIED` | Render can expose a valid `RENDER_GIT_COMMIT`; the exact reviewed-versus-deployed comparison still needs a supervised run. This is a separate deployment/release gate from migration-history evidence. |
| Migration manifest and readiness inspection | `IMPLEMENTED_AND_TESTED` | The repository manifest has 48 migrations. Active staging-v2 has point-in-time evidence of 48/48 tracked rows from `20260601035138` through `20260831090000_postgres17_maintain_privilege_alignment`. Migration alignment remains independently re-verifiable for each release candidate; this evidence does not establish that the exact latest `main` SHA is deployed. |
| Exact Gate 4 schema evidence | `IMPLEMENTED_AND_TESTED` | A repository-owned SELECT-only catalog snapshot and fail-closed comparator cover exact tables, columns, constraints, RLS/policies, schema/table grants, exposed and non-public routines, relevant roles, and canonical bucket configuration. Reviewed hosted structural schema/grant/RPC evidence completed against the 48/48 staging-v2 migration state; Migration 0048 removed only the unintended PostgreSQL 17 `MAINTAIN` grants. This does not prove latest-`main` deployment identity, row contents, Auth customizations, recovery, monitoring, or UAT. |
| Historical staging reconciliation | `DOCUMENTED_ONLY` | The runbook preserves the manual-repair background for the old paused staging instance. Active staging-v2 has separate current history evidence; any future repair consideration requires read-only mismatch evidence and separate authorization. |
| Local database recovery mechanics | `IMPLEMENTED_AND_TESTED` | The bounded verifier owns, backs up, destroys, restores, verifies, and cleans only its synthetic Local schema. |
| Local Storage recovery mechanics | `IMPLEMENTED_AND_TESTED` | The same verifier owns and restores only its synthetic Local bucket and verifies canonical buckets remain untouched. |
| Zero-cost portable database/Storage recovery | `IMPLEMENTED_AND_TESTED` | The repository captures a five-artifact logical database bundle, the two PP1-owned Auth triggers omitted by the standard schema dump, and all three Storage buckets. It restores a synthetic PostgreSQL 15 source into a disposable PostgreSQL 17 target, requires both Gate 4 and `MANAGED_SCHEMA_CUSTOMIZATIONS = MATCH`, verifies data/Auth/cost-fence/Storage checksums and application smoke, and cleans only marked resources. Real hosted-origin capture remains separately authorized and unexecuted. |
| Public-feed artifact rollback | `IMPLEMENTED_AND_TESTED` | Disposable-Local deployment history rollback is tested. It is not database, Storage, configuration, or hosted disaster recovery. |
| Hosted database backup policy | `INSTITUTION_DEPENDENT` | Provider capability, cadence, retention, encryption/access, owner, and cost are not approved. |
| Hosted database restore rehearsal | `IMPLEMENTED_BUT_NOT_OPERATIONALLY_VERIFIED` | The zero-cost logical restore path is implemented and passes a complete synthetic disposable rehearsal. An authorized read-only staging-origin capture and independent isolated restore are still required. |
| Hosted Storage backup/restore | `IMPLEMENTED_BUT_NOT_OPERATIONALLY_VERIFIED` | The three canonical buckets are captured and restored through Storage API with exact object/config/checksum verification in the synthetic rehearsal. No real hosted object was accessed by this change. |
| Hosted configuration recovery | `DOCUMENTED_ONLY` | Names and categories are inventoried below; values must stay in institution-owned secret/configuration systems. |
| RPO/RTO measurement method | `DOCUMENTED_ONLY` | The measurement contract and template exist below. |
| Hosted RPO/RTO result | `MISSING` | No hosted measurement is recorded; Local timing must not be relabelled. |
| Admin/CMS web deployment procedure | `DOCUMENTED_ONLY` | Install/build/start/health and evidence gates are defined. No current Admin/CMS deployment completion is claimed. |
| Render web redeploy/rollback rehearsal | `DOCUMENTED_ONLY` | Procedure and future evidence checklist exist; no rollback was executed in this change. |
| External monitoring and alert delivery | `INSTITUTION_DEPENDENT` | Signals and thresholds are defined, but provider, recipients, retention, and escalation route need institutional decisions. |
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
REAL_HOSTED_ORIGIN_CAPTURE_NOT_YET_EXECUTED
```

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

Until that procedure is completed and independently reviewed, record `SUPERVISED_HOSTED_REHEARSAL_REQUIRED`.

## RPO and RTO measurement contract

Use UTC ISO 8601 timestamps from an agreed authoritative clock.

- **Measured RPO** = `failure start − newest successfully restored recoverable backup timestamp`. It is the observed recoverable data-loss window for that scenario and mechanism, not a marketing target.
- **Measured RTO** = `application smoke completion − recovery start`. Recovery is not complete when a restore command finishes; it is complete when the agreed post-restore smoke passes.

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

These are initial proposed operating checks, not evidence that an external service is configured.

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
3. Record hosted migration history/schema evidence against the exact 48-file manifest; do not infer applied migrations from `/api/readiness`.
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

- **KPI-14 can use this package to prove:** repository readiness checks exist; Local recovery mechanics are bounded and reproducible; deployment/recovery/monitoring contracts and acceptance evidence requirements are defined.
- **KPI-14 cannot yet claim:** completed Admin/CMS hosted deployment, hosted backup restoration, Render rollback rehearsal, operational external monitoring/alert routing, or hosted RPO/RTO.
- **KPI-15 can use this package to prove:** operator/developer documentation, an ownership template, a canonical release checklist, and an unaided routine-task measurement instrument exist.
- **KPI-15 cannot yet claim:** named institutional ownership, credential transfer, completed training, at least 80% human unaided completion, or stakeholder sign-off.

The exact next supervised actions are: assign owners; approve backup/retention/monitoring policy; capture a current exact-SHA deployment and smoke; recheck active staging-v2 migration alignment and exact schema/grant/RPC evidence; perform isolated database and Storage restore; rehearse Render redeploy/rollback; activate and test alert routing; run staff documentation-based training; and obtain independent sign-off.
