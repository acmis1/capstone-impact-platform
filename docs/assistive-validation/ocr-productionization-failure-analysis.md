# PP1 assistive OCR failure decomposition and calibration optimization (Iteration 2A)

## Purpose and scientific status

The merged productionization benchmark concluded **`NEEDS_MORE_OCR_BENCHMARKING`** with every candidate `DEFER`. This iteration does not run another independent holdout. It establishes *why* the OCR pipeline performed poorly and whether a credible configuration is worth spending a fresh holdout on.

This document is **diagnostic and development evidence only**. It is not production OCR integration and not an unbiased production-selection benchmark.

The merged v1 corpus — 16 former calibration cases plus 32 former holdout cases, 48 scored cases in total — has been measured, reviewed and merged. It is therefore treated here as an **exposed development corpus**. Every number below was tuned or measured against data the project has already seen, so none of it is independent holdout evidence and none of it may later be described as such. The machine report records that status in a field that CI re-checks.

The merged evidence in [`evidence/ocr-productionization-report.json`](evidence/ocr-productionization-report.json) is immutable and unchanged; this iteration adds separate evidence in [`evidence/ocr-productionization-diagnostic-report.json`](evidence/ocr-productionization-diagnostic-report.json). The final production gate is untouched: holdout exact-title recovery at least 95% **and** mean WER at most 12%, with zero material false automatic agreements.

## Starting state

| Item | Value |
|---|---|
| `origin/main` | `e3038627adffb86e4dbef264e13684dc3d810049` |
| Migration count | 33 |
| Production worker OCR task providers | `NONE`, `TESSERACT` |
| Coordinator OCR selection | `NONE` |
| Source benchmark version | `pp1-ocr-productionization-v1` |
| Exposed development corpus | 48 scored cases (16 former calibration, 32 former holdout) |
| Branch | `feat/assistive-ocr-failure-analysis` |

## Method, and why a capture step was necessary

The merged report stores per-case metrics but **no OCR blocks**, so failure decomposition is impossible from it alone. This iteration therefore adds a capture step that runs the merged engine adapters unchanged at a chosen raster configuration and stores bounded block text and geometry. Every diagnostic is then a pure deterministic function of a capture file, so the whole analysis re-derives for free and CI can re-check its arithmetic without any OCR.

The capture is only trustworthy if it reproduces the merged measurement. It does, exactly. For all four candidates, every one of the 32 merged holdout cases agrees on both `title_exact` and whole-page WER to within 1e-9, and the merged per-engine holdout exact-title counts reproduce precisely:

| Candidate | Merged holdout exact | Diagnostic capture, same 32 cases | Per-case title agreement | Per-case WER agreement |
|---|---:|---:|---:|---:|
| Tesseract 5.5.3 | 12/32 | 12/32 | 32/32 | 32/32 |
| PP-OCRv6 Tiny | 14/32 | 14/32 | 32/32 | 32/32 |
| PP-OCRv6 Small | 14/32 | 14/32 | 32/32 | 32/32 |
| PP-OCRv6 Medium | 15/32 | 15/32 | 32/32 | 32/32 |

The diagnostic package lives in `tools/assistive-validation-benchmark/src/assistive_validation_benchmark/ocr_failure_analysis/`, deliberately outside `ocr_productionization/` so the merged protocol-freeze tree stays byte-identical. A unit test asserts that separation.

### Staged promotion

PP-OCRv6 Medium is roughly forty times slower per case than Tiny, so configurations were promoted by evidence rather than run exhaustively. The machine record is [`stages.json`](../../tools/assistive-validation-benchmark/ocr-failure-analysis/stages.json).

| Stage | Work | Promotion decision |
|---|---|---|
| 1 | Stored-evidence analysis, no OCR rerun | Merged report has no OCR blocks, so a capture harness is required before any taxonomy can be evidence-backed |
| 2 | Tesseract and Tiny across the full resolution matrix | Resolution moved exact-title recovery by at most one case either way, so no resolution was promoted on title quality; higher raster was promoted for WER only |
| 3 | Small at baseline and at the best Stage 2 configuration | Confirmed the Stage 2 resolution result was not engine-specific; no further configuration promoted to Medium |
| 4 | Medium at the baseline configuration across all 48 cases | No higher-resolution Medium run justified: no material title gain existed to chase, and Medium already exceeds operational ceilings at baseline |
| 5 | Controlled full-poster title stroke A/B probe on all three PP-OCRv6 variants | Terminal stage; measures how much one corpus rendering choice moves the tested candidates |

## Failure decomposition

Categories are computed by deterministic functions from the captured blocks, never assigned by intuition. Precedence is fixed: an exact top-1 recovery is not a title failure (but is flagged `D_READING_ORDER` when a bounded reading order materially reduces whole-page WER); otherwise a title that *is* recoverable from the OCR output is `B_SELECTOR_MISS`; otherwise a title region transcribed close enough to be recognisable is `C_RECOGNITION_ERROR`; otherwise `A_TITLE_ABSENT`. `E_RESOLUTION_SENSITIVE` is applied across the configuration matrix, promoting an `A`/`C` case that a different deterministic raster configuration repairs.

All 48 exposed cases, baseline configuration (150 DPI, 960-pixel long edge), current production selector:

| Candidate | `TITLE_EXACT` | `D` reading order | `B` selector miss | `C` recognition error | `A` title absent | `E` resolution sensitive | `F` other |
|---|---:|---:|---:|---:|---:|---:|---:|
| Tesseract 5.5.3 | 16 | 1 | 16 | 14 | 0 | 1 | 0 |
| PP-OCRv6 Tiny | 19 | 4 | 4 | 19 | 0 | 2 | 0 |
| PP-OCRv6 Small | 16 | 4 | 6 | 20 | 0 | 2 | 0 |
| PP-OCRv6 Medium | 19 | 5 | 7 | 17 | 0 | 0 | 0 |

**`A_TITLE_ABSENT` is zero for every candidate.** The title is never wholly missing from the OCR output. The failures split between ranking the wrong candidate and transcribing the title imperfectly, and those two causes have very different remedies.

The two engine families fail differently. Tesseract's dominant failure is selection (16 selector misses); Medium's dominant failure is transcription (17 recognition errors). A single explanation such as "PP-OCRv6 is simply bad" is not supported.

## Title oracle diagnostic

This is an oracle. It uses ground truth only to ask whether recognition produced the title, separately from whether the metadata-blind selector ranked it first. It must never become a production algorithm, and no selector evaluated here consults the metadata title at runtime.

Baseline configuration, counts out of 48:

| Candidate | Top-1 | Top-3 | Top-5 | Top-8 | In an individual block | Recoverable by bounded adjacent grouping |
|---|---:|---:|---:|---:|---:|---:|
| Tesseract 5.5.3 | 17 | 25 | 33 | 33 | 29 | 33 |
| PP-OCRv6 Tiny | 23 | 25 | 27 | 27 | 24 | 27 |
| PP-OCRv6 Small | 20 | 23 | 25 | 26 | 23 | 26 |
| PP-OCRv6 Medium | 24 | 26 | 27 | 31 | 27 | 31 |

Tesseract recognises the title well enough for exact recovery in 33 of 48 cases and ranks it first in only 17. That 16-case gap is pure ranking failure. Medium's gap is 7 cases. The gap is real for every candidate, so title selection is a genuine and independent defect.

### Why the selector chooses body text

The production ranking scores an adjacent group by the **combined bounding box height** of the whole group. Three consecutive short body lines produce a tall combined box, so they outrank a genuine single-line heading whenever the heading is not much taller than three stacked body lines.

This is not a hypothesis. In all 16 of Tesseract's selector-miss cases the chosen candidate is a three-line group, and in every one of them the group begins with a section heading:

```text
ocr-cal-005  ground truth : Queensland Flood-Forecast Dashboard
             selector chose: BACKGROUND. METHOD 'Synthetic rainfall totals feed a local dashboard ...
```

Several chosen groups also splice text from different columns, because adjacency is computed over provider output order rather than reading order.

## Title-selector study

Every alternative is metadata blind, deterministic and bounded, and every one is scored through the existing deterministic title-safety contract. Exact-title recoveries out of 48, baseline configuration:

| Selector and reading order | Tesseract | Tiny | Small | Medium |
|---|---:|---:|---:|---:|
| `production_geometry_prominence@raw` (merged v1) | 17 | 23 | 20 | 24 |
| `production_geometry_prominence@geometry` | 17 | 23 | 20 | 24 |
| `production_geometry_prominence@column` | 17 | 23 | 19 | 23 |
| `first_line@raw` (Phase 0 blind baseline) | 29 | 24 | 23 | 27 |
| `first_line@geometry` | 29 | 24 | 23 | 27 |
| `top_band_prominence@geometry` | 30 | 24 | 23 | 27 |
| `centred_top_band_prominence@geometry` | 30 | 24 | 23 | 27 |
| **`first_bounded_group@geometry`** | **33** | **27** | **26** | **31** |

`first_bounded_group@geometry` — take the topmost recognised line in geometric reading order, then extend it into a bounded adjacent group of at most three lines of comparable height separated by at most one line height — reaches the oracle ceiling exactly for every candidate. Nothing is left on the table for selection at this configuration.

### On comparing with Phase 0

Phase 0's PP-OCRv6 Medium figure of 92.6% is **not** explained by metadata guidance. The merged Phase 0 report states plainly that "the metadata-guided and metadata-blind tracks are identical for every OCR engine", that guidance "buys nothing on OCR output, because the title is already the first line", and that the title figures "are therefore not inflated by knowing the answer" — guidance helped only PDFium. The stored Phase 0 machine evidence agrees: `title_recovery_rate` and `title_recovery_rate_blind` are equal for all four OCR engines. Any suggestion that Phase 0's OCR result was better because the chooser knew the answer is wrong, and this document previously made that error.

What differs between Phase 0 and v1 is the pipeline, not the presence of ground truth. Phase 0's blind selector was the first non-empty OCR line, on a corpus whose titles were the first line and were drawn without a title stroke; v1 scores a prominence-ranked adjacent-group selector on a differently rendered corpus. Those are materially different corpora, rendering choices and selection algorithms at once, so no single-cause attribution is available from the evidence here. The defensible statement is narrower and is the one the table above supports: **on the exposed v1 corpus, a first-line or bounded-adjacent-group selector recovers markedly more titles than the merged prominence-ranked selector.**

`centred_top_band_prominence` uses horizontal centring, which is pure geometry but does assume posters centre their titles. It is recorded and scored, but it never beat the simpler bounded-group rule, so nothing rests on that assumption.

## WER decomposition

Whole-page WER under provider order, deterministic geometry order and bounded column-aware order. The original merged provider-order measurement is preserved and unchanged; these are additional decompositions of it.

Baseline configuration, mean over 48 cases:

| Candidate | Provider order | Geometry order | Column-aware order | Reading-order share |
|---|---:|---:|---:|---:|
| Tesseract 5.5.3 | 47.6% | 47.5% | 47.1% | 0.5 pp |
| PP-OCRv6 Tiny | 32.9% | 32.9% | 23.4% | 9.5 pp |
| PP-OCRv6 Small | 35.0% | 35.0% | 25.8% | 9.2 pp |
| PP-OCRv6 Medium | 28.9% | 28.9% | 19.8% | 9.1 pp |

For the PP-OCRv6 family, roughly nine percentage points of whole-page WER is page linearisation, not character recognition. Tesseract gains almost nothing because `--psm 3` already performs its own column-aware layout analysis, so its provider order is close to reading order.

The reading-order reconstruction is geometry only and bounded: rows are assembled by vertical overlap; the column region begins at the first row that genuinely contains two horizontally separated blocks; anything above that row is a header band, which keeps a wrapped multi-line title contiguous; columns are clustered by horizontal span with a cap of four, and anything more complex falls back to plain geometry order rather than inventing an ordering.

The layout split shows where this concentrates. PP-OCRv6 Tiny at baseline:

| Layout | Cases | Exact title | Provider-order WER | Best-order WER |
|---|---:|---:|---:|---:|
| One column | 17 | 8 (47.1%) | 8.8% | 8.8% |
| Two column | 16 | 7 (43.8%) | 42.6% | 24.6% |
| Three column | 15 | 8 (53.3%) | 50.0% | 35.0% |

One-column pages need no reordering at all, and multi-column pages are where the entire reading-order penalty lives.

## Resolution and preprocessing study

The merged configuration rasterised scanned PDFs at 150 DPI and downscaled any long edge above 960 pixels. Two facts frame this study.

First, the production worker performs **no downscaling at all**. It accepts up to 40,000,000 pixels per rastered page and 72–200 DPI. The 960-pixel bound was a benchmark-only preprocessing choice, so relaxing it moves the benchmark toward production behaviour rather than away from it.

Second, the corpus posters are up to 1,960 pixels wide, and scanned-PDF cases are written at 180 DPI. Rendering them at 150 DPI discards resolution the source actually has; 180 DPI reproduces the native pixel dimensions exactly. No configuration upscales: a poster whose natural resolution is lower keeps that limitation.

Exact-title recoveries out of 48 under the best selector, with mean provider-order and column-order WER:

| Configuration | Tesseract exact | Tiny exact | Small exact | Tiny WER (raw / column) | p50 | p95 | Peak |
|---|---:|---:|---:|---|---:|---:|---:|
| 150 DPI / 960 px (merged baseline) | 33 | 27 | 26 | 32.9% / 23.4% | 1.33 s | 2.02 s | 517 MiB |
| 150 DPI / 1280 px | 33 | 28 | – | 32.2% / 22.7% | 1.72 s | 2.22 s | 618 MiB |
| 150 DPI / 1600 px | 32 | 27 | – | 32.3% / 21.9% | 2.11 s | 2.92 s | 750 MiB |
| 150 DPI / 1920 px | 31 | 27 | – | 32.2% / 21.8% | 1.26 s | 2.04 s | 900 MiB |
| 180 DPI / 1920 px | 31 | 28 | 27 | 31.9% / 21.1% | 1.51 s | 1.91 s | 902 MiB |
| 200 DPI / 1920 px | 31 | 28 | – | 32.1% / 21.5% | 1.52 s | 2.14 s | 902 MiB |

**Resolution is not the explanation.** Across a more-than-fourfold change in pixel budget, exact-title recovery moves by at most one case in either direction for every engine, and for Tesseract it drifts slightly downward. The merged 960-pixel bound did not cause the exact-title failure.

Resolution does help whole-page WER, by roughly two percentage points for PP-OCRv6 and by a much larger margin for Tesseract (47.6% at baseline to 30.7% at 200 DPI / 1920 px). Only five case-classifications change across the entire matrix (`E_RESOLUTION_SENSITIVE`: one for Tesseract, two each for Tiny and Small, none for Medium).

## A corpus rendering choice measurably moves the tested candidates

Once resolution, selection and reading order are accounted for, the residual failure is transcription of the title. A controlled A/B probe measures how much one corpus rendering decision contributes to it.

The corpus draws poster titles with `stroke_width=1` and a stroke colour equal to the text colour, dilating every title glyph by one pixel. Body text is drawn with no stroke. The probe renders the **complete poster** twice and changes only that stroke. Two properties make it a genuine single-variable manipulation: the stroke variant is proved **pixel-identical to the frozen corpus generator's output for all 48 cases** — same size, same raw pixel buffer, compared before any encoding or OCR runs — and title position is held fixed by always computing layout with the stroked metrics. The proved claim is pixel equality of the rendered image, not equality of encoded asset bytes; both sides are then written through the same corpus media path. Layout, section headings, body text, noise, contrast and the decorative title shadow are all present, so this is not an isolated fragment.

Exact-title recoveries out of 48:

| Candidate | Selector | With stroke | Without stroke | Change |
|---|---|---:|---:|---:|
| PP-OCRv6 Tiny | merged production selector | 23 | 23 | 0.0 pp |
| PP-OCRv6 Small | merged production selector | 20 | 21 | +2.1 pp |
| PP-OCRv6 Medium | merged production selector | 24 | 23 | -2.1 pp |
| PP-OCRv6 Tiny | `first_bounded_group@geometry` | 27 | **35** | **+16.7 pp** |
| PP-OCRv6 Small | `first_bounded_group@geometry` | 26 | **31** | **+10.4 pp** |
| PP-OCRv6 Medium | `first_bounded_group@geometry` | 31 | **36** | **+10.4 pp** |

The two halves of that table are the interesting result. **Under the merged production selector the stroke makes essentially no difference**, because that selector is usually choosing body text regardless of how the title is rendered. The stroke only begins to cost anything once the selector defect is repaired, and it then costs 10 to 17 percentage points. The two defects are not independent: the selector defect masks the rendering effect.

The dilation merges the dot of a lowercase `i` into its stem, and the recognition failures carry exactly that signature, as in `Callbratlon`, `Houslng`, `Hydratlon` and `Reslllent`.

Across the three tested PP-OCRv6 variants, under the best selector, the union of exact recoveries is:

| Measure | Cases | Rate |
|---|---:|---:|
| Recovered by at least one tested candidate, as the corpus renders titles | 33/48 | 68.8% |
| Recovered by at least one tested candidate, stroke removed | **37/48** | **77.1%** |
| Not recovered by any tested candidate in this diagnostic | 11/48 | 22.9% |

**What this union is, and is not.** It describes the three provisioned PP-OCRv6 variants under this diagnostic, and nothing more. It is **not** a maximum for the corpus, and it does not show that no OCR model could do better: an unseen model, a different recognition architecture, or another legitimate deterministic configuration could recover more, and this experiment cannot exclude that. The machine report names the field `tested_engine_union_exact_rate` for exactly this reason, and CI asserts that the stored evidence claims no model-independent limit. An earlier revision of this document drew that stronger inference; it was not supported by the experiment and has been withdrawn.

The eleven cases **not recovered by any tested candidate in this diagnostic** are:

- **six letter-spaced titles**, which the corpus renders by inserting two spaces between every character, destroying word boundaries by construction (`Ca m pus De mand ModelX`);
- **three Unicode cases**, a subscript `CO₂`, an accented `Café`, and an en-dash range `2019–2026` that recognises as `201982026`;
- **two `AI`-initial titles**, where `AI-Enabled` recognises as `Al-Enabled`;
- **one em-dash fusion**, where `Telemetry—CRC-32` recognises as `TelemetryCRC-32`.

Several of these look like unrealistic rendering or scoring choices rather than realistic poster content, which is a reason to revisit the corpus. None of them is a proof of impossibility: a different model may segment letter-spaced text or handle these characters differently, so they are recorded as not recovered here, not as unrecoverable in principle.

What the probe **does** establish is bounded, and sufficient for this iteration's decision: a single corpus rendering parameter moves tested-candidate exact-title recovery by up to 16.7 percentage points, far above the 5-point materiality threshold. That is a measured confound in the development corpus, recorded as `corpus_rendering_confound_detected`.

## Where failures concentrate

Baseline configuration, exact title under the current production selector.

| Slice | Tesseract | Tiny | Small | Medium |
|---|---|---|---|---|
| Clean (24) | 14 (58.3%) | 20 (83.3%) | 18 (75.0%) | 20 (83.3%) |
| Challenging (24) | 3 (12.5%) | 3 (12.5%) | 2 (8.3%) | 4 (16.7%) |
| One column (17) | 10 (58.8%) | 8 (47.1%) | 7 (41.2%) | 10 (58.8%) |
| Two column (16) | 4 (25.0%) | 7 (43.8%) | 5 (31.2%) | 6 (37.5%) |
| Three column (15) | 3 (20.0%) | 8 (53.3%) | 8 (53.3%) | 8 (53.3%) |
| PNG (17) | 7 (41.2%) | 9 (52.9%) | 7 (41.2%) | 10 (58.8%) |
| JPEG (16) | 6 (37.5%) | 6 (37.5%) | 6 (37.5%) | 6 (37.5%) |
| Scanned PDF (15) | 4 (26.7%) | 8 (53.3%) | 7 (46.7%) | 8 (53.3%) |

Condition slices, PP-OCRv6 Tiny at baseline:

| Condition | Cases | Exact title | Provider-order WER |
|---|---:|---:|---:|
| Low resolution | 8 | 0 (0.0%) | 38.2% |
| Compression | 9 | 1 (11.1%) | 50.6% |
| Mild noise | 21 | 2 (9.5%) | 49.6% |
| Wrapped title | 13 | 1 (7.7%) | 47.0% |
| Letter-spaced title | 6 | 0 (0.0%) | 59.4% |
| Decorative title | 10 | 7 (70.0%) | 28.5% |
| Small body text | 9 | 0 (0.0%) | 53.5% |
| Low contrast | 11 | 1 (9.1%) | 55.8% |

Failures concentrate almost entirely in the challenging half. Letter-spaced titles and small body text recover zero exact titles for every candidate, and letter-spacing is the single largest contributor to the corpus's unrecoverable set. Decorative titles are comparatively easy, which is worth noting because it contradicts the intuition that decorative styling is the hard case.

## Title-safety contract

The existing deterministic title-consistency logic was evaluated unchanged, for every selector variant and every candidate.

Baseline configuration, current production selector:

| Candidate | Equality precision | Equality recall | Review precision | Review recall | Material false automatic agreements |
|---|---:|---:|---:|---:|---:|
| Tesseract 5.5.3 | 100.0% | 36.8% | 100.0% | 63.2% | **0** |
| PP-OCRv6 Tiny | 100.0% | 55.3% | 92.3% | 63.2% | **0** |
| PP-OCRv6 Small | 100.0% | 52.6% | 92.3% | 63.2% | **0** |
| PP-OCRv6 Medium | 100.0% | 57.9% | 93.5% | 76.3% | **0** |

Under the best alternative selector, `first_bounded_group@geometry`, recall improves without any safety cost:

| Candidate | Equality precision | Equality recall | Review precision | Review recall | Material false automatic agreements |
|---|---:|---:|---:|---:|---:|
| Tesseract 5.5.3 | 100.0% | 68.4% | 97.0% | 84.2% | **0** |
| PP-OCRv6 Tiny | 100.0% | 63.2% | 100.0% | 71.1% | **0** |
| PP-OCRv6 Small | 100.0% | 60.5% | 100.0% | 71.1% | **0** |
| PP-OCRv6 Medium | 100.0% | 63.2% | 100.0% | 76.3% | **0** |

Equality precision is 100% in every measured combination, and **zero material false automatic agreements occurred in any candidate, any configuration or any selector variant**. No material negative became automatic deterministic agreement. OCR remains untrusted evidence, review remains assistive, and staff authority is unchanged.

## Operational measurements and their comparability

Quality here is deterministic and reproduces the merged measurement exactly. Wall-clock timing is not: the diagnostic machine measured the larger models materially faster than the merged run did.

| Candidate | Merged p50 | Diagnostic p50, same configuration | Ratio |
|---|---:|---:|---:|
| Tesseract 5.5.3 | 202 ms | 212 ms | 1.05 |
| PP-OCRv6 Tiny | 1,123 ms | 1,326 ms | 1.18 |
| PP-OCRv6 Small | 4,578 ms | 2,191 ms | 0.48 |
| PP-OCRv6 Medium | 46,034 ms | 8,955 ms | 0.19 |

The report records this as `latency_comparability.comparable: false`. **The merged operational measurements remain authoritative.** This iteration does not use its own faster timings to overturn the merged conclusion that Medium fails the cold-start, p50 and p95 ceilings, and no operational ceiling is relaxed here.

## Development go/no-go gate

This is not the final production gate. It only tests whether spending another fresh holdout is justified: exact-title recovery at least 90%, mean WER at most 15%, zero material false automatic agreements, all cases executing safely, and operational ceilings that remain plausible for the 16 GiB functional-minimum direction.

Best development candidates, using each engine's strongest safe selector on the exposed corpus:

| Rank | Candidate | Configuration | Selector | Exact title | Mean best-order WER | False agreements | Holdout-worthy |
|---:|---|---|---|---:|---:|---:|---|
| 1 | Tesseract 5.5.3 | 150 DPI / 1280 px | `first_bounded_group@geometry` | 33/48 (68.8%) | 36.3% | 0 | **No** |
| 4 | PP-OCRv6 Medium | 150 DPI / 960 px | `first_bounded_group@geometry` | 31/48 (64.6%) | 18.7% | 0 | **No** |
| 8 | PP-OCRv6 Tiny | 180 DPI / 1920 px | `first_bounded_group@geometry` | 28/48 (58.3%) | 20.1% | 0 | **No** |
| 11 | PP-OCRv6 Small | 180 DPI / 1920 px | `first_bounded_group@geometry` | 27/48 (56.2%) | 20.1% | 0 | **No** |

Ranks are positions in the full 15-configuration ranking; the rows above are each engine's best entry.

**No configuration reaches the development gate.** The best exact-title recovery is 68.8% against a 90% requirement, and the best mean WER is 18.7% against a 15% requirement. Selector and reading order were chosen on the exposed corpus, so these figures are already optimistic; a fresh holdout would be expected to score no better.

Because nothing reached the development gate, **no new holdout is created**, exactly as the iteration contract requires.

## What this evidence does and does not establish

Three defects are established, each with independent evidence:

1. **The title-candidate selector is defective.** Ranking by the combined height of an adjacent group lets three body lines outrank a heading. Replacing it with a bounded top-of-page adjacent group recovers the full oracle ceiling for every candidate — plus 16 cases for Tesseract, plus 7 for Medium — with zero safety cost.
2. **Reading order inflates WER on multi-column pages.** Bounded, geometry-only column reconstruction removes roughly nine percentage points of PP-OCRv6 whole-page WER, and one-column pages need none of it.
3. **A corpus rendering choice measurably moves the tested candidates.** Toggling the title stroke alone, on complete posters, changes exact-title recovery for the tested PP-OCRv6 candidates by more than the materiality threshold under the corrected selector. That is a confound in the development corpus, measured on the candidates actually run.

What is **not** established is that PP-OCRv6 is inadequate. Recognition is numerically the dominant residual failure, but a measured part of it is attributable to a corpus rendering decision rather than to engine capability, so attributing the residual to the model is not supportable from this evidence.

Equally, what is **not** established is any ceiling for OCR models in general. The union figure below describes the three provisioned PP-OCRv6 variants under this diagnostic. An unseen model, a different recognition architecture, or another legitimate deterministic configuration could recover more, and nothing here rules that out. An earlier revision of this document asserted a model-independent corpus ceiling; that inference was not supported by the experiment and has been withdrawn.

Resolution is affirmatively ruled out as a material cause of exact-title failure, and the merged 960-pixel bound is exonerated.

## Recommendation

The evidence is sufficient to reject the resolution hypothesis and to identify two fixable deterministic defects, but insufficient to support either a fresh holdout or a model-challenger benchmark.

The reason is specific and measured, and it is *not* a claim about a corpus ceiling. Under the corrected selector, toggling one corpus rendering parameter moves tested-candidate exact-title recovery by more than the materiality threshold. While a development-corpus rendering choice moves the tested engines that much, the residual recognition failure cannot be cleanly attributed to engine capability, so a challenger benchmark run against this corpus would be scoring rendering robustness alongside recognition quality.

Before Iteration 2B spends either a fresh holdout or a new model, the corpus generator should be corrected so that it measures OCR rather than its own rendering: draw poster titles without stroke dilation, render letter-spaced titles the way real posters set them rather than by inserting two spaces between every character, and either represent Unicode subscripts, accents and dashes in a way the frozen normalisation can score or exclude them from the exact-title metric and score them separately. A corrected corpus should have its own stroke-sensitivity and selector-sensitivity measured before any gate is applied to it, and that corpus change is a new frozen corpus version, not an edit to the merged v1 corpus.

Had no material corpus confound been measured, this evidence would instead have supported `NEEDS_OCR_MODEL_CHALLENGER`, because recognition is the dominant residual failure once selection and reading order are corrected. The decision contract is written so that outcome remains reachable; it is not hard-coded to the answer below.

The two deterministic improvements identified here — the bounded top-of-page title selector and the bounded column-aware reading order — are ready to carry into that work as the challenger configuration, on development evidence.

**`NEEDS_MORE_OCR_FAILURE_ANALYSIS`**

No production OCR provider is selected or activated, no holdout is created, and the 95% / 12% final production gate is unchanged.

## Production boundary and CI

This iteration changes no production OCR behaviour. At the time Iteration 2A was measured, worker OCR task providers were `NONE`, `TESSERACT`; the coordinator selection was `NONE`; the migration count was 33; and no PaddleOCR import existed in any production worker package. Those four values are recorded in the machine report as **historical evidence of the boundary this iteration was performed under**, not as a permanent requirement on future `main`: a later legitimate OCR provider integration may add a provider, change the coordinator selection and add migrations without invalidating anything measured here. No model weights are tracked, and no local language model, vision-language model or cloud AI is used. All corpus content remains synthetic, and OCR text is never used as a command, URL, credential lookup, database input, workflow decision or publication authority.

Lightweight CI additions are cheap and deterministic: they recompute the stored diagnostic arithmetic from its stored per-case rows, re-derive the failure-category counts and the tested-engine union, assert that the stored evidence claims no model-independent ceiling, re-prove the exposed development corpus identity against the frozen corpus parts, re-check the recorded Iteration 2A production boundary as stored historical evidence, and verify by hash that the merged v1 evidence is byte-unchanged and still records `NEEDS_MORE_OCR_BENCHMARKING`. No permanent CI step reads the live worker enum, coordinator selection or migration count; that a benchmark pull request itself touches no production path is enforced separately by the workflow's PR-relative diff over `apps/assistive-worker`, `apps/admin-cms/src/assistive-validation` and `infra/supabase`. The `check-boundary` command remains available as an operator command for inspecting the live boundary on demand. CI does not install PaddlePaddle, download model weights, run neural OCR, require a GPU, or use runtime internet for models.
