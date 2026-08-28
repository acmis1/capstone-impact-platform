# PP1 assistive OCR Iteration 4 calibration result

## Decision and boundary

The final project decision is **`OCR_PROVIDER_DEFERRED`** because the only frozen
PaddleOCR-VL-1.6 configuration produced **`ITERATION4_CALIBRATION_INSUFFICIENT`**.
The scored attempt stopped when its unscored warmup exceeded the precommitted 180-second
case timeout. None of the 27 calibration cases ran, so quality and title-safety rates are not
measurable and no fresh holdout was created or consumed.

No production provider, worker dependency, persistence change, migration, Admin/CMS change,
or hosted-service change was made. The historical Iteration 2 and 3 holdouts were not rerun or
modified.

The immutable machine-readable evidence is in
[`evidence/ocr-iteration4/`](evidence/ocr-iteration4/):
[`calibration-capture.json`](evidence/ocr-iteration4/calibration-capture.json) and
[`calibration-report.json`](evidence/ocr-iteration4/calibration-report.json).

## Run identity and official verification

| Item | Value |
|---|---|
| Starting `origin/main` | `9c870e2c23caed6aefe7b5f20ad87ee4db80deaf` |
| Branch | `feat/assistive-ocr-iteration4-paddleocr-vl` |
| Worktree | `.worktrees/assistive-ocr-iteration4-paddleocr-vl` |
| Pre-measurement commit | `fddf7c67002b5a57422efa914a69fceafccead74` |
| Pre-measurement tree | `e304ae0665b6afc90ab7b175a70bad980c09e3c9` |
| Protocol | `pp1-ocr-iteration4-paddleocr-vl-v1` |
| Canonical protocol SHA-256 | `597d2546ce6bc656e1851d339d18b5a1002e8457f3414b61e411ce792cd6dca7` |
| Runtime packages | PaddleOCR `3.7.0`; PaddlePaddle `3.3.1`; PaddleX `3.7.2` |
| Licence | Apache-2.0 |
| Device/backend | x64 CPU; official native Paddle pipeline; concurrency 1 |

Before measurement, the current official PaddleOCR-VL documentation, PaddleOCR pipeline
source, PaddleX v1.6 pipeline configuration, and official PaddlePaddle model repositories were
checked. They established local CPU support, native structured parsing, the v1.6 model/layout
composition, Apache-2.0 licensing, and the exact downloadable revisions. The official source
set is also frozen in the model manifest.

- [PaddleOCR-VL v1.6 pipeline documentation](https://www.paddleocr.ai/latest/en/version3.x/pipeline_usage/PaddleOCR-VL.html)
- [Official PaddleOCR pipeline wrapper](https://github.com/PaddlePaddle/PaddleOCR/blob/main/paddleocr/_pipelines/paddleocr_vl.py)
- [Official PaddleX v1.6 pipeline configuration](https://github.com/PaddlePaddle/PaddleX/blob/release/3.7/paddlex/configs/pipelines/PaddleOCR-VL-1.6.yaml)
- [Official PaddleOCR-VL-1.6 model repository](https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6)
- [Official PP-DocLayoutV3 model repository](https://huggingface.co/PaddlePaddle/PP-DocLayoutV3)

## Frozen model identity

All model files were downloaded before measurement into an ignored local cache. Capture used
explicit local directories, reverified every file, downloaded nothing, and denied outbound
Python socket access before pipeline construction.

| Component | Official revision | Bytes | Tree SHA-256 |
|---|---|---:|---|
| PaddleOCR-VL-1.6-0.9B | `c5630abae1d940eafe0697512a0325494b02ab42` | 1,930,462,423 | `3b3b4bafee0048e7caf736e6492234893245ec72fd40f8f2d921bb3243634f7d` |
| PP-DocLayoutV3 | `7b48a7566925fa464281f930c58eee04fe2c862a` | 132,018,596 | `5c9b272cf2587fb172a39e402159915b400bd93dc5d4129c1f9d90fdd919dac8` |
| Combined canonical footprint | n/a | 2,062,481,019 | model manifest `3e9ac8a8f5f61418ddb4755f64ac70a2496e975115c9ba607133e00d037cc8db` |

The primary `model.safetensors` is 1,917,255,968 bytes with SHA-256
`85a479d506a11e724e7285d395c551be69f41dbc16b6342d3cacfb189aed71db`.
The layout `inference.pdiparams` is 130,806,572 bytes with SHA-256
`70bd316b0582769ec968829fd1feb1a6a58b7c941b938327e551b6b12b45c137`.
Every remaining configuration, tokenizer, processor, licence, source, and model file has its
individual byte length and SHA-256 in
[`model-manifest.json`](../../tools/assistive-validation-benchmark/ocr-iteration4-calibration/model-manifest.json).
No model weight is tracked by Git.

## Frozen operational and security gates

The budget was committed before the scored attempt. The verified 2.06-GB combined footprint
justified a 3-GiB artifact ceiling. The 10-GiB process ceiling reserves approximately 6 GiB
for the operating system on PP1's minimum 16-GB worker. The latency gates preserve PP1's
ordinary-project p95 target below three minutes.

| Gate | Frozen limit |
|---|---:|
| Worker concurrency | 1 |
| Model/artifact footprint | 3 GiB |
| Peak worker RSS | 10 GiB |
| Cold initialization | 180,000 ms |
| Ordinary document p50 | 120,000 ms |
| Ordinary document p95 | 180,000 ms |
| Individual case timeout | 180 seconds |
| Whole assistive run | 300 seconds |

The process-wide offline guard denied socket connection APIs and passed its denial self-test.
Model text was treated as bounded untrusted data: structured blocks are capped, markup is
reduced to plain visible text, external URL fetch is disabled, and deterministic title safety
remains the only automatic-agreement path.

## Independent calibration corpus

The deterministic seed is `2026082704`. The corpus contains 27 scored cases plus one warmup,
with three scored cases in every crossed media-by-layout cell: PNG, JPEG, and scanned PDF by
one-, two-, and three-column layout. It contains 9 clean and 18 challenging cases; 9 each with
table, diagram/caption, and neither. Coverage includes wrapped/multiline titles, distractors,
low contrast, compression, noise, small text, punctuation controls, semantic and version
negatives, asymmetric columns, spanning content, and hostile instruction-looking text.

| Identity | Value |
|---|---|
| Corpus version | `pp1-ocr-iteration4-calibration-v1` |
| Canonical corpus SHA-256 | `5ffcd097ef4ca24221bf221bce21790714686ad4b0e5dcf38f5d1da4548f7a5f` |
| Generated asset count | 33, including warmup and bounded native/security fixtures |
| Generated asset manifest SHA-256 | `883047d625bbe4432c1a1677dd918fa6d4132fe72306f1b39e5fdaab5003c21e` |
| Renderer | `pillow-noto-synthetic-poster/v4-reuse-iteration3-engine` at 180 DPI / 1920 px |

Mechanical non-reuse compared all 27 scored references with 269 exposed historical cases
across the Phase 0, v1 productionization, Iteration 2, and Iteration 3 calibration/holdout
sources. It found 0 normalized title reuses, 0 normalized full-reference reuses, 0 current
duplicate titles, and 0 current duplicate full references.

## Calibration outcome

An unscored pre-freeze smoke warmup had shown faithful structured output, recovering the exact
title with 13 bounded blocks in 164,183.44 ms. This observation was diagnostic only and did
not change the already-selected native v1.6 configuration or frozen thresholds.

In the scored calibration attempt, local models initialized and the offline worker entered
the unscored warmup. It did not return within the frozen 180-second timeout. The runner exited
with code 1 and the exact message:

`PaddleOCR-VL worker exceeded 180s for ocr4-cal-warmup-001`

The bounded capture therefore records all 27 scored cases as `CalibrationNotExecuted`. The
failure recorder reconstructs only deterministic corpus/model/runtime identity and the exact
observed timeout; it does not run inference again or manufacture unobserved latency, memory,
title, or WER values.

| Measurement | Result |
|---|---|
| Scored cases executed | 0 / 27 — fail |
| Exact title recovery | not measurable |
| Primary corpus-aggregate WER | not measurable |
| Material false automatic agreements | not measurable; no safety pass claimed |
| Artifact footprint | 2,062,481,019 bytes — pass |
| Worker concurrency | 1 — pass |
| Cold start / p50 / p95 / peak RSS | not retained or not measurable — fail closed |
| Per-case timeout | warmup exceeded 180 seconds — fail |
| Offline denial and self-test | pass |
| Explicit local provisioning / no capture download | pass |
| Calibration selection margin | fail |

The canonical capture SHA-256 is
`7bdf22a817d2a18a5a38162761950e378a36efc43eea25901f12962df45456c7`.
The calibration report file SHA-256 is
`269e26b5073d27865fe6798aa9e256525ad8eddcdd856e79db2ea7add4293a67`.

## Scientific and project consequence

- Calibration decision: **`ITERATION4_CALIBRATION_INSUFFICIENT`**.
- Final project decision: **`OCR_PROVIDER_DEFERRED`**.
- No candidate/protocol freeze commit was created after calibration because the selection
  margin did not pass. The pre-measurement commit is not misrepresented as a candidate freeze.
- No Iteration 4 holdout corpus, seed, hash, seal, output, or one-shot state exists. The
  one-shot remains uncreated rather than consumed.
- No PaddleOCR-VL production provider or dependency was added to `apps/assistive-worker`.
- A future attempt requires a new protocol decision and independent evidence; this result
  does not authorise threshold relaxation or use of any historical holdout.

## Verification without PaddleOCR-VL

CI can recompute corpus determinism, historical non-reuse, scoring arithmetic, gate outcomes,
and the terminal decision from tracked bytes without installing Paddle, downloading a model,
loading the VLM, or running OCR:

```bash
python -m assistive_validation_benchmark.ocr_iteration4 check-calibration-evidence
```

The command requires exact canonical equality with the stored report and is wired into
`.github/workflows/assistive-benchmark-ci.yml`.
