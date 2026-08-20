# Phase 3 assistive finding persistence

## Purpose

Phase 3 makes the Phase 2 deterministic observations durable. It adds one forward-only migration, two tables, three `SECURITY DEFINER` functions, and a small server-only TypeScript persistence boundary. It is local-first, deterministic-first, human-authoritative, asynchronous-ready, and provider-independent.

Assistive persistence is a side domain. A persisted run or finding cannot change project status, validation authority, approval, publication, archival, publication readiness, accessibility satisfaction, or project metadata, and there is no database trigger or function path from an assistive finding into authoritative workflow state.

## Durable model

`public.assistive_validation_runs`

| Column | Meaning |
|---|---|
| `id` | run identity |
| `project_id` | owning project, `ON DELETE CASCADE` |
| `requested_by` | initiating staff identity, `ON DELETE SET NULL` |
| `input_hash` | lowercase SHA-256 hexadecimal of the evaluated content |
| `pipeline_version` | bounded versioned identifier of the deterministic evaluation |
| `status` | `COMPLETED` or `FAILED` |
| `failure_code` | `EXTRACTION_CONTRACT_REJECTED`, `EXTRACTION_FAILED`, or `INTERNAL_FAILURE` |
| `created_at` | server-generated |

`public.assistive_validation_findings`

| Column | Meaning |
|---|---|
| `id`, `run_id` | finding identity and owning run, `ON DELETE CASCADE` |
| `check_type`, `outcome`, `reason_code`, `affected_field`, `origin` | the Phase 2 result, carried across unchanged |
| `classification` | fixed at `NON_BLOCKING` by a single-value check |
| `ordinal` | database-derived position within the run, unique per run |
| `score_kind`, `score_value` | `LEXICAL_SIMILARITY` plus a `numeric(19, 18)` value in `[0, 1]`, or both null |
| `evidence` | versioned `assistive-finding-evidence/v1` object |
| `disposition`, `reviewed_by`, `reviewed_at` | reviewer disposition and its attribution |
| `created_at` | server-generated |

A finding deliberately has no `project_id`, `input_hash`, or `pipeline_version`. The run owns those, so a finding that disagrees with its run about the project or the evaluated content is structurally impossible rather than merely constrained.

## Design decisions

**Terminal-only run lifecycle.** A Phase 3 run row is written once the deterministic evaluation has already finished, so it is durable only in a terminal state and its creation time is its completion time. A second, always-equal `completed_at` column would misdescribe what the row records. Worker claiming, leasing, attempts, and cancellation are job coordination and are absent by design.

**Foreign-key behaviour.** `project_id` cascades because every project-owned child in this schema already does (`media_assets`, `validation_flags`, `approval_records`, `project_disciplines`); assistive observations describe one project's own content and carry no authoritative audit duty. `RESTRICT` would let a non-authoritative side domain block an authoritative project deletion, inverting the authority model, and `SET NULL` is meaningless for a project-less run. The platform normally soft-deletes, so the cascade is a safety net rather than the routine path. Both staff references use `ON DELETE SET NULL`, matching `approval_records.admin_id`, `validation_flags.resolved_by`, and `import_batches.imported_by`: removing a staff account must neither destroy observation history nor be blocked by it.

**Reviewed coherence anchors on the timestamp.** The disposition constraint requires `reviewed_at` — not `reviewed_by` — for a dispositioned finding, precisely because `ON DELETE SET NULL` rewrites `reviewed_by` when a staff account is removed. Anchoring on the actor would make that cascade violate the check and block the staff deletion.

**Idempotency.** The uniqueness rule is a partial unique index over `(project_id, input_hash, pipeline_version)` covering only `status = 'COMPLETED'`.

| Case | Result |
|---|---|
| Exact retry of a completed identity with the same ordered finding set | `ALREADY_PERSISTED` with the existing run; no duplicate findings |
| Same completed identity with fewer, changed, or reordered findings | `IDENTITY_CONFLICT`; the existing run and findings remain unchanged |
| Completed identity followed by a failed persistence request | `IDENTITY_CONFLICT`; the completed evidence wins and no failed row is inserted |
| Previous failed run, later success | allowed; failed runs are unconstrained |
| Repeated failures | each is recorded |
| New pipeline version or changed content | a separate run |
| Concurrent identical attempts | one `PERSISTED`, the rest `ALREADY_PERSISTED`, one durable run |
| Concurrent conflicting completed attempts | one complete result is durable; the conflicting caller receives `IDENTITY_CONFLICT` |

A retry is exact only when the submitted findings are JSONB-semantically equal to the stored caller-visible shape in ordinal order: check type, outcome, classification, reason, affected field, origin, score kind/value, and evidence. Finding UUIDs, timestamps, and reviewer disposition metadata are deliberately excluded and are never rewritten during comparison. Numeric score values retain their `numeric(19, 18)` semantics, so insignificant decimal formatting does not manufacture a conflict.

A total unique constraint over that identity would have made retry after a failure impossible without a later destructive redesign. Concurrency converges through a transaction-scoped advisory lock on the identity, with the partial unique index and a `unique_violation` handler behind it as defence in depth. Both paths perform the same exact-retry comparison before returning `ALREADY_PERSISTED`.

**Atomicity.** Every validation completes before the first insert. A plpgsql `RETURN` does not undo rows already written inside the caller's transaction, so validating after writing could leave a completed run holding only part of its findings. A completed run with zero findings and a failed run carrying findings are both rejected, so neither impossible state can be created.

**Evidence.** The persisted evidence contract is versioned and closed: exactly the nine declared keys, no others. Both the persistence RPC and table constraints enforce the Phase 2 field contract: excerpt text up to 500 characters; metadata, normalized metadata, candidate, and normalized candidate text up to 400 characters; integer page numbers from 1 through 10; a strict five-key bounding box with numeric non-inverted coordinates and a declared geometry unit; and non-empty explanation text up to 300 characters. Plain-text fields reject representable prohibited control characters. The database also retains its 8192-character total ceiling, with the application ceiling at 8000 below it. No reasoning trace, raw transcript, prompt, provider response, model-generated URL, duplicated media, or credential is persisted.

**Score representation.** The score is stored as an explicit `(kind, value)` pair because Phase 0 measured it as lexical/edit evidence, not confidence and not a calibrated probability. It is `numeric`, not `double precision`: a float8 is rendered back into JSON through its text output and silently loses the last significant digit, so the stored evidence would not equal what the check measured.

**Reviewer disposition.** `UNREVIEWED`, `REVIEWED`, and `IGNORED`. Only `REVIEWED` and `IGNORED` can be recorded, and there is deliberately no `ACCEPTED` or `APPLIED` value, because nothing in Phase 3 updates authoritative metadata and no durable value may imply that it did. Recording requires the `projects.review` authority (admin, reviewer); creating a run requires any recognized staff role. Both are re-proved inside the database against `admin_users` and `user_roles`, and the acting identity always arrives from a verified server session.

## Access control

Both tables enable row level security with a `RESTRICTIVE` deny-all policy for `anon`, `authenticated`, and `service_role`, and every table privilege is revoked from `PUBLIC`, `anon`, `authenticated`, and `service_role`. The only paths in or out are three `SECURITY DEFINER` functions with `SET search_path = ''`, fully qualified objects, no dynamic SQL, and `EXECUTE` granted to `service_role` alone:

- `persist_assistive_validation_run` — atomic run plus findings;
- `record_assistive_finding_disposition` — the single narrow mutation, touching only `disposition`, `reviewed_by`, and `reviewed_at`;
- `get_latest_assistive_validation_run` — bounded read for a later staff surface.

A browser client therefore cannot read, insert, update, or delete a finding, cannot rewrite persisted evidence, and cannot spoof a reviewer disposition. No database or service-role credential is given to any model or worker process; the Phase 1 worker package is untouched by this phase.

## Application boundary

`apps/admin-cms/src/assistive-validation/`

- `domain/persistenceContract.ts` — strict schemas for run identity, findings, evidence, and the stored read shapes, plus `toPersistedAssistiveFinding`;
- `repositories/assistiveValidationRepository.ts` — the service-role gateway over the three RPCs, converting provider errors into bounded thrown codes;
- `services/assistiveValidationPersistenceService.ts` — strict result-specific parsing in and out, bounded error classification (`VALIDATION_FAILED`, `IDENTITY_CONFLICT`, `PROJECT_NOT_FOUND`, `FINDING_NOT_FOUND`, `PERMISSION_DENIED`, `PERSISTENCE_FAILED`, `INTERNAL_FAILURE`), and no raw database error in any returned or logged value.

A dependency regression holds the whole domain to its boundary: no module under `src/assistive-validation` may import anything outside it beyond `zod` and the Supabase client type, reference any authoritative mutation, publication, Duda, or model surface, construct a privileged client, or read an environment credential.

## Verification

At Phase 3 delivery, Local Supabase reset from zero and all 30 migrations applied cleanly. After
Phase 4, the same dedicated runtime verifier (`npm run verify:assistive-persistence-runtime`) runs
against the 31-migration schema and retains the Phase 3 behavioural assertions. It additionally
checks that every legacy terminal insert receives exactly one matching terminal job without
changing the Phase 3 RPC shapes. Phase 4's queue-specific proof is documented separately.

## Boundaries and Phase 4 handoff

Phase 3 adds no job table, queue, worker claiming or leasing, OCR orchestration, staff Assistive Checks UI, Apply-to-draft, grammar, duplicate production detection, embeddings, LLM or VLM behaviour, and activates no Gemini or other cloud AI.

Phase 4 can add job coordination without destructive change: a jobs table may reference a run, additional run statuses extend a check constraint, and `started_at`, `completed_at`, and extraction provider identity can be added as nullable columns. The partial unique index is what keeps worker retry possible. Extraction provider metadata is deliberately absent for now because the Phase 2 result contract carries none, and an unpopulated column would be worse than none.
