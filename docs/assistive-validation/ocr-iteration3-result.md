# PP1 assistive OCR Iteration 3 final holdout result

## Purpose and boundary

This document records the single authorised run against the sealed Iteration 3 fresh holdout.
The one-shot is consumed and the holdout must never be rerun or used for tuning.

The final decision is **`OCR_PROVIDER_DEFERRED`**.

The immutable machine-readable evidence is in
[`evidence/ocr-iteration3-fresh-holdout/`](evidence/ocr-iteration3-fresh-holdout/):
[`seal.json`](evidence/ocr-iteration3-fresh-holdout/seal.json),
[`seal-commit.json`](evidence/ocr-iteration3-fresh-holdout/seal-commit.json),
[`one-shot-state.json`](evidence/ocr-iteration3-fresh-holdout/one-shot-state.json),
[`holdout-capture.json`](evidence/ocr-iteration3-fresh-holdout/holdout-capture.json), and
[`holdout-report.json`](evidence/ocr-iteration3-fresh-holdout/holdout-report.json).

The calibration evidence, candidate freeze, fresh-holdout protocol, corpus, and seal remain
unchanged historical layers. This result records their consequence; it does not revise them.

## Run identity

| Item | Value |
|---|---|
| Base `origin/main` | `606b44e2816c1ec43621f1237c8c528d59a1184d` |
| Candidate freeze commit | `ddb837653c8698260becb536fa622d6b4ed2713f` |
| Candidate freeze tree | `4aa75aeb3a7fa78ded84b5a89e762ebecdb0d3ae` |
| Holdout seal commit | `6b3c6309100b4763bdd8d2f18d6734c974f73c0b` |
| Execution commit | `9d7055b24fee9ab84234240d17efd072a0d659af` |
| Protocol | `pp1-ocr-iteration3-reading-order-v1` |
| Corpus | `pp1-ocr-iteration3-fresh-holdout-v1` |
| Corpus SHA-256 | `4b19aff9bf3e6fa988ee1bf175082420048a2a92e99051bd13b6f5f6ae3e9e98` |
| Corpus asset SHA-256 | `39d6477c433553ade78da727c07a3f4179f813d23d045463eab640fe2b2213b5` |
| Pre-run seal SHA-256 | `cde97c911483771056ded5bb4e85e5d5f2e9ce3793faa6bc83ee004d2e9d2a28` |
| Sealed state SHA-256 | `b8b4f3b5afad78a213a5a400e5fce5c8f49bb6530837773b5ea22230e24239a1` |
| Candidate | PP-OCRv6 Small (`paddle-small`) |
| Configuration | 180 DPI, 1920 px max edge, CPU, MKL-DNN disabled |
| Title selector | `top-band-group-prominence-v2@geometry` |
| Primary reading order | `adaptive-left-anchors-and-bands/v1` |
| OCR runs | 1 |
| Rerun permitted | no |

| Evidence file | Bytes | SHA-256 |
|---|---:|---|
| `one-shot-state.json` | 510 | `abe29b39b35e2fe0b947089d929db427564d9f07075aff3b2f91e048aebbedf5` |
| `holdout-capture.json` | 134,182 | `748bc19f663ac99e3b2361553f99cd2023920946e3f66324e1cdbae5c396f368` |
| `holdout-report.json` | 27,420 | `0779e54cce340841bc781a2d1c1e11ae5b462281031b0355b58ebf15db56af77` |

The consumed state records exactly one run and binds the canonical capture and report values
to those SHA-256 identities.

## Measured result

- All **45 / 45** scored cases executed with **0** OCR failures. **Passes.**
- Exact title recovery: **43 / 45 = 95.5556%**, above the 95% minimum. **Passes.**
- Material false automatic agreements: **0**, at the fixed maximum of 0. **Passes.**
- Primary adaptive reading-order WER: **899 / 5,494 = 16.3633%**, above the fixed 12%
  maximum. **Fails.**
- Required reading-order diagnostics: raw WER **33.2545%**; Iteration 2 column-order WER
  **30.3058%**.
- Operational measurements: cold start **24,420.93 ms**; p50 **7,638.94 ms**; p95
  **14,997.38 ms**; slowest case **15,517.06 ms**; peak working set **1,177,554,944
  bytes**; model footprint **31,481,281 bytes**. All pass the frozen limits.
- Offline enforcement and its self-test passed; model provisioning matched the frozen hashes
  and downloaded no artifact during capture.

### Gate families

| Gate family | Outcome |
|---|---|
| `quality` | **FAIL** |
| `title_safety` | PASS |
| `operational` | PASS |
| `provisioning` | PASS |
| `offline_security` | PASS |

All five families were required to pass. The WER failure therefore makes
`READY_FOR_OCR_PROVIDER_INTEGRATION` unavailable even though every other family passed.

### Crossed strata

The corpus contains five scored cases in each of the nine media-by-layout cells, so media and
layout are independently crossed.

| Dimension | Stratum | Cases | Exact titles | Adaptive WER |
|---|---|---:|---:|---:|
| Layout | one-column | 15 | 14 | 5.9286% |
| Layout | two-column | 15 | 15 | 38.6489% |
| Layout | three-column | 15 | 14 | 5.0614% |
| Media | JPEG | 15 | 15 | 15.4014% |
| Media | PNG | 15 | 13 | 17.6952% |
| Media | scanned PDF | 15 | 15 | 15.9934% |
| Difficulty | clean | 18 | 18 | 9.6644% |
| Difficulty | challenging | 27 | 25 | 20.9573% |

## Bounded diagnostic observations

These observations describe the consumed result only. They do not authorise a rerun, tuning,
candidate substitution, or retroactive selection path.

The exact-title misses were `ocr3-hold-005` and `ocr3-hold-012`; both produced `MISMATCH`, so
neither became a material false automatic agreement.

The two-column stratum contributed the dominant aggregate error rate at 38.6489%, while the
one- and three-column strata were below 6%. The eight highest per-case WERs were all cases in
which the adaptive algorithm selected its column mode. This is evidence of a concentrated
ordering weakness in the recorded run, but it does not by itself establish a root cause or a
valid correction. Media WERs remained comparatively close despite the crossed allocation.

The adaptive order improved the same captured blocks from the Iteration 2 column diagnostic
of 30.3058% to 16.3633%, but that improvement remains above the unchanged 12% production gate.
A near miss or a relative improvement is not a pass.

## Scientific and project consequence

- The one-shot has been consumed. This holdout must never be rerun or tuned against.
- Candidate A is not established as production-ready and no OCR provider is selected.
- No production OCR code, dependency, worker provider, coordinator policy, database migration,
  or workflow authority is changed.
- Candidate C was not evaluated because Candidate A was sufficient at the permitted calibration
  stage; the fresh holdout result cannot reopen that frozen search path.
- Any future OCR iteration requires a new protocol decision and a newly generated, separately
  sealed fresh holdout. This result does not authorise that work.

## Verification without OCR

The consumed result can be re-proved from tracked evidence without loading an OCR runtime,
using a model, downloading artifacts, or consuming another run:

```bash
python -m assistive_validation_benchmark.ocr_iteration3 check-holdout-result
```

The check revalidates the seal, requires `CONSUMED_COMPLETE` with `run_count == 1`, re-scores
the tracked capture through the frozen path, requires exact canonical equality with the stored
report, and verifies the state's capture/report hash bindings. It is wired into
`.github/workflows/assistive-benchmark-ci.yml`.

Focused Iteration 3 tests and evidence checks pass. The repository-wide Python suite reached
328 passing tests but retained 14 historical Windows CRLF byte-freeze errors/failures in
untouched evidence, font, and vocabulary fixtures. The aggregate `npm run verify:all` could
not proceed past its local Supabase/Docker prerequisite because the Docker daemon was
unavailable; the independent YAML, Markdown-link, and terminology checks pass.
