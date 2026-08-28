# PP1 OCR title-consistency calibration

## Scope

This iteration evaluates one production candidate only: local PP-OCRv6 Small extraction of bounded visible-title evidence from poster/image submissions. The evidence may support the existing deterministic comparison with authoritative project metadata. It cannot rewrite metadata, approve or block workflow, publish content, call hosted inference, transcribe full documents, or act on document instructions.

Full-body word error rate remains a reported diagnostic and is not a readiness gate. Earlier iterations demonstrated that broad transcription quality was not suitable for production even when title extraction was strong; those outcomes remain immutable historical evidence.

## Prospective contract

The tracked protocol freezes:

- PP-OCRv6 Small detection and recognition identities, exact local model-tree hashes, PaddleOCR 3.7.0, PaddlePaddle CPU 3.3.0, and PaddleX 3.7.2;
- CPU inference at 180 DPI with maximum input dimension 1920, MKLDNN disabled, orientation/unwarping modules disabled, and worker concurrency one;
- a metadata-blind top-band geometry selector with at most eight candidates and at most three joined title lines;
- deterministic normalization and three non-blocking outcomes: `AGREES`, `REVIEW`, and `MISMATCH`;
- final gates of at least 95% exact visible-title recovery, at least 98% inconsistency precision, at least 95% inconsistency recall, zero material false automatic agreements, all cases executed, and every operational/offline/provisioning check passed;
- stricter calibration margins of 100% exact recovery, precision, and recall with zero material false automatic agreements.

The 30 scored calibration cases plus one unscored warmup are deterministic synthetic fixtures. Ten scored cases are inconsistent. The corpus covers PNG, JPEG, scanned PDF, one/two/three-column layouts, title typography and placement variants, punctuation/case variants, material token changes, degradation, competing headings, missing/illegible titles, and hostile prompt-like text. Recorded non-reuse evidence compares normalized titles and case identities against 297 historical OCR cases.

## Calibration results

Two fresh-process attempts are preserved. No case, selector, threshold, gate, runtime setting, or model identity changed between them.

| Measure | Attempt 1 | Selected repeat | Required margin/gate |
|---|---:|---:|---:|
| Exact visible-title recovery | 28/28 (100%) | 28/28 (100%) | 100% calibration margin |
| Inconsistency precision | 100% | 100% | 100% calibration margin |
| Inconsistency recall | 100% | 100% | 100% calibration margin |
| Material false automatic agreements | 0 | 0 | 0 |
| Automatic-agreement precision | 100% | 100% | 100% target |
| Cold start | 25.25 s | 17.73 s | at most 30 s |
| p50 case latency | 11.27 s (failed) | 5.01 s | at most 10 s |
| p95 case latency | 13.28 s | 12.82 s | at most 20 s |
| Peak working set | 1.08 GB | 1.07 GB | at most 4 GiB |
| Model artifact footprint | 31,481,281 bytes | 31,481,281 bytes | at most 1 GiB |
| Body WER (diagnostic) | 30.85% | 30.85% | non-gating |

Attempt 1 failed only the prospective p50 operational gate, so it did not authorize a holdout. The untuned fresh-process repeat passed every quality, operational, provisioning, and offline-security check and all strict calibration margins. The repeat is selected under the recorded prospective rule; it authorizes freezing and creating a fresh sealed holdout, but it does **not** authorize production integration.

Canonical machine-readable evidence is under `docs/assistive-validation/evidence/ocr-title-consistency-calibration/`. The two raw captures, recomputed reports, and selection decision are all retained. CI recomputes their arithmetic and hashes without installing Paddle, downloading models, loading OCR, or consuming a holdout.

## Next boundary

The title selector, normalization, classifier, model identity, configuration, gates, and scorer must be committed and frozen before any fresh holdout corpus exists. The later holdout must contain 45 newly generated scored cases with at least 15 inconsistent examples, prove non-reuse against historical and calibration data, be sealed before output, and permit exactly one inference run. Only a complete pass of every frozen final gate can authorize production integration.
