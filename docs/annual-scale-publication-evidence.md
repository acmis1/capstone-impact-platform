# Annual-scale governed publication evidence

This verifier closes a boundary that the release-evaluation harness and the local scaling
benchmark intentionally do not claim. The release evaluator exercises a 132-case corpus with 120
persisted projects, but it plans only 20 `READY_TO_STAGE` candidates and records
`productionPublished=false`; its evaluator-owned ordinary feed is required to remain empty. The
scaling benchmark supports 100/500/1000 synthetic records, but its feed compilation measures only
fixture rows that already have lifecycle `published`.

## Reproducible command

Run the explicit disposable owner from the repository root:

```text
npm run verify:annual-publication-evidence
```

The owner creates a verifier-only Local Supabase workdir, loopback port block, Docker network and
project identity. The annual mode uses an empty seed in that temporary workdir so the repository's
ordinary four-project demonstration seed cannot become unrelated public-feed membership. It
requires `CAPSTONE_VERIFY_DISPOSABLE=1` and the exact owner-provided workdir and project ID, and
removes the complete stack through the existing owned cleanup path. The runtime refuses non-loopback
Supabase endpoints and never uses hosted Supabase, Render, Duda, the cloud-feed endpoint or
participant email.

## Governed path exercised

The runtime activates an empty public-feed head, then prepares 120 verifier-owned projects with the
existing private-media contract. Each target starts `approved`, receives a private poster image and
poster PDF, generates a participant preview through `SupabaseParticipantPreviewRepositoryCore`,
records confirmation through the repository, and is checked `READY` by the current readiness
authority. Publication is sequential because the current public-feed writer owns one global
mutation slot.

Every target is then passed to `executeControlledPublication` with admin publication permission,
`executionTarget='local'`, the current private/public/feed buckets, and the immutable public-feed
writer. The runtime checks the feed head and canonical Storage artifact after every successful
publication: record count advances by one, prior members remain, no unexpected verifier member is
introduced, the artifact validates, and the head identifies the current publication.

## Accounting contract

The final evidence gate requires exactly:

| Evidence | Required result |
| --- | ---: |
| Intended verifier-owned projects | 120 |
| Publication operations | 120 |
| Completed publication operations | 120 |
| Publication versions | 120 |
| Publication version members | 7,260 |
| Publication-linked publish audit records | 120 |
| Lifecycle `published` projects | 120 |
| Final feed records | 120 |
| Active/incomplete publication operations | 0 |

The 7,260 version-member expectation is derived from immutable full-feed snapshots:
`1 + 2 + ... + 120`. The activation baseline is separate and is not counted as a project
publication.

The final checks also prove public media bindings for both required assets per target, public media
bytes match the private source bytes, the public feed contains no private bucket or draft reference,
the canonical Storage bytes/hash equal the current deployment head/version, and all final public IDs
are unique and exactly the intended cohort.

## Observed disposable-Local run

On 2026-09-09, the real annual runtime completed with exit 0 and the existing owner teardown
reported no remaining verifier container, network or temporary workdir. The sanitized result was:

| Observation | Result |
| --- | ---: |
| Target projects | 120 |
| Publication operations / completed | 120 / 120 |
| Publication versions / version members | 120 / 7,260 |
| Publication-linked publish audits | 120 |
| Published projects | 120 |
| Final feed records | 120 |
| Final head version | 121, including the separate activation baseline |
| Local total duration | 75,957.551 ms |
| Local setup duration | 3,455.008 ms |
| Local readiness preparation | 11,772.333 ms |
| Local governed publication | 52,387.633 ms |
| Local final verification | 5,483.492 ms |

These timings are Local engineering observations, not production throughput, SLA, annual calendar
duration or staff-effort evidence.

## Idempotency and controls

After the final head is established, the verifier retries the first, middle and last target. Each
retry must return that target's own `ALREADY_COMPLETED` operation/snapshot/audit evidence without
changing ledger counts, canonical bytes, hash or head version.

Two controls are outside the 120-project cohort: an approved but unconfirmed/not-ready target and
a ready target attempted with reviewer permissions. Both must leave the feed, public media,
publication operations, versions and lifecycle unchanged.

## Sanitized output and claim boundary

A passing run emits a bounded summary beginning with:

```text
ANNUAL_PUBLICATION_EVIDENCE = LOCAL_DISPOSABLE_GOVERNED_PUBLICATION_VERIFIED
TARGET_PROJECTS = 120
COMPLETED_PUBLICATIONS = 120
FINAL_FEED_RECORDS = 120
FEED_VALID = YES
IDEMPOTENCY_SAMPLE = PASS
NEGATIVE_CONTROLS = PASS
HOSTED_CONTACT = NO
PRODUCTION_PUBLICATION = NO
STAFF_EFFORT_MEASURED = NO
```

It does not print service keys, tokens, participant preview secrets/hashes, Auth identities,
private object paths, private URLs or raw identity-bearing SQL. Local durations are engineering
observations only: total, setup, readiness preparation, governed publication and final verification.
No arbitrary speed threshold is a pass condition.

If the verifier passes, it proves that 120 synthetic projects can be prepared and driven through the
current governed controlled-publication path on disposable Local infrastructure, with valid and
fully accounted 120-record canonical feed output, publication ledger/lifecycle/media evidence, and
the selected idempotency and negative controls.

It does not prove hosted Supabase capacity, production Impact publication, Duda operation,
production concurrency or SLA, staff-effort reduction/KPI-01, stakeholder UAT, production email
reliability, formal institutional acceptance, or any annual calendar duration. The release
evaluator's separate 132-case/120-persisted processing boundary remains separate evidence; these
two harnesses must not be combined into a claim that one execution exercised every workflow stage.
