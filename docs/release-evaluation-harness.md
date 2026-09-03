# Integrated Release Evaluation Harness

The Admin/CMS release evaluator is an explicit, disposable-Local verification command. It creates a deterministic 132-case synthetic corpus, stages the 120 accepted projects through the existing import authorities, exercises bounded review/readiness paths, renders a report, and removes only the state it captured.

## Run

Start the repository's Local Supabase stack first, then run from the repository root:

```text
npm run verify:release-evaluation
npm run verify:release-evaluation -- --runs=1 --seed=3565600806
npm run verify:release-evaluation -- --runs=1 --evidence
```

The default performs two complete runs and compares normalized evidence. `--evidence` pauses before cleanup so an operator can inspect the Local 120-project index and capture desktop/mobile screenshots; it requires `--runs=1`. Reports are written to a new OS temporary directory unless `--output-dir` points outside the repository.

Each run prints its namespace before mutation. If an external termination prevents the normal `finally` cleanup, start the Local stack and run the printed namespace through the narrowly scoped recovery path:

```text
npm run verify:release-evaluation -- --cleanup-run=run-1-0123456789abcdef
```

`--cleanup-run` accepts only namespaces emitted by this evaluator, requires a loopback Supabase URL, discovers only the matching `release-<namespace>-` project/import prefixes, removes their captured child rows and exact private draft objects, and reports residue. It cannot clean arbitrary IDs or hosted data. A hard kill or power loss is not claimed to run cleanup automatically.

## Safety and scope

The command refuses non-loopback Supabase URLs, does not use hosted services, and does not mutate publication ledgers, public Storage, Duda, or the ordinary public feed. It uses existing Local taxonomy rows and does not create or delete shared reference data. Cleanup is prefix/ID scoped and reports residue counts. A forced-failure cleanup hook is tested independently.

The corpus is input-only evidence, not production data. Runtime IDs, UUIDs, timestamps, paths, and timings are excluded from repeatability comparison. The corrected seeded-issue denominator is derived from the manifest: 32 critical issues, 20 non-critical issues, 52 total.

## What it demonstrates

It demonstrates deterministic corpus generation, parser/package validation, Admin reference reconciliation, Local import/media staging, review workflow and audit evidence, publication-readiness/candidate/feed distinctions, bounded repository pagination, observational Local timings, cleanup, and repeatability.

It does not demonstrate hosted Supabase, Render, Duda, production SLA, high-concurrency capacity, institutional UAT, production infrastructure throughput, or a staff-effort/KPI reduction. Local machine timing is not staff-effort evidence.
