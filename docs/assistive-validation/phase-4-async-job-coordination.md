# PP1 assistive validation Phase 4: async job coordination

Phase 4 adds durable, local-first coordination around the existing Phase 1 Python extraction,
Phase 2 deterministic checks, and Phase 3 non-authoritative finding persistence. PostgreSQL is the
only queue. This phase adds no staff UI, project metadata mutation, approval or publication state,
cloud OCR/model call, external broker, or Duda integration.

## Lifecycle and invariants

Each run has exactly one job, enforced by a unique foreign key, an automatic run-insert trigger,
and deferred pair-coherence constraint triggers. The run lifecycle is:

`QUEUED → RUNNING → PARTIAL | COMPLETED | FAILED | CANCELLED | SUPERSEDED`

The matching job lifecycle is:

`QUEUED → EXTRACTING → CHECKING → PARTIAL | COMPLETED | FAILED | CANCELLED | SUPERSEDED`

Claims use `FOR UPDATE SKIP LOCKED`, a database-generated UUID fencing token, a 30–180 second
lease (120 seconds by default), and at most two attempts. A reclaim always rotates the token. Every
heartbeat, stage change, failure, supersession, and finalization locks the job row and proves the
active state, exact token, and unexpired lease. Cancellation and finalization lock that same row,
so whichever commits first defines the coherent terminal outcome; stale work cannot overwrite it.

The Migration 0030 terminal persistence RPC is unchanged. A before-insert trigger derives the new
terminal timestamp, and an after-insert trigger creates its matching terminal job. The legacy
latest-result reader remains limited to `COMPLETED` and `FAILED`, so a newer queued request cannot
hide the latest Phase 3-compatible result.

## Trusted process boundary

Only the standalone Node coordinator owns the Supabase service-role client. It reads the current
project title plus the selected private poster (PDF first, then PNG/JPEG), downloads and validates
the exact bytes, and computes a canonical SHA-256 identity over these fixed JSON fields in this
order: `documentType`, `documentSha256`, `title`. It repeats the read and hash before finalization;
changed or unreconstructible input becomes `SUPERSEDED`.

The Python child receives no Supabase key or URL. Node creates one owned temporary directory,
writes a fixed filename with restrictive permissions, and spawns a fixed module/argument array
with `shell: false`. The child receives one closed `assistive-worker-task/v1` JSON object over
stdin and emits one closed `assistive-worker-task-result/v1` line over stdout. Output and stderr
are bounded, execution is timed out, leases are heartbeated, parent liveness is monitored, and the
known process tree is terminated on timeout, cancellation, or claim loss. Cleanup recursively
removes only a verified direct child of the system temp directory whose name begins with
`capstone-assistive-`.

OCR remains explicit. The production coordinator selects `NONE`; Tesseract is available only when
trusted configuration explicitly selects it. No LLM, VLM, embedding, grammar, duplicate-detection,
or hosted OCR path is present.

## Migration identity

- Sequence: `0031` (the repository contains exactly 31 migrations)
- Filename: `20260820160000_assistive_validation_job_coordination.sql`
- Canonical SHA-256 (UTF-8 with LF line endings):
  `057411c1daa09da326bb523341ec64ff0bb605c5a48fec3727672f987b379871`

## Local operator commands

From the repository root, with loopback Local Supabase configured:

```powershell
npm run run:assistive-worker-once
npm run run:assistive-worker
npm run assistive-worker:health
npm run verify:assistive-persistence-runtime
npm run verify:assistive-jobs-runtime
```

`run:assistive-worker-once` claims at most one job. `run:assistive-worker` polls sequentially with
worker concurrency fixed at one. `assistive-worker:health` checks both the database queue and the
Python task executable without processing a project. All commands are local/operator surfaces;
they do not provision or contact hosted resources.

## Verification

Static tests prove migration history is byte-identical through Migration 0030, direct table access
is denied, only the bounded RPCs are granted, every claimed mutation is fenced, the process uses no
shell, credentials are stripped, and no authoritative/model/broker surface is imported. Python
tests cover strict task versions and keys, fixed staging paths, media/type matching, success,
`OCR_REQUIRED`, safe extraction failure, bounded contract failure, health, and single-line stdout.

The loopback runtime verifier exercises 100 parallel enqueue/claim jobs, same-identity enqueue
convergence, lease heartbeat and expiry, token rotation, stale-worker refusal, the two-attempt
bound, retry/non-retry failure, stage advancement, atomic finding finalization, partial output,
input mismatch and supersession, both cancellation/finalization orderings including a real race,
strict malformed-finding rollback, Phase 3 compatibility, health, one-to-one lifecycle coherence,
absence of authoritative side effects, and fixture-only cleanup.
