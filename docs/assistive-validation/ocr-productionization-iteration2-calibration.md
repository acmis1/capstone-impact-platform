# PP1 assistive OCR Iteration 2 corrected-corpus calibration

## Purpose and boundary

This iteration repairs the OCR development corpus and uses calibration only to decide whether
an already-provisioned neural configuration is strong enough to justify freezing a separate
future holdout protocol. It does not create or measure an independent holdout, claim unbiased
accuracy, select a production provider, or change production behaviour.

The machine-readable evidence is
[`evidence/ocr-productionization-iteration2-calibration.json`](evidence/ocr-productionization-iteration2-calibration.json).
Phase 0, the v1 productionization benchmark, and Iteration 2A remain immutable historical
evidence.

## Starting state

| Item | Value |
|---|---|
| `origin/main` | `5af6dc313680b20e9ba372f3eaf9f62f827ca01d` |
| Migration count | 33 |
| Worker OCR task providers | `NONE`, `TESSERACT` |
| Coordinator OCR selection | `NONE` |
| Production neural OCR | none |
| Merged productionization result | `NEEDS_MORE_OCR_BENCHMARKING` |
| Merged Iteration 2A result | `NEEDS_MORE_OCR_FAILURE_ANALYSIS` |

## Corrected Iteration 2 corpus

Corpus `pp1-ocr-productionization-corpus-v2`, seed `2026082201`, contains 28 scored
calibration cases, one unscored warm-up, three born-digital PDF controls, and two malformed
input controls. Every title and body is synthetic. The corpus contains no `holdout.json`, no
Iteration 2 holdout ID, and no final holdout metric.

| Dimension | Distribution |
|---|---|
| Media | 9 PNG, 10 JPEG, 9 scanned PDF |
| Layout | 9 one-column, 10 two-column, 9 three-column |
| Difficulty | 14 clean, 14 challenging |
| Title style | 15 plain, 6 wrapped, 3 visually tracked, 3 shadowed, 1 explicitly outlined minority |

The cases retain low-resolution inputs, moderate JPEG compression, mild noise, low contrast,
small body text, mixed font sizes, wrapped titles, acronyms, numerals, Australian English,
technical vocabulary, punctuation, Unicode and two material title negatives. Exact normalized
title+body hashes were compared with 87 Phase 0 and v1 scored document cases: reuse was **0**.
This proves corpus novelty/non-reuse only; it is not holdout independence.

All three native PDF controls recovered their title through native extraction. The malformed
PDF failed safely with `PdfiumError`, and the truncated PNG failed safely with `OSError`.

## Rendering corrections

- Normal titles render with no stroke. One labelled `outlined_title_minority` case uses a
  one-pixel outline as a realistic minority style.
- Letter spacing is visual only. The renderer positions the unchanged semantic title string
  glyph by glyph with bounded deterministic pixel tracking; it never inserts whitespace into
  the reference string.
- Wrapping, shadow and outline change pixels only. They do not change title truth or add hidden
  scoring hints.
- Unicode rendering uses the repository-pinned
  [Noto Sans Regular 2.003](https://github.com/googlefonts/noto-fonts/blob/b7086582d72f537474b61285a81e0d30a250bcfa/phaseIII_only/hinted/ttf/NotoSans/NotoSans-Regular.ttf)
  from the official Google Noto repository at commit
  `b7086582d72f537474b61285a81e0d30a250bcfa`, licensed under SIL OFL 1.1.
  The 512,592-byte file has SHA-256
  `114a6bf229142e7aac8ee83e70ca77563b46b16e80e2e50ad3a053b442f969b6`.
  Generation never searches system fonts or downloads at runtime.
- Glyph tests prove real, non-missing glyphs for `é`, `’`, en dash, em dash, `₂`, hyphen and
  the declared ASCII punctuation. Two complete generation passes produced the same corpus
  asset digest: `ab6ba2023c889c7f5910e076d725c187f4030093afd9d87c28c18351bd5273ce`.

## Calibration method

The measured candidates were Tesseract 5.5.3 and the already-frozen PP-OCRv6 Tiny, Small and
Medium model pairs under PaddleOCR 3.7.0, PaddlePaddle CPU 3.3.0 and PaddleX OCR core 3.7.2.
No model or weight was added or downloaded for this iteration.

Stage 1 ran Tesseract, Tiny and Small at:

- 150 DPI for scanned PDF / 960-pixel maximum long edge;
- 180 DPI for scanned PDF / 1920-pixel maximum long edge.

The renderer and raster adapter preserve aspect ratio and never upscale source images. Stage 1
selected 180/1920 for Medium from the cheaper neural results; Medium ran only at that one
configuration.

Every runtime selector is metadata blind, label blind, deterministic and bounded. Ground truth
is used only after inference to score:

- merged `production_geometry_prominence@raw`;
- blind `first_line@raw`;
- Iteration 2A challenger `first_bounded_group@geometry`.

Whole-page WER is reported for provider/raw, geometry and column-aware order. Each ordering is
one fixed geometry-only algorithm applied to every page. No per-page best-of-oracle WER enters
the development gate.

## Selector and title-safety calibration

At the selected Small 180/1920 configuration:

| Selector | Exact title | Equality P / R | Assistive P / R | Material false automatic agreements |
|---|---:|---:|---:|---:|
| Merged production selector | 15/28 (53.6%) | 100% / 34.6% | 100% / 69.2% | 0 |
| First-line blind baseline | 27/28 (96.4%) | 100% / 96.2% | 100% / 100% | 0 |
| `first_bounded_group@geometry` | 28/28 (100%) | 100% / 100% | 100% / 100% | 0 |

The v2 evidence therefore selects `first_bounded_group@geometry` as the calibration challenger.
It did not win by assumption: all three selectors were rerun and scored. Both the flood/fire
material negative and the sensor/censor one-character negative remained non-agreements.

## Reading-order calibration

At Small 180/1920, pooled whole-corpus WER is:

| Deterministic order | Word edits / reference words | WER |
|---|---:|---:|
| Provider/raw | 352/1004 | 35.1% |
| Geometry row order | 352/1004 | 35.1% |
| Column-aware order | 100/1004 | **10.0%** |

Calibration selects column-aware canonical reading order as the primary metric for a future
Iteration 2 holdout protocol. Provider/raw WER remains a required diagnostic. The selected
ordering must be frozen and applied to every future holdout page without label-driven switching.

## Raster and engine calibration

The table uses the best safe selector for each row and column-aware WER. Current-machine timing
and peak working set are recorded as calibration evidence only.

| Engine | Raster | Exact title | Raw WER | Column WER | False agreements | p50 / p95 | Peak working set | Development gate |
|---|---|---:|---:|---:|---:|---:|---:|---|
| Tesseract | 150/960 | 71.4% | 66.3% | 64.3% | 0 | 173 / 245 ms | 69 MiB | fail quality |
| Tesseract | 180/1920 | 64.3% | 67.5% | 55.8% | 0 | 246 / 278 ms | 80 MiB | fail quality |
| PP-OCRv6 Tiny | 150/960 | 100% | 36.8% | 14.2% | 0 | 628 / 730 ms | 497 MiB | pass |
| PP-OCRv6 Tiny | 180/1920 | 100% | 36.2% | 11.2% | 0 | 844 / 1,670 ms | 895 MiB | pass |
| PP-OCRv6 Small | 150/960 | 96.4% | 36.1% | 11.4% | 0 | 1,959 / 2,352 ms | 637 MiB | pass |
| PP-OCRv6 Small | 180/1920 | **100%** | 35.1% | **10.0%** | 0 | 2,355 / 4,317 ms | 1,185 MiB | **pass; selected** |
| PP-OCRv6 Medium | 180/1920 only | 92.9% | 33.4% | 8.5% | 0 | 10,941 / 19,664 ms | 2,303 MiB | fail operational plausibility |

Resolution was kept to the smallest justified pair. Small improves from 96.4%/11.4% at
150/960 to 100%/10.0% at 180/1920. Tiny retains 100% title recovery while column WER improves
from 14.2% to 11.2%. The higher configuration therefore has measured benefit on the corrected
calibration corpus without becoming a broad resolution sweep.

## Operational interpretation

This workstation is not the merged benchmark machine, so its wall-clock results are not treated
as directly comparable. The merged operational evidence remains authoritative for planning:
Tiny and Small remain plausibly within the established cold-start, p50, p95, 4 GiB memory,
1 GiB model-footprint and 90-second per-case limits. Medium remains outside the merged cold-start,
p50 and p95 ceilings and is retained only as a quality reference. No ceiling was loosened.

## Development gate and decision

The selected neural configuration is PP-OCRv6 Small at 180/1920 with
`first_bounded_group@geometry` and fixed column-aware WER:

| Holdout-worthiness requirement | Observed calibration | Result |
|---|---:|---|
| Exact title at least 90% | 28/28 (100%) | pass |
| Primary deterministic-order WER at most 15% | 100/1004 (9.96%) | pass |
| Material false automatic agreements | 0 | pass |
| Every scored case executes safely | 28/28 | pass |
| Operational behaviour remains plausible | yes, using merged Small evidence | pass |

This is a development gate only. The future independent holdout still requires at least 95%
exact-title recovery, at most 12% WER, zero material false automatic agreements, and the
unchanged operational/provisioning/security gates.

## Scientific integrity and production boundary

- Independent holdout created: **NO**.
- Unbiased accuracy claimed: **NO**.
- Historical v1 or Iteration 2A evidence mutated: **NO**.
- Production `SELECT` classification made: **NO**.
- Production OCR provider, coordinator, enum or pipeline changed: **NO**.
- Migration, Supabase, staff UI, publication, Duda or workflow authority changed: **NO**.
- New OCR model, model weights, LLM, VLM, embeddings or cloud AI added: **NO**.

The result authorizes only freezing a protocol before a separate future independent holdout is
created. It does not authorize that holdout to be created in this change and does not authorize
production integration.

**`READY_TO_FREEZE_OCR_ITERATION_2_HOLDOUT_PROTOCOL`**
