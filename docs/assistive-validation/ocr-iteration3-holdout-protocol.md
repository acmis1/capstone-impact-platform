# PP1 assistive OCR Iteration 3 fresh-holdout protocol

## Purpose and freeze boundary

This protocol freezes the selected Candidate A before a new holdout is generated or inspected. At this stage no Iteration 3 holdout case, asset, capture, or result exists.

The frozen candidate is PP-OCRv6 Small with `adaptive-left-anchors-and-bands/v1`, `top-band-group-prominence-v2@geometry`, 180 DPI rasterization, 1920 px maximum input dimension, CPU inference, MKL-DNN disabled, and document-orientation, unwarping, and text-line-orientation modules disabled. The exact runtime is PaddleOCR 3.7.0, PaddlePaddle 3.3.0, and PaddleX 3.7.2.

| Artifact | SHA-256 identity |
|---|---|
| `PP-OCRv6_small_det` archive | `bfb7c1e59f0faa6b540ebdca93aea3f4b1f2477805b389fbee117820d68fe9f5` |
| `PP-OCRv6_small_rec` archive | `da460f968ce9f88325ac3a34fa302077d6e9b0dcefb16ba3137cd7796f879d06` |
| Detection canonical tree | `8af984562965b7be9bd5d1c8acb52f6d0bf37de475947b520d876ed8640eb29a` |
| Recognition canonical tree | `0ee2c443863549fabdb1120d7a58df5e8afa0d67bce0827b75529f105c993eae` |
| Combined model footprint | 31,481,281 bytes |

The model and source are Apache-2.0 and come from PaddleOCR's official release and model host. No cloud or hosted inference is permitted.

## Future holdout contract

The holdout must be generated only after the candidate-freeze commit is recorded. It contains exactly 45 scored synthetic OCR cases, five in each independently crossed media/layout cell:

| Media | one column | two columns | three columns |
|---|---:|---:|---:|
| PNG | 5 | 5 | 5 |
| JPEG | 5 | 5 | 5 |
| scanned PDF | 5 | 5 | 5 |

It must include clean and challenging conditions and meaningful coverage of top-page controls, distractor headings, tables, diagrams/captions, low contrast, compression, mild noise, small body text, wrapped/multiline titles, material semantic negatives, punctuation-only agreement controls, and a number/version negative. At least three born-digital PDF controls, at least two malformed/truncated security controls, and exactly one unscored warmup sit outside the 45 scored cases.

The generator uses a fresh seed chosen after the candidate freeze. Before inference, validation must prove zero normalized-title and full-reference reuse against every exposed Phase 0, v1, Iteration 2, and Iteration 3 calibration case, and no duplicate current title or semantic hash. Only synthetic content is permitted.

## Seal and one-shot execution

Before candidate output is visible, a seal binds the candidate-freeze commit, protocol, corpus, generator, renderer, asset manifest, candidate source files, model identities, runtime configuration, gates, and non-reuse evidence by SHA-256. The sealed corpus is then run exactly once with all model artifacts already local and the process-wide network guard enabled before model construction.

The one-shot state begins sealed and unconsumed, changes to consumed once inference starts, and binds the final capture/report hashes. After output exposure, no algorithm, threshold, selector, reference, renderer, case, or expected relationship may change. A genuine protocol bug requires preserving the exposed run under `HOLDOUT_INVALID_PROTOCOL_BUG` and creating a later protocol with a different fresh holdout; tuning and rerunning this holdout is forbidden.

## Unchanged decision gates

- Exact normalized title recovery: at least 95%.
- Corpus-aggregate WER after NFKC and whitespace collapse only: at most 12%.
- Material false automatic agreements: exactly zero permitted.
- All 45 scored cases execute successfully.
- Cold start: at most 30 seconds.
- p50: at most 10 seconds.
- p95: at most 20 seconds.
- Peak working set: at most 4 GiB.
- Model artifact footprint: at most 1 GiB.
- Explicit offline/provisioning/security checks pass.

Every gate family must pass. A near miss cannot authorize integration. The only final decisions are:

- `READY_FOR_OCR_PROVIDER_INTEGRATION`;
- `OCR_PROVIDER_DEFERRED`;
- `HOLDOUT_INVALID_PROTOCOL_BUG`.

Production integration is conditional on `READY_FOR_OCR_PROVIDER_INTEGRATION`. Until then, the existing worker providers and coordinator selection remain unchanged.

## Freeze chronology

The content-addressed candidate manifest is embedded in [`evidence/ocr-iteration3/calibration-decision.json`](evidence/ocr-iteration3/calibration-decision.json). A later identity-only record will bind the exact candidate-freeze commit before holdout generation. The freeze records `origin/main` `606b44e2816c1ec43621f1237c8c528d59a1184d`, issue [#208](https://github.com/acmis1/capstone-impact-platform/issues/208), and branch `feat/assistive-ocr-iteration3-reading-order`.
