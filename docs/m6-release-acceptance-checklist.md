# M6 Release Acceptance Checklist

Use one copy per candidate release. Leave every item unchecked until its stated evidence exists and has been reviewed. A checked box is an index entry, not proof by itself; record an immutable CI, release, change, run, or signed evidence reference. Never paste secrets, environment values, private URLs, user identities, tokens, or credential screenshots.

## Release record

| Field | Value |
| --- | --- |
| Candidate full Git SHA |  |
| Source branch |  |
| Pull request / approval reference |  |
| Target environment |  |
| Planned deployment window (UTC) |  |
| Release owner role |  |
| Independent reviewer role |  |
| Final classification (`ACCEPTED` / `REJECTED` / `INCOMPLETE`) | `INCOMPLETE` |

## Source

- [ ] Exact reviewed 40-character Git SHA is recorded. Evidence: ____
- [ ] Source branch and pull-request approval are recorded. Evidence: ____
- [ ] Required CI jobs passed on that exact SHA. Evidence: ____
- [ ] `npm run check:operational-readiness -- --expected-commit=<sha>` passed. Evidence: ____
- [ ] No unreviewed local or generated files are included. Evidence: ____

## Database

- [ ] Repository migration count/latest/full manifest match the candidate. Evidence: ____
- [ ] Hosted migration history was inspected and compared with the candidate. Evidence: ____
- [ ] Exact required tables, functions, constraints, grants, RLS, Auth foundation, and Storage buckets were verified through the governed reconciliation gates. Evidence: ____
- [ ] No unexpected migration or schema drift remains. Evidence: ____
- [ ] Any database change has an approved forward migration and compatible application deployment order. Evidence: ____

## Application

- [ ] `npm run build:admin` passed on the candidate. Evidence: ____
- [ ] Render deployed the exact reviewed SHA. Evidence: ____
- [ ] `/api/health` exact liveness contract passed. Evidence: ____
- [ ] `/api/readiness` exact dependency contract passed. Evidence: ____
- [ ] Readiness `deploymentCommit` equals the reviewed SHA. Evidence: ____
- [ ] `/login` returned the expected HTML surface. Evidence: ____
- [ ] Post-deploy hosted smoke passed without credentials or mutation. Evidence: ____

## Zero-cost assistive execution

- [ ] `npm run check:zero-cost` passed on the candidate. Evidence: ____
- [ ] One execution profile is chosen and recorded: zero-cost on-demand executor, or School-owned continuous worker. Evidence: ____
- [ ] No paid background worker, dedicated workload profile, paid log workspace, paid registry, or paid network component was introduced. Evidence: ____
- [ ] Both executor images are pinned by immutable digest, and the deployed digests match the registration. Evidence: ____
- [ ] The executor was registered for the exact reviewed commit and image digest. Evidence: ____
- [ ] The dispatcher authenticates as the dedicated least-privilege database role and holds no server secret key. Evidence: ____
- [ ] The launch ceiling of 40 starts per rolling 31-day window is enforced by database constraint on the target. Evidence: ____
- [ ] Assistive unavailability was demonstrated not to block import, review, approval, or publication. Evidence: ____
- [ ] End-to-end assistive latency was measured and compared with the PP1 p95 target, or the profile is explicitly recorded as not yet accepted. Evidence: ____
- [ ] Third-party redistribution position is settled before any image is published publicly. Evidence: ____

## Core workflow

Reference the integrated workflow evidence; do not create a competing release-scale harness.

- [ ] Import preview, selection, metadata staging, media staging, and completed batch evidence passed. Evidence: ____
- [ ] Blocking validation and warning acknowledgement behaved as documented. Evidence: ____
- [ ] Submit-for-review and review action evidence passed. Evidence: ____
- [ ] Participant preview, confirmation/correction, and controlled reissue evidence passed. Evidence: ____
- [ ] Publication preparation and authorized environment-scoped publication evidence passed. Evidence: ____
- [ ] Archive/unpublish and publishing-history evidence passed. Evidence: ____
- [ ] Any environment-specific exclusion is explicitly recorded. Evidence: ____

## Security

- [ ] Denied-access and role-permission evidence passed. Evidence: ____
- [ ] Private draft assets and public assets/feed remained separated. Evidence: ____
- [ ] Public payload review found no administrative/private fields. Evidence: ____
- [ ] Secret-name/value review found no committed or logged values. Evidence: ____
- [ ] Target identity and same-origin mutation controls passed. Evidence: ____
- [ ] No real participant/staff data was used in testing. Evidence: ____

## Recovery

- [ ] Backup mechanism, cadence, retention, access, and owner are approved for the target environment. Evidence: ____
- [ ] A backup covering the release recovery scope exists. Evidence: ____
- [ ] Database restore was demonstrated in an approved isolated target. Evidence: ____
- [ ] All canonical Storage roles and metadata were restored and checksum-verified. Evidence: ____
- [ ] Post-restore schema, readiness, login, and workflow smoke passed. Evidence: ____
- [ ] Render redeploy/rollback was rehearsed against an exact recorded release. Evidence: ____
- [ ] Measured RPO and RTO were calculated from timestamps and labelled by environment. Evidence: ____
- [ ] Local recovery evidence, when cited, is labelled `LOCAL_RECOVERY_MECHANICS_VERIFIED` and not hosted recovery. Evidence: ____

## Monitoring

- [ ] Liveness and readiness checks are active at the approved cadence/timeout. Evidence: ____
- [ ] Deployment identity is checked after deploy and rollback. Evidence: ____
- [ ] Failure thresholds and recovery confirmation are configured. Evidence: ____
- [ ] Alert delivery reached the approved monitoring recipient. Evidence: ____
- [ ] Severity/escalation route and incident owner are known. Evidence: ____
- [ ] Monitoring/incident evidence retention is approved and active. Evidence: ____

## Documentation

- [ ] [Admin/operator guide](admin-operator-guide.md) matches the candidate behavior. Evidence: ____
- [ ] [Developer handover guide](developer-handover-guide.md) matches the candidate architecture and commands. Evidence: ____
- [ ] [M6 operational readiness contract](m6-operational-readiness.md) and recovery runbook are current. Evidence: ____
- [ ] Deployment/redeployment/rollback procedure is current. Evidence: ____
- [ ] Known limitations and institution-dependent gaps are recorded truthfully. Evidence: ____

## Handover

- [ ] Primary and backup owners are named for every mandatory responsibility. Evidence: ____
- [ ] Credential ownership location/policy is institution-controlled and recorded without values. Evidence: ____
- [ ] Deployment, Supabase, Storage, Duda, staff-account, monitoring, and recovery authority are transferred. Evidence: ____
- [ ] Escalation route and support window are accepted. Evidence: ____
- [ ] Documentation-based routine-task training was completed. Evidence: ____
- [ ] Unaided routine-task completion is at least 80%. Evidence: ____
- [ ] Administrator, technical owner, and institutional sponsor sign-off are recorded. Evidence: ____

## KPI decision

KPI-14 remains `NOT PASSED` unless deployment, hosted backup restoration, Render rollback/redeploy, monitoring/alert routing, and RPO/RTO evidence above are checked with reviewed references.

KPI-15 remains `NOT PASSED` unless current Admin/developer documentation, real training evidence with at least 80% unaided routine-task completion, named ownership transfer, and stakeholder sign-off are checked with reviewed references.

| Decision | Role | Date (UTC) | Evidence/sign-off reference |
| --- | --- | --- | --- |
| Release owner recommendation |  |  |  |
| Independent technical review |  |  |  |
| Institutional acceptance |  |  |  |
