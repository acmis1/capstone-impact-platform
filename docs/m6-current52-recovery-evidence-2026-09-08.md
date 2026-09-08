# Current-52 Recovery Evidence — 2026-09-08

## 1. Purpose and scope

This is the current, sanitized M6 recovery evidence record for the approved PP1
staging-v2 origin. The verified boundary is:

```text
staging-origin logical capture
→ isolated Local/self-hosted PostgreSQL 17 restore
```

This is `VERIFIED_STAGING` evidence within that boundary. It is not managed
Supabase PITR, hosted-to-hosted restoration, production recovery, or a
production SLA. The private recovery bundle remains outside Git and is not
described by path or contents here.

## 2. Source and capture identity

| Field | Recorded result |
| --- | --- |
| Reviewed repository SHA | `88fd17feba7bd97333afcb120325e581384aa680` |
| Source | Approved PP1 staging-v2 only |
| Capture classification | `SOURCE_CAPTURE_COMPLETE` |
| Evidence label | `ZERO_COST_HOSTED_ORIGIN_RECOVERY_REHEARSAL` |
| Capture window (UTC) | `2026-09-08T11:53:38.364Z` → `2026-09-08T11:56:32.745Z` |
| Capture duration | `174.381 s` |
| Source PostgreSQL | 17 |
| Source migrations | 52; latest `20260906120000_public_removal_completion_reconciliation` |
| Source mutation | `NONE` |

## 3. Database/Auth recovery result

The accepted isolated restore classification was
`ZERO_COST_RECOVERY_REHEARSAL_VERIFIED`.

- PostgreSQL 17 source restored to PostgreSQL 17.
- All 52 migrations were present, with the expected latest migration.
- Public application tables: 41; execution-control tables: 3; database integrity: `YES`.
- Auth users: `2 → 2`; orphan identities: `0`.
- Managed Auth customizations: `2/2`; managed Storage customizations: `0/0`.
- Managed schema: `MATCH`; managed Auth compatibility: `MATCH`.
- Platform role compatibility: `NORMALIZED_KNOWN_PLATFORM_ACL`.
- Table-grant portability: known target-default overgrants revoked (`477`); final parity: `MATCH`.
- Assistive cost fence: `MATCH`.
- `MANAGED_AUTH_BEHAVIOR = NOT_RUN` is expected for a real hosted-origin bundle; that mutation-based probe is synthetic-source-only.

## 4. Four-bucket Storage recovery

All four canonical buckets were captured and restored with configuration,
object-set, byte-count, and checksum verification. The current source state is:

| Bucket | Objects | Bytes | Public | Checksum root prefix |
| --- | ---: | ---: | --- | --- |
| `participant-corrections-private` | 0 | 0 | false | `e3b0c44298fc` |
| `project-drafts-private` | 36 | 2,707,610 | false | `000b6e1cee6a` |
| `project-public-assets` | 19 | 1,456,517 | true | `30973f8d8f02` |
| `public-feeds` | 2 | 2 | true | `ef11a7921bb9` |
| **Total** | **57** | **4,164,129** | — | — |

The empty `participant-corrections-private` bucket is the actual current
staging source state, not a missing recovery result. Synthetic recovery tests
also exercise a non-empty object in every canonical bucket.

## 5. Gate 4 result

`GATE4_MATCH` and `GATE4_MATCH_CONSTRAINT_RENDERING_PORTABLE` were recorded.
Constraint-rendering portability normalization was `YES`, covering the five
previously reviewed directional PostgreSQL rendering pairs. Table grants
matched. The compared contract contained 52 migrations, 44 tables, 84
application RPC signatures across 83 names, 4 dispatcher routines, and 4
canonical Storage buckets.

## 6. Application smoke

| Check | Result |
| --- | --- |
| `/api/health` | HTTP 200 (`RESPONSE`) |
| `/login` | HTTP 200; expected Capstone Impact marker `PRESENT` |
| Readiness | HTTP 503; `CONFIGURATION_NOT_READY` |
| Staging identity | `NOT_CLAIMED` |
| Application exit before cleanup | `NO` |

`CONFIGURATION_NOT_READY` is the truthful result for an isolated target with
no staging identity. A `READY` result would have been incorrect.

## 7. Isolation and cleanup

- Recovery containers observed: `11`.
- All published Docker `HostIp` values: `127.0.0.1`.
- Published recovery port block: `55001–55007`.
- Actual Docker bindings: loopback-only (`YES`).
- Disposable residue after the run: `ABSENT`.

The Supabase CLI's generic `All services bind to 0.0.0.0` notice did not
describe the actual published bindings in this run. Actual Docker inspection
is authoritative; any real non-loopback publication remains an acceptance stop.

## 8. Bundle immutability

Independent pre/post full-file inventories matched byte-for-byte:

- File count: `47`.
- Pre/post inventory SHA-256: `6A0BCC7A48986C66ACF6B6018D3037BDA6CA70300E9036ADD96579269CC5B8D3`.
- `SUCCESSFUL_BUNDLE_PRESERVED = YES`.

No private bundle path, Auth record, Storage object key, credential, token,
private URL, or SQL payload is recorded here.

## 9. Timing evidence

| Measurement | Result and boundary |
| --- | --- |
| Capture | `174.381 s`, staging-origin logical capture |
| Isolated restore | `44.699 s`, staging-origin → isolated Local/self-hosted target |
| Full verifier | `69.212 s`, isolated recovery verification |
| Backup age at restore start | `2,631.409 s`, rehearsal observation |

These are not formal hosted RPO, hosted RTO, production RPO/RTO,
managed-PITR timing, hosted-to-hosted timing, or an SLA measurement. Formal
RPO/RTO remains pending the repository's full timestamp and failure-scenario
contract.

## 10. Claim boundaries

### Verified

- Current 52-migration staging-origin logical capture.
- Current four-bucket recovery surface and all 57 current Storage objects,
  including configuration and checksum state.
- Isolated PostgreSQL 17 restoration, database integrity, Auth `2 → 2` with
  zero orphans, managed-schema match, Gate 4 match, assistive cost-fence
  match, health/login smoke, truthful isolated readiness, loopback-only actual
  Docker bindings, cleanup, and bundle preservation.

### Not proved

- Supabase managed PITR or hosted-to-hosted restoration.
- Production recovery, production SLA, or formal hosted/production RPO/RTO.
- Institutional backup-policy approval, external alert delivery, or
  institutional ownership/sign-off.

## 11. Remaining M6 gaps

The release checklist remains the blank per-release template: `checked = 0`,
`total = 67`. It must not be read as evidence that the technical rehearsal did
not occur. Remaining institution-dependent or human-boundary items include:

- formal RPO/RTO evidence and approved backup/retention policy;
- external monitoring provider, recipient, retained alert delivery, and
  escalation acknowledgement;
- named operational ownership, credential transfer, and institutional sign-off;
- KPI-01: `NOT TESTED / PENDING COMPARABLE HUMAN MEASUREMENT`;
- KPI-12: `FORMAL_INTENDED_USER_UAT_PENDING`;
- KPI-15: `HUMAN_TRAINING_AND_OWNERSHIP_PENDING`; and
- R1: `TRIGGERED / MITIGATION ACTIVE`.

Recovery evidence is technical evidence and does not manufacture human
acceptance.
