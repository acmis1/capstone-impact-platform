# PP1 assistive OCR Iteration 2 final holdout result

## Purpose and boundary

This document records the outcome of the single authorised run against the sealed Iteration 2
fresh holdout. It is a closure record, not a new measurement: the one-shot has been consumed,
and the same holdout must never be rerun.

The final decision is **`OCR_PROVIDER_DEFERRED`**.

The machine-readable evidence lives in
[`evidence/ocr-iteration2-fresh-holdout/`](evidence/ocr-iteration2-fresh-holdout/): the raw
[`one-shot-state.json`](evidence/ocr-iteration2-fresh-holdout/one-shot-state.json),
[`holdout-capture.json`](evidence/ocr-iteration2-fresh-holdout/holdout-capture.json) and
[`holdout-report.json`](evidence/ocr-iteration2-fresh-holdout/holdout-report.json) exactly as
the run wrote them, plus the binding manifest
[`result-evidence.json`](evidence/ocr-iteration2-fresh-holdout/result-evidence.json).

Phase 0, the v1 productionization benchmark, the Iteration 2A failure analysis, the corrected
Iteration 2 calibration, the distractor development evidence, and the holdout protocol freeze
and seal all remain immutable historical evidence. This result is a later layer on top of
them, not a revision of them.

## Run identity

| Item | Value |
|---|---|
| Execution commit | `62930574a848cd517415bf6e4e6a7d105dda7a5c` |
| Protocol | `pp1-ocr-iteration2-holdout-protocol-v3` |
| Corpus SHA-256 | `137484e7b0741b2428f2f53e179f2c85f6c9163ac65256a4619c3f27ca5d2bab` |
| Pre-run seal SHA-256 | `304ba342fd61a9fc781e4c161d162028d1087f4cb98319f71bc10f7aed53409d` |
| Freeze tree SHA-256 | `088d2a43da5c2595ff9098b6cabbc3af19582930ae741fc64dc0878768aef282` |
| Candidate | PP-OCRv6 Small (`paddle-small`) |
| Configuration | 180 DPI, 1920 px max edge, CPU |
| Selector | `top_band_prominence@geometry` |
| Primary reading order | `column` |
| OCR runs | 1 |
| Rerun permitted | no |

| Evidence file | Bytes | SHA-256 |
|---|---|---|
| `one-shot-state.json` | 489 | `ac29eeab48a906c8bc736854a1538b7eddb4b67345475e78e4c57d19f2c768fd` |
| `holdout-capture.json` | 58,432 | `e0d2937af63c35d355c300106833f32e08c3fb7bfe9239a2d5b57f3769b75ac3` |
| `holdout-report.json` | 17,975 | `505f7d30196a4ed19a4853be9c0ff4e61d4afbb976c8c92876cb001596df323f` |

The state file's `result_sha256` equals the canonical hash of the report, so the recorded
result is bound to the run that produced it.

## Measured

All figures below were recomputed from the preserved capture through the frozen scoring path
and reproduce the stored report byte-for-byte.

- One authorised run; 40 of 40 scored cases executed; 0 OCR failures; no missing, unexpected
  or duplicated case identities.
- Exact title recovery **38 / 40 = 95%**, meeting the frozen minimum of 38. **Passes.**
- Material false automatic agreements **0**, at the frozen maximum of 0. **Passes.**
- Primary frozen WER, column-aware order: **364 / 2296 ≈ 0.1585365854 (15.8536585%)** against
  a frozen maximum of **12%**. **Fails.**
- Required diagnostics: raw order 885 / 2296 ≈ 38.5452962%; geometry order 885 / 2296 ≈
  38.5452962%; clean stratum ≈ 16.0590278%; challenging stratum ≈ 15.6468531%.
- Equality path: TP 31, FP 0, TN 8, FN 1 — precision 100%, recall 96.875%.
- Assistive path: TP 32, FP 1, TN 7, FN 0 — precision ≈ 96.9697%, recall 100%.
- Operational: cold start ≈ 19,416.4232 ms; p50 ≈ 4,216.9996 ms; p95 ≈ 4,564.3545 ms; slowest
  case ≈ 4,610.8214 ms; peak working set 1,011,671,040 bytes; artifact footprint 31,481,281
  bytes. All inside the frozen ceilings, and the historical operational prior still passes.

### Gate families

The decision contract requires all five families to pass and forbids selecting on a near miss.

| Gate family | Outcome |
|---|---|
| `quality` | **FAIL** |
| `title_safety` | PASS |
| `operational` | PASS |
| `provisioning` | PASS |
| `offline_security` | PASS |

Within `quality`: all scored cases executed **PASS**, exact-title gate **PASS**, primary WER
gate **FAIL**.

Because `quality` fails, the run cannot be `READY_FOR_OCR_PROVIDER_INTEGRATION`. The final
decision is **`OCR_PROVIDER_DEFERRED`**. The 95% exact-title pass is not sufficient on its
own, and a near miss on WER does not permit selection.

## Bounded diagnostic observations

These observations describe the recorded run. They are diagnostic only and must never be used
as a retroactive selection path or as a target to tune against.

The two exact-title misses were `ocr2h-006` (`jpeg` / `two_column`) and `ocr2h-026`
(`scanned_pdf` / `three_column`). Both lost the final word of a wrapped title —
"Accessible Campus Navigation **Guide**" and "Regional Telehealth Queue **Simulator**". The
title-safety path still handled both without a material false automatic agreement:
`ocr2h-006` was classified `MISMATCH` and `ocr2h-026` `REVIEW`.

The WER-heavy cases are dominated by block ordering rather than by transcription loss. Across
all 40 cases the hypothesis carried 2,275 words against 2,296 reference words, and the edit
operations decompose into 53 substitutions, 166 deletions and 145 insertions. In the six
highest-WER cases the hypothesis word count equals the reference word count exactly, with zero
or one substitution and equal deletions and insertions — the signature of correctly recognised
text emitted in a different sequence, not of missing text. Eleven cases scored exactly zero
edits, which also confirms the reference-text construction is faithful to what was rendered.

### Media and layout allocation is confounded

In the sealed holdout the media and layout dimensions are perfectly aliased. Every PNG case is
one-column, every JPEG case is two-column, and every scanned-PDF case is three-column, so only
3 of the 9 possible media/layout combinations occur:

| Media | one-column | two-column | three-column |
|---|---|---|---|
| PNG | 14 | 0 | 0 |
| JPEG | 0 | 13 | 0 |
| scanned PDF | 0 | 0 | 13 |

The media and layout breakdowns in the report are therefore numerically identical by
construction (PNG / one-column: 14 cases, 14 exact, 7.6923077% WER; JPEG / two-column: 13
cases, 12 exact, 9.5046854% WER; scanned PDF / three-column: 13 cases, 12 exact, 32.3863636%
WER). Difficulty is properly crossed with media and is not affected.

**Consequence:** this result cannot establish whether the high-WER stratum is caused primarily
by scanned-PDF rasterisation, by three-column layout, by their interaction, or by another
correlated factor. It is not stated here that scanned PDFs caused the failure, nor that
three-column layouts caused the failure.

This confounding limits causal diagnosis only. It does not weaken the aggregate decision: the
frozen quality gate is defined on the overall primary WER across all 40 cases, which is
15.8536585% against a 12% maximum regardless of how media and layout are factorised. The
decision is also robust to the aggregation choice — the corpus-aggregate WER is 15.8536585%
and the mean of per-case WERs is 16.3463743%, both above the frozen maximum.

A future iteration that wants to attribute cause would need media and layout allocated
independently in a new corpus, under a new protocol decision.

## Not claimed

- PP-OCRv6 Small is **not** established as production-ready.
- No neural OCR provider has been selected.
- No production PaddleOCR integration exists.
- No AI or OCR workflow authority changed.
- No provider may be selected from this near miss.
- No causal claim is made between scanned-PDF media and three-column layout performance,
  because their allocation is confounded.
- The reading-order observation above is a description of the recorded run, not a proposal to
  replace the frozen primary metric.

## Scientific consequence

- The one-shot has been consumed. This holdout must never be rerun.
- It must never be tuned against, and post-hoc diagnostics must never become a retroactive
  selection path.
- Any future OCR iteration requires a new protocol decision and a newly generated, separately
  sealed fresh holdout.
- This result does not authorise that work.

## Project consequence

Production behaviour is unchanged. PaddleOCR is not added to the worker, provider and
coordinator selection are untouched, no migration is added, and no VLM work is started.

## Verification without OCR

The result can be re-proved from tracked evidence alone:

```bash
python -m assistive_validation_benchmark.ocr_iteration2_fresh_holdout check-result-evidence
```

The check verifies the exact byte size and SHA-256 of each preserved file, that each is
canonical JSON, the state schema and consumed-run semantics, the state-to-report hash binding,
the frozen protocol/corpus/candidate/selector identities, and the capture case identities. It
then re-scores the tracked capture through the same frozen scoring path the run used, requires
the recomputed report to equal the tracked report canonically and to match the hash the run
recorded, re-verifies the arithmetic and the five gate families, and requires the decision to
be exactly `OCR_PROVIDER_DEFERRED`.

It loads no OCR provider, downloads no model, needs no Paddle runtime, and does not read the
ignored local run directory, so it runs in clean lightweight CI and is wired into
`.github/workflows/assistive-benchmark-ci.yml`.
