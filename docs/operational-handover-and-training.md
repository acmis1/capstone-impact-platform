# Operational Ownership, Handover, and Training Acceptance

This document is the KPI-15 handover instrument. It defines role ownership and a documentation-based routine-task test. It contains no credential values and records no fabricated human result.

## Ownership principles

- Use institution-controlled role accounts/aliases and approved identity governance. Do not make continued operation depend on a participant’s personal account.
- Record credential **ownership location/policy**, recovery authority, and rotation process without recording values.
- Assign a primary and backup owner for every mandatory responsibility.
- Separate routine staff use from deployment, database, Storage, Duda, DNS, secret, and recovery authority.
- Until a stakeholder accepts a responsibility, write `TBD — STAKEHOLDER DECISION REQUIRED`.

## Ownership matrix

| Responsibility | Primary role/name | Backup role/name | Authority / expected duty | Evidence / policy reference | Status |
| --- | --- | --- | --- | --- | --- |
| GitHub repository ownership and branch protection | TBD — STAKEHOLDER DECISION REQUIRED | TBD — STAKEHOLDER DECISION REQUIRED | Manage institutional repository access, approvals, and protected branches |  | Unassigned |
| Release approval | TBD — STAKEHOLDER DECISION REQUIRED | TBD — STAKEHOLDER DECISION REQUIRED | Accept/reject an evidenced release |  | Unassigned |
| Render Admin/CMS deployment authority | TBD — STAKEHOLDER DECISION REQUIRED | TBD — STAKEHOLDER DECISION REQUIRED | Deploy/redeploy/rollback exact reviewed commits |  | Unassigned |
| Assistive worker deployment authority | TBD — STAKEHOLDER DECISION REQUIRED | TBD — STAKEHOLDER DECISION REQUIRED | Operate the separate worker and heartbeat readiness |  | Unassigned |
| Supabase project administration | TBD — STAKEHOLDER DECISION REQUIRED | TBD — STAKEHOLDER DECISION REQUIRED | Manage project, plan, access, and approved recovery |  | Unassigned |
| Database migration authority | TBD — STAKEHOLDER DECISION REQUIRED | TBD — STAKEHOLDER DECISION REQUIRED | Approve and apply governed forward migrations |  | Unassigned |
| Database backup/recovery lead | TBD — STAKEHOLDER DECISION REQUIRED | TBD — STAKEHOLDER DECISION REQUIRED | Own backup policy, isolated restore, RPO/RTO evidence |  | Unassigned |
| Storage administration / backup recovery | TBD — STAKEHOLDER DECISION REQUIRED | TBD — STAKEHOLDER DECISION REQUIRED | Protect/restore canonical bucket roles and metadata |  | Unassigned |
| Duda publishing/integration ownership | TBD — STAKEHOLDER DECISION REQUIRED | TBD — STAKEHOLDER DECISION REQUIRED | Own consumer configuration, approved cutover, and escalation |  | Unassigned |
| DNS/custom-domain/TLS ownership | TBD — STAKEHOLDER DECISION REQUIRED | TBD — STAKEHOLDER DECISION REQUIRED | Operate registrar/zone, certificates, validation, recovery |  | Unassigned |
| Participant email/provider ownership | TBD — STAKEHOLDER DECISION REQUIRED | TBD — STAKEHOLDER DECISION REQUIRED | Approve sender/domain, provider, policy, and incident response |  | Unassigned |
| Staff-account administration | TBD — STAKEHOLDER DECISION REQUIRED | TBD — STAKEHOLDER DECISION REQUIRED | Provision/offboard roles through approved workflow |  | Unassigned |
| Monitoring recipient | TBD — STAKEHOLDER DECISION REQUIRED | TBD — STAKEHOLDER DECISION REQUIRED | Receive, acknowledge, and route alerts |  | Unassigned |
| Incident escalation contact | TBD — STAKEHOLDER DECISION REQUIRED | TBD — STAKEHOLDER DECISION REQUIRED | Own severity, communications, and change/incident record |  | Unassigned |
| Technical maintenance owner | TBD — STAKEHOLDER DECISION REQUIRED | TBD — STAKEHOLDER DECISION REQUIRED | Maintain code, tests, dependencies, runbooks, and releases |  | Unassigned |
| Admin/operator process owner | TBD — STAKEHOLDER DECISION REQUIRED | TBD — STAKEHOLDER DECISION REQUIRED | Own routine staff workflow and training acceptance |  | Unassigned |
| Credential/secret governance owner | TBD — STAKEHOLDER DECISION REQUIRED | TBD — STAKEHOLDER DECISION REQUIRED | Own approved storage location, least privilege, rotation, and break-glass policy |  | Unassigned |

## Credential and access transfer record

Record policy/location only; never copy a value into this document.

| System | Institution-controlled account/alias confirmed | Primary and backup access confirmed | MFA / recovery policy reference | Secret/config location policy | Last access review | Result |
| --- | --- | --- | --- | --- | --- | --- |
| GitHub |  |  |  |  |  | Pending |
| Render |  |  |  |  |  | Pending |
| Supabase |  |  |  |  |  | Pending |
| DNS/TLS |  |  |  |  |  | Pending |
| Duda |  |  |  |  |  | Pending |
| Email/provider |  |  |  |  |  | Pending |
| Monitoring/incident channel |  |  |  |  |  | Pending |

## Escalation and support acceptance

| Field | Accepted value |
| --- | --- |
| Severity 1 route and acknowledgement target | TBD — STAKEHOLDER DECISION REQUIRED |
| Severity 2 route and support window | TBD — STAKEHOLDER DECISION REQUIRED |
| Severity 3 review cadence | TBD — STAKEHOLDER DECISION REQUIRED |
| Recovery change-window authority | TBD — STAKEHOLDER DECISION REQUIRED |
| Public/participant communication authority | TBD — STAKEHOLDER DECISION REQUIRED |
| Evidence retention location and period | INSTITUTION_DECISION_REQUIRED |

## KPI-15 documentation-based training test

### Test setup

Use an approved synthetic test/staging environment and the current [Admin/CMS Operator Guide](admin-operator-guide.md). The facilitator may explain the exercise before timing starts but must not guide the operator during an **unaided** task. Do not expose credentials in the result.

| Field | Value |
| --- | --- |
| Candidate release full SHA |  |
| Environment classification |  |
| Operator role (not private identity unless policy permits) |  |
| Facilitator role |  |
| Date/time (UTC) |  |
| Documentation version / SHA |  |
| Total routine tasks attempted |  |
| Unaided completed tasks |  |
| Score |  |
| Result (`PASS` requires >=80%) | `NOT RUN` |

### Routine tasks

Score each task exactly once as `UNAIDED_COMPLETE`, `ASSISTED_COMPLETE`, `NOT_COMPLETE`, or `NOT_APPLICABLE`. Exclude `NOT_APPLICABLE` from the denominator and record why it was excluded before the session begins.

| # | Routine task | Success evidence | Result | Assistance/deviation note |
| --- | --- | --- | --- | --- |
| 1 | Sign in and identify Projects, Imports, Publishing, and role-appropriate Staff access | Correct environment and navigation identified without bypass |  |  |
| 2 | Preview an approved synthetic import folder | Batch/package summary displayed; no data claimed saved at preview |  |  |
| 3 | Explain and handle one warning and one blocking invalid package | Warning acknowledged deliberately; invalid package remains unselected |  |  |
| 4 | Import selected project details and finish media staging | Completed batch/project references recorded; project remains draft |  |  |
| 5 | Inspect import readiness and submit eligible projects for review | Outcome counts interpreted correctly |  |  |
| 6 | Review a project and choose Approve or Request changes appropriately | Current status and audit/history verified |  |  |
| 7 | Explain the participant preview confirmation/correction lifecycle | Does not reuse tokens or bypass reissue |  |  |
| 8 | Prepare publication without claiming it publishes | No-write plan evidence interpreted correctly |  |  |
| 9 | Identify whether publication execution is authorized in the displayed environment | Refuses unauthorized/live action; uses exact acknowledgement only when approved |  |  |
| 10 | Archive/unpublish a supplied synthetic scenario through the supported control | Consequence, lifecycle, feed membership, and history checked |  |  |
| 11 | Locate project/import/publishing history and interpret a bounded failure/recovery state | Does not blindly retry or edit database/Storage |  |  |
| 12 | Escalate a simulated readiness, data-loss, or wrong-environment incident | Correct safe evidence and owner route selected; no secret/private data captured |  |  |

### Score

```text
unaided completion percentage =
  UNAIDED_COMPLETE routine tasks
  ---------------------------------------------- × 100
  total attempted routine tasks excluding NOT_APPLICABLE
```

Round to one decimal place. KPI-15’s training threshold is met only when the measured result is at least 80%. Assisted completion does not count as unaided completion. Do not change task results after coaching; run and record a new session if reassessment is approved.

### Training evidence and observations

Record:

- safe task/environment references and start/end times;
- result per task and any facilitator intervention;
- documentation gaps or ambiguous wording;
- controlled-operation failure handling and escalation choice;
- recommended documentation corrections; and
- operator/facilitator sign-off reference under institutional policy.

Do not record passwords, tokens, private URLs, response bodies, environment values, private user identities, or real participant data.

## Handover acceptance

Handover is complete only when all mandatory ownership rows have accepted primary/backup owners, institution-controlled access and recovery policy are verified, the release checklist is accepted, training reaches at least 80% unaided completion, documentation gaps are resolved or explicitly accepted, and institutional sign-off exists.

| Acceptance | Responsible role | Date (UTC) | Evidence/sign-off reference | Result |
| --- | --- | --- | --- | --- |
| Operational owner | TBD — STAKEHOLDER DECISION REQUIRED |  |  | Pending |
| Technical owner | TBD — STAKEHOLDER DECISION REQUIRED |  |  | Pending |
| Backup/recovery owner | TBD — STAKEHOLDER DECISION REQUIRED |  |  | Pending |
| Institution sponsor | TBD — STAKEHOLDER DECISION REQUIRED |  |  | Pending |

The existence of this template is `DOCUMENTED_ONLY`. It does not prove real training, ownership transfer, credential transfer, or KPI-15 passage.
