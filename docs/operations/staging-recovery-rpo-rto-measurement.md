# Bounded staging recovery RPO/RTO measurement

## Scope

The only supported measurement scenario is
`STAGING_ORIGIN_TO_ISOLATED_TARGET`:

```text
staging-origin logical recovery set
→ isolated Local/self-hosted PostgreSQL 17 target
→ bounded service-recovery acceptance
```

This contract does not represent managed Supabase PITR, hosted-to-hosted
recovery, production recovery, a production SLA, or an institution-approved
RPO/RTO objective.

## Canonical metric boundaries

This measurement layer preserves the existing PP1 M6 contract in
`docs/m6-operational-readiness.md`.

- **Achieved RPO** = incident/failure reference minus the newest authoritative
  restorable point for the complete bounded recovery set.
- **Achieved RTO** = service/application-smoke acceptance completion minus the
  authoritative recovery start.

The incident reference is required for RPO and scenario chronology. It is not
the RTO start boundary.

## Service acceptance and cleanup boundary

The existing recovery verifier records `verificationCompletedAt` after required
restore/integrity/Gate 4 verification and, when enabled, the application-smoke
checks. That timestamp is recorded before the outer `finally` block performs
exact-identity teardown and residue cleanup.

Cleanup therefore does not extend the mathematical RTO duration. However,
cleanup remains mandatory evidence hygiene: a final `CLEANUP_FAILED`
classification invalidates the rehearsal evidence and prevents a `MEASURED`
result.

The final classification alone is not enough to prove service recovery. The
restore implementation supports `--skip-application-smoke`, and a narrower
DB/Storage recovery run can still otherwise resolve
`ZERO_COST_RECOVERY_REHEARSAL_VERIFIED`. A measured service-recovery RTO must
therefore include a separate fixed attestation that the run satisfied the
existing `applicationSmokeMatchesRecoveryContract(...)` boundary.

A missing, skipped, `NOT_RUN`, failed, non-matching, or unknown smoke attestation
returns `NOT_PROVEN`. Skipped smoke may still support narrower database/Storage
recovery evidence, but it is insufficient for measured service-recovery RTO.

## Evidence required from the next orchestrated rehearsal

The orchestrator must record canonical UTC timestamps with their authority:

| Evidence | Required authority | Meaning |
| --- | --- | --- |
| Incident reference | `INCIDENT_DECLARED_BY_SCENARIO_CONTROLLER` | Declared start of the bounded failure scenario; used for RPO and chronology. |
| Recovery point | `BOUNDED_RECOVERY_SET_WATERMARK` | Newest time through which the complete database/Auth/Storage recovery set is authoritatively restorable. |
| Recovery start | `RECOVERY_ORCHESTRATOR_STARTED` | Start of recovery execution after the incident reference; RTO starts here. |
| Service acceptance completion | `RECOVERY_VERIFICATION_COMPLETED_AT` | Pre-cleanup completion time of the required service-recovery verification. |
| Application smoke attestation | `RECOVERY_APPLICATION_SMOKE_CONTRACT_MATCH` | Explicit evidence that `applicationSmokeMatchesRecoveryContract(...)` matched for this run. |
| Final rehearsal classification | `ZERO_COST_RECOVERY_REHEARSAL_VERIFIED` | Final result after mandatory cleanup/residue verification. |

Only a final `ZERO_COST_RECOVERY_REHEARSAL_VERIFIED` classification plus the
explicit application-smoke contract-match attestation can produce a measured
service-recovery result. Every other recovery classification, including
`CLEANUP_FAILED`, returns `NOT_PROVEN`.

Timestamps use canonical `YYYY-MM-DDTHH:mm:ss.sssZ` form. The recovery point
must not follow the incident reference; recovery start must not precede the
incident; service acceptance must not precede recovery start. Equal timestamps
are allowed when chronology is internally consistent.

No cleanup timestamp is required or used to calculate RTO.

## Recovery-point authority

`BOUNDED_RECOVERY_SET_WATERMARK` cannot be inferred from capture start,
capture completion, restore start, or a backup-age observation. The logical
database capture and Storage transfer do not establish a provider-transactional,
cross-service point-in-time snapshot by themselves.

A future controlled rehearsal must deliberately establish and attest the
complete recovery-set watermark or leave RPO `NOT_PROVEN`.

## Current evidence classification

The 2026-09-08 current-52 evidence records:

- staging-origin logical capture duration `174.381 s`;
- backup age at restore start as a rehearsal observation;
- isolated restore duration `44.699 s`; and
- full verifier duration `69.212 s`.

Those values remain valid operational timings within their documented
boundaries. They do not provide the authoritative incident reference,
complete-recovery-set watermark, recovery-start/service-smoke measurement
contract, or explicit application-smoke attestation required here.

They therefore cannot be converted into formal bounded staging RPO/RTO and
remain `NOT_PROVEN` for that purpose. They also do not prove managed hosted
PITR, hosted-to-hosted recovery, production RPO/RTO, a production SLA, or an
institutional target.

## Sanitized output

The formatter emits only fixed scenario/classification/attestation labels,
fixed reason codes, and calculated millisecond values. Unknown input fields are
ignored. Backup paths, object keys, Auth records, credentials, SQL payloads,
tokens, private URLs, and arbitrary caller-provided target values are never
echoed into measurement output.
