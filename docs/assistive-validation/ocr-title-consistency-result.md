# PP1 OCR title-consistency result

## Decision

**`OCR_TITLE_PROVIDER_DEFERRED`**

The title-only PP-OCRv6 Small candidate is not integrated into production. The single sealed fresh holdout run failed one frozen operational gate: p50 case latency was 12.56 seconds against a maximum of 10 seconds. The contract requires every gate to pass and permits neither a near-miss override nor post-result tuning or rerun.

Core assistive validation therefore remains available with its existing native-PDF-first and OCR-unavailable behavior. No production worker, coordinator, persistence, UI, dependency, migration, workflow-authority, Duda, or public-feed path changed.

## Frozen holdout result

| Measure | Observed | Frozen requirement | Result |
|---|---:|---:|---|
| Scored cases executed | 45/45 | 45/45 | Pass |
| Exact visible-title recovery | 41/43 (95.35%) | at least 95% | Pass |
| Inconsistency precision | 15/15 (100%) | at least 98% | Pass |
| Inconsistency recall | 15/15 (100%) | at least 95% | Pass |
| Automatic-agreement precision | 30/30 (100%) | 100% target | Pass |
| Material false automatic agreements | 0 | 0 | Pass |
| Cold start | 18.33 s | at most 30 s | Pass |
| p50 case latency | 12.56 s | at most 10 s | **Fail** |
| p95 case latency | 14.32 s | at most 20 s | Pass |
| Maximum case latency | 14.83 s | at most 90 s | Pass |
| Peak working set | 1,084,030,976 bytes | at most 4 GiB | Pass |
| Model artifact footprint | 31,481,281 bytes | at most 1 GiB | Pass |
| Offline self-test / no capture download | passed / false | required | Pass |

Body WER was 31.00% and remains diagnostic-only by prospective scope; it does not change the decision.

The two visible-title errors were bounded OCR/recovery errors rather than unsafe agreements: `Public Hall Cooling Demand Notes` was read as `Public Hal Cooling Demand Notes`, and `Neighbourhood Battery Swap Roster` was truncated to `Neighbourhood Battery Swap`. Despite those title errors, both inconsistent cases still produced `MISMATCH`, so the system recorded no false automatic agreement.

## Scientific chronology

1. Calibration implementation/evidence commit: `40e0f89ede258d6f3f038adf9f2d976902549a1c`.
2. Prospective protocol freeze commits: `6ec2ede` followed by the pre-holdout gate correction and superseding freeze `61abb54bf70bb1ae7128bdda85c010c61e74e0a2`.
3. Fresh 45-case corpus, rendered-asset seal, one-shot runner, and `SEALED_UNCONSUMED` state: `b6b9c6f`.
4. The runner atomically claimed the shot before model construction and completed once. State is now `CONSUMED_RECORDED` with run count one.

The canonical capture hash is `f0e4b59f00f189fdb4bb1fabc31387f860487842edf22c37b1c8b0b1f4e80ff2`; the report hash recorded in state is `c1a72aa88f3a6e1f27a9fc6fedcb2136f35d9112da939ada5d17d4c6540a8b03`. Machine-readable capture and report evidence is under `docs/assistive-validation/evidence/ocr-title-consistency-holdout/`. CI verifies the frozen seal, source hashes, consumed state, capture/report hashes, arithmetic, and deferred decision without loading OCR.

## Follow-up boundary

This result closes the scoped experiment. A future investigation may use a new independently approved protocol and fresh evidence to study operational latency, but it must not alter, rerun, or reinterpret this consumed holdout. Production PP-OCRv6 title evidence remains deferred.
