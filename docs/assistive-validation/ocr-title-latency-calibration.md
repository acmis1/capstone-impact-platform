# PP1 OCR title-latency calibration

## Scope and historical boundary

This calibration addresses Issue #214's title-only OCR latency blocker. The PR #213 holdout remains closed and consumed. It was not rerun, modified, or used for case-level tuning. Its `OCR_TITLE_PROVIDER_DEFERRED` decision remains authoritative historical evidence.

The production capability remains bounded to metadata-blind visible-title evidence and deterministic comparison with authoritative metadata. It grants no approval, publication, archive, Duda, public-feed, browser, shell, hosted-service, or metadata-mutation authority.

## Current upstream compatibility review

The calibration used PaddleOCR 3.7.0, PaddlePaddle 3.3.0, and PaddleX 3.7.2. Current official documentation was rechecked before candidate selection:

- [PaddleOCR OCR pipeline parameters](https://www.paddleocr.ai/main/en/version3.x/pipeline_usage/OCR.html)
- [PaddleX local inference engines](https://www.paddleocr.ai/latest/en/version3.x/inference_deployment/local_inference/inference_engine.html)
- [PaddleOCR high-performance inference](https://www.paddleocr.ai/v3.0.2/en/version3.x/deployment/high_performance_inference.html)
- [PaddleOCR 3.7.0 release](https://github.com/PaddlePaddle/PaddleOCR/releases/tag/v3.7.0)

The package exposes `enable_mkldnn`, `mkldnn_cache_capacity`, `cpu_threads`, and `enable_hpi`. On this Windows x86-64 deployment host, MKL-DNN failed during the first warmup in Paddle's oneDNN executor, both with the documented compatibility arguments and with PaddleX's exposed legacy-IR engine configuration. No scored MKL-DNN case executed. Repeating the same backend failure at 8, 10, or 12 threads would not measure thread performance, so the matrix was stopped at the shared backend preflight. The exact failure is preserved in `mkldnn-compatibility.json`.

CPU HPI was not selected or benchmarked because the current support guidance targets Linux x86-64 and recommends Docker/WSL rather than a Windows-native dependency. The normal local CPU backend meets the strict calibration margin without HPI.

## New deterministic calibration corpus

- Seed: `2026082741`
- Composition: 36 scored cases plus one warmup
- Media/layout balance: four cases in each PNG/JPEG/scanned-PDF × one/two/three-column cell
- Inconsistent cases: 16 of 36
- Visible-title cases: 33 of 36
- Coverage: wrapped, multiline, stylized, small, low-contrast, compressed, noisy, logo-side, administrative-heading, unusually low, initial-crop boundary, distractor-first, absent, ambiguous, punctuation, dash, case, version, semantic-token, and acronym variants
- Corpus SHA-256: `dbca638ae050c00a43147c0e1e9faa163a004275f5914fc9f513a396c654c915`
- Protocol SHA-256: `a996e693778bb36dc101fe28695c1dda111abe0dfbb4bb2f1b80b68b08da0ddc`
- Deterministic asset aggregate SHA-256: `ab4eae40f39e341365cb00e4cfded3156f4bf890fc08a95b83990da99d4182d9`
- Repeated generation manifest SHA-256: `982da4d3c5053bd661e0e32eee101e3d9c531a41466de960567fe91575f12c4c` for both independent generations

The non-reuse validator compared normalized metadata titles, poster titles, complete reference hashes, and meaningful case identities against 297 historical OCR cases, the 30 exposed PR #213 title-calibration cases, and the 45 consumed PR #213 holdout cases. Prohibited reuse was zero.

## Baseline profile

The protocol-aligned full-page baseline used the prior default CPU backend with MKL-DNN disabled and no fast region.

| Measurement | Result |
|---|---:|
| Exact visible-title recovery | 33/33 (100%) |
| Inconsistency precision / recall | 100% / 100% |
| Automatic-agreement precision | 100% |
| Material false automatic agreements | 0 |
| p50 / p95 | 5,021.28 ms / 6,746.21 ms |
| Cold start | 10,217.13 ms |
| Peak working set | 1,080,500,224 bytes |
| Detection p50 | approximately 2,178 ms |
| Recognition p50 | approximately 2,756 ms |
| Rasterization p50 | approximately 44 ms |
| Candidate selection / comparison | sub-millisecond each |

Detection and recognition dominate steady-state latency. Rasterization, candidate selection, and deterministic comparison are not material bottlenecks. The historical 12.56-second p50 remains valid for its consumed run; the lower current-host baseline does not reinterpret that result.

## Bounded candidate comparison

Every successful candidate used the identical corpus, protocol, model artifacts, offline guard, full-resolution 1,920-pixel raster bound, selector, normalization, classifier, and gates.

| Candidate | Threads | Region | Hits / fallback | p50 ms | p95 ms | Result |
|---|---:|---:|---:|---:|---:|---|
| Full-page profiling baseline | default | none | 0 / 0 | 5,021.28 | 6,746.21 | margin pass; non-selectable historical configuration |
| Safe initial-region proof | 10 | 30% | 10 / 26 | 6,062.89 | 7,406.87 | margin pass; slower than baseline |
| Coordinate-safe fast path | 10 | 36% | 21 / 15 | 1,471.15 | 8,037.24 | margin pass |
| Coordinate-safe fast path | 12 | 36% | 21 / 15 | 1,470.09 | 7,878.18 | margin pass |
| Coordinate-safe fast path | 8 | 36% | 21 / 15 | 1,456.42 | 7,806.47 | margin pass |
| **Selected coordinate-safe fast path** | **4** | **36%** | **21 / 15** | **1,458.76** | **7,593.13** | **margin pass** |

All successful candidates achieved 100% exact title recovery, 100% inconsistency precision/recall, 100% automatic-agreement precision, zero material false agreements, zero false fast-path acceptances, and all provisioning/offline/operational checks.

The selected configuration is within 2% of the best observed p50, has the best p95, and uses the fewest CPU threads. Its cold start was 5,103.24 ms, peak working set was 1,076,822,016 bytes, artifact footprint was 31,481,281 bytes, average accepted fast-path latency was 1,315.98 ms, and average fallback latency was 6,472.85 ms. Relative to the final protocol-aligned baseline, it reduces p50 by 70.95% while keeping a conservative 41.67% fallback rate.

The 30% candidate mechanically proves safe fallback when a title starts beyond the initial crop. The selected 36% policy prevents ordinary multiline clipping; boundary-touching OCR, absent/insufficient evidence, prominent uppercase administrative text, low recognition confidence, and similarly prominent independent candidates all force the unchanged full-page path.

Raster-size reduction was not evaluated because the full-resolution winner already has ample latency margin. HPI was not evaluated for the deployment-compatibility reason above. No model weights are committed.

## Selection and next chronology step

Selected candidate: `default-cpu-fast-r36-t4`.

The tracked comparison and selection files are replayable without Paddle inference. At this calibration commit, holdout creation and production integration remain prohibited. A later dedicated freeze commit must bind the selected configuration, source, scorer, gates, runtime/model identities, and evidence hashes while proving that the fresh holdout does not yet exist.
