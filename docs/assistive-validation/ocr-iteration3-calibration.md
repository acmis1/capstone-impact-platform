# PP1 assistive OCR Iteration 3 calibration result

## Outcome

Calibration selects **Candidate A: PP-OCRv6 Small plus deterministic adaptive reading order** for one fresh holdout. This is a calibration selection only. It does not authorize production integration.

The selection is recomputable from [`evidence/ocr-iteration3/calibration-decision.json`](evidence/ocr-iteration3/calibration-decision.json). The initial Candidate A miss, the required Candidate B evaluation, and the permitted fresh-process Candidate A repeat are all preserved rather than overwritten.

| Candidate / attempt | Exact title | Primary WER | Cold start | p50 | p95 | Peak memory | Artifacts | Calibration outcome |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| A, initial | 18/18 | 6.3059% | 66.12 s | 11.95 s | 17.82 s | 1.05 GB | 31.48 MB | insufficient operational evidence |
| B, PP-DocLayout-S | 18/18 | 26.0733% | 24.29 s | 6.65 s | 8.69 s | 1.21 GB | 36.63 MB | insufficient WER |
| A, permitted repeat | 18/18 | 6.3059% | 10.89 s | 5.83 s | 6.87 s | 1.15 GB | 31.48 MB | **selected with margin** |

All three attempts executed 18/18 scored cases with zero runtime failures, zero material false automatic agreements, explicit local model directories, and the process-wide offline guard enabled before model construction. The unchanged final gates are at least 95% exact-title recovery, at most 12% corpus-aggregate WER, zero material false automatic agreements, all cases executed, at most 30 s cold start, 10 s p50, 20 s p95, 4 GiB peak working set, and 1 GiB model artifacts. The selected repeat also meets the stronger calibration margins of 100% exact titles and at most 10% WER.

## Root cause and Candidate A

The preserved Iteration 2 output confirms the failure was ordering, not transcription: the prior fixed gutter threshold collapsed realistic 45–55 px gutters into one region and fell back to row-major geometry. On the already-exposed 40-case Iteration 2 capture, the new geometry-only algorithm reduces WER from 364/2296 (15.8537%) to 74/2296 (3.2230%). This is diagnostic evidence only; it is not a fresh holdout result.

`adaptive-left-anchors-and-bands/v1` infers columns from repeated left-edge alignments, preserves top-page and full-width spans as deterministic vertical bands, supports at most four columns, and falls back to stable geometry/provider order when evidence is insufficient. It cannot read OCR text, metadata, case identity, truth, or expected agreement. `top-band-group-prominence-v2@geometry` adds a bounded multiline-group prominence bonus so a genuine two-line title can outrank either constituent line without using text meaning.

The calibration corpus is synthetic, contains 18 scored cases plus one warmup, and independently crosses PNG, JPEG, and scanned PDF with one-, two-, and three-column layouts: exactly two cases in every one of the nine cells. It includes clean and challenging strata, top-page controls, distractor headings, tables, diagrams/captions, low contrast, compression, mild noise, small body text, wrapped/multiline titles, semantic negatives, punctuation-only variants, and a number/version negative. Non-reuse checks report zero normalized title or full-reference reuse against 204 exposed historical OCR cases.

## Candidate B

Candidate B used the official local PP-StructureV3 pipeline with `PP-DocLayout-S`, the exact PP-OCRv6 Small detection and recognition artifacts, CPU inference, `layout_threshold=0.30`, and every optional structure module disabled. Thresholds 0.10, 0.20, 0.30, and 0.40 were compared on the unscored warmup only; 0.30 gave the best bounded region coverage while retaining the document-title region.

The official `PP-DocLayout-S` inference archive is 5,146,359 extracted bytes in this run, with archive SHA-256 `3f589aa473a5305a626705d94762fcb4ab3e43e6e48983c9b34b011a6c9d0394` and canonical tree SHA-256 `4d53cb80eecbabc3169e2bb4c32507420c6fadb7ced0d228f4faccfe72569162`. PaddleOCR documents the model as a 4.834 MB high-efficiency CPU-capable layout detector and PP-StructureV3 as supporting multi-column reading-order recovery. The exact artifact came from the [official Paddle model host](https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-DocLayout-S_infer.tar), and the [official source](https://github.com/PaddlePaddle/PaddleOCR/blob/main/paddleocr/_pipelines/pp_structurev3.py) is Apache-2.0.

Candidate B clears every operational, title, safety, provisioning, and offline gate, but its primary PP-Structure-assisted WER is 26.0733%. Its direct parsed-content diagnostic is 33.9445%, while applying Candidate A's deterministic order to the same captured OCR blocks is 7.2004%. The layout model therefore does not provide sufficient reading-order quality on this corpus and is not selected.

Candidate C (PaddleOCR-VL-1.6) was not evaluated. The staged protocol forbids it once Candidate A is sufficient after a permitted calibration repeat.

## Reproducibility and boundary

The machine-readable evidence directory contains both Candidate A captures/reports, the Candidate B capture/report, and the bound calibration decision. These checks recompute the stored results without loading an OCR provider:

```bash
python -m assistive_validation_benchmark.ocr_iteration3 check-calibration
python -m assistive_validation_benchmark.ocr_iteration3 check-calibration-evidence
python -m assistive_validation_benchmark.ocr_iteration3 check-candidate-b-evidence
python -m assistive_validation_benchmark.ocr_iteration3 check-calibration-decision
```

- Starting `origin/main`: `606b44e2816c1ec43621f1237c8c528d59a1184d`.
- Tracking issue: [#208](https://github.com/acmis1/capstone-impact-platform/issues/208).
- Branch: `feat/assistive-ocr-iteration3-reading-order`.
- Hosted Supabase, Render, Duda, participant/project data, language-aware review, production OCR selection, and worker/coordinator behavior were not touched.
