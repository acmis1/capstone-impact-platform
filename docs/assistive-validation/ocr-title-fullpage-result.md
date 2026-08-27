# PP1 full-page OCR title-consistency qualification result

Issue #214's corrected full-page qualification reached
`READY_FOR_TITLE_OCR_INTEGRATION` without reusing either historical holdout data or the
invalid pre-freeze exposed design.

## Scientific chronology

1. The exposed pre-freeze design (seed `2026082783`) was quarantined and permanently
   prohibited; its 64 irreversible case fingerprints remain in the non-reuse boundary.
2. The corrected calibration protocol was committed before every final repeat.
3. Four full-page PP-OCRv6 Small candidates each completed three accepted fresh-process
   repeats. No environmental attempt was rejected or retried.
4. `fullpage-cpu-t4` won the frozen lowest-worst-p95 rule and was frozen in commit
   `6ab97d992f0e73a8dcba4d4d126a327bdcab9b6d`.
5. Only after that freeze, a new 128-bit random seed
   `060f4611788236b94199058b072fb502` created the versioned v2 holdout.
6. The v2 seal was committed at `5d8da345776cb98a4c141836401d9786b167c319`, then the
   one-shot was preflighted, claimed and executed exactly once.

## Fresh holdout

The deterministic corpus contains 60 scored cases plus one warmup, including 25 genuinely
inconsistent cases. The nine `{png, jpeg, scanned_pdf} × {one, two, three column}` cells each
contain six or seven scored cases. The corpus SHA-256 is
`1e58ee894e2c7c34fd00046acb028954754836bc806d48ae1fa9aa766ec1ec7e`.

The 65 generated assets hash collectively to
`07c359186b7c19026b5578ad847d8ae4f11b428d555e0cfc27593c711eec716b`. Non-reuse is zero
against 466 cases across all 12 historical OCR corpora, all 45 current calibration cases, and
all 64 fingerprints from the invalid exposed-v1 design. The non-reuse evidence SHA-256 is
`246e78dc3a87e2b51f2bba4c54df148a97204dbe8fa4b22fea8535c76188b3c8`.

The seal file SHA-256 is
`4eb63a74733b03b0e3d685c55b3ac5e9df7ccb85f95c182579af4b76c17234a0`. Before execution,
the state was `SEALED_UNCONSUMED` with `run_count=0` and no candidate output.

## One-shot result

The recorded state is `CONSUMED_RECORDED`, `run_count=1`. The capture SHA-256 is
`354fbe09b7de992aad3b912a72b1e70cc937e318be0bb5bd1d53cef64632981e`; the report SHA-256
is `decc34aa93d12881fe0f8a666360c98ce10cdcdd5a30f6774cb6852cfa70928b`.

| Gate | Result | Requirement |
|---|---:|---:|
| Exact visible-title recovery | 58/58 = 100% | ≥ 95% |
| Inconsistency precision | 100% | ≥ 98% |
| Inconsistency recall | 100% | ≥ 95% |
| Automatic-agreement precision | 100% | 100% |
| Material false automatic agreements | 0 | 0 |
| p50 | 5,187.4 ms | ≤ 10,000 ms |
| p95 | 6,554.5 ms | ≤ 20,000 ms |
| Cold start | 9,230.4 ms | ≤ 30,000 ms |
| Peak RSS | 1,078,317,056 bytes | ≤ 4 GiB |
| Model artifacts | 31,481,281 bytes | ≤ 1 GiB |

All 60 scored cases executed. Provisioning used the sealed local PP-OCRv6 Small artifacts with
no download, PaddleOCR 3.7.0, PaddlePaddle 3.3.0 and PaddleX 3.7.2. Process-wide offline denial
and its self-test passed. Mean independent external CPU was 13.32%, below the frozen 25%
validity ceiling (`quiescent=true`); a transient maximum of 70.381% does not alter the
prospectively frozen mean-based rule.

## Decision

`READY_FOR_TITLE_OCR_INTEGRATION`

This permits production integration of the exact frozen provider only: full-page, one pass,
CPU, four threads, 180 DPI, 1,920-pixel maximum input dimension, MKL-DNN off, HPI off,
concurrency one, and selector
`top-band-typography-consistent-group-prominence-v4@geometry`. It does not permit a cropped
fast path, model change, cloud fallback, threshold change, authoritative metadata mutation, or
post-result tuning.
