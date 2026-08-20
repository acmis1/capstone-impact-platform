# Phase 0 assistive-validation results

Machine-specific evidence from a complete local run. Method, boundaries and reproducibility rules live in [phase-0-benchmark.md](phase-0-benchmark.md); the harness and its commands live in [`tools/assistive-validation-benchmark/`](../../tools/assistive-validation-benchmark/README.md).

Nothing here changes production behaviour. No cloud AI/OCR service, hosted Supabase, publication endpoint or Duda operation was involved, and no embedding model, LLM or VLM was executed.

## Run provenance

| Field | Value |
|---|---|
| Benchmark commit | `20ead408a2d10602d675490b4fd7a1f4854ad65f` |
| Corpus | `pp1-assistive-v2`, seed `539362848` |
| Date | 2026-08-20 |
| OS | Windows 11 Pro 25H2 build 26200 (AMD64) |
| CPU | Intel Core i5-12600K, 16 logical processors |
| RAM | 32 GiB |
| Runtime | Python 3.11.15, Node 24.14.1, Java 21.0.12 (Temurin) |
| GPU | not used; every figure is a CPU measurement |

Engine versions: pypdfium2 5.13.0 (PDFium); Tesseract 5.5.3.20260724 with `eng.traineddata`; PaddleOCR 3.7.0 on PaddlePaddle 3.3.0 CPU with oneDNN disabled; `harper.js` 2.7.0; LanguageTool 6.6 (build 2025-03-27), from `LanguageTool-stable.zip`, SHA-256 `53600506b399bb5ffe1e4c8dec794fd378212f14aaf38ccef9b6f89314d11631`.

Corpus: 85 cases — 39 document (17 calibration / 22 holdout), 32 grammar (14 / 18), 14 duplicate queries (5 / 9) over a shared 42-candidate pool. Splits were fixed in the manifest before any engine ran.

The reviewed raw machine report is preserved as a compact, path-free audit export at [`evidence/phase-0-report.json`](evidence/phase-0-report.json). It retains aggregate, split and per-case outcomes while omitting redundant OCR transcripts and local paths. Its measurements are from the original reviewed run at `20ead408a2d10602d675490b4fd7a1f4854ad65f`; this document and the export apply the clarified decision contract introduced afterwards.

## Measured results

## Native PDF extraction (PDFium)

| Metric | Value |
|---|---|
| Born-digital title recovery, exact after normalization | 100.0% (8/8) |
| Same, metadata-blind first-line baseline | 87.5% |
| Scanned PDFs correctly indicating OCR is required | 100.0% (5/5), all with 0 extractable characters |
| Corrupt PDF control | `doc-025` failed safely: `PdfiumError: Failed to load document` |
| Runtime p50 / p95 | 2.9 ms / 6.5 ms |

Across all 14 PDF cases native extraction recovers 8 titles (57.1%). All eight born-digital cases succeed; all five scanned PDFs yield exactly **0** extractable characters, and the corrupt control raises a clean `PdfiumError: Failed to load document` rather than crashing. Scored as a title-agreement decision over the same 14 cases, native-only extraction reaches 100% precision at 50.0% recall. That gap is the measured justification for the native-first, OCR-only-when-needed order: native extraction is free and exact when it works, and unambiguously reports when it has not.

## OCR comparison

All four engines consumed the identical raster per case. Tesseract ran at `--psm 3` (automatic page segmentation), which is the layout-analysis equivalent of PP-OCR's detection stage.

| Engine | Exact title | Assistive title | Mean CER | Mean WER | Clean WER | Challenging WER |
|---|---:|---:|---:|---:|---:|---:|
| Tesseract 5.5.3 | 85.2% | 88.9% | 10.6% | 16.0% | 17.0% | 14.2% |
| PP-OCRv6 tiny | 85.2% | 88.9% | 5.2% | 11.3% | 4.6% | 22.5% |
| PP-OCRv6 small | 88.9% | 92.6% | 9.2% | 14.6% | 5.7% | 29.8% |
| PP-OCRv6 medium | 92.6% | 96.3% | 5.1% | 11.4% | 0.4% | 30.3% |

"Exact title" is equality after the documented normalization. "Assistive title" also counts near matches a human would still have to confirm; it is not extraction accuracy.

### Cost

Latency comes from the combined run; memory comes from separate one-engine-per-process runs, because in-process peak working set is cumulative and cannot otherwise be attributed.

| Engine | Cold start | Scored p50 | Scored p95 | Attributable peak memory |
|---|---:|---:|---:|---:|
| Tesseract 5.5.3 | n/a (per-invocation process) | 157 ms | 199 ms | 52 MiB (child process) |
| PP-OCRv6 tiny | 2,788 ms | 738 ms | 1,446 ms | 803 MiB |
| PP-OCRv6 small | 4,945 ms | 1,860 ms | 3,477 ms | 1,119 MiB |
| PP-OCRv6 medium | 16,497 ms | 8,081 ms | 16,090 ms | 2,078 MiB |

Cold start is model loading only; weights were already cached for every figure above. The very first PP-OCRv6 tiny execution on this machine, which also downloaded official weights, took 12,388 ms — that number is not comparable and is recorded here only so it is not mistaken for steady state.

Scored latency excludes the empty and oversized-text controls, which are also excluded from quality scoring. Including them makes p95 describe a case no quality metric counts: PP-OCRv6 medium spends 53 s on the oversized-text control alone.

### Reading the WER numbers

Challenging-set WER rises as the model gets better, which looks contradictory until the per-case data is read. The worst cases are `doc-021` (noisy low-resolution two-column JPEG; 136% WER for medium) and `doc-039` (three-column low-resolution poster; 74% for all three PP-OCR variants, while the title is recovered exactly). Stronger detection finds more text regions and emits them in a different linear order, and noise adds spurious words, so whole-page WER is both unbounded above and dominated by page linearisation rather than character recognition. Tesseract's `--psm 3` column handling gives it a much better 26% on `doc-039` despite worse character accuracy elsewhere.

WER is therefore a page-linearisation signal here. Title recovery is the metric that maps onto the actual PP1 task.

## Deterministic title matching

`match_title` returns three decisions: `match` (equality after normalization, an approved alias, or an explicitly allowed subtitle), `review` (lexically close, human decides), `mismatch`.

| Track | Split | Equality path P / R | Assistive path P / R | Review rate |
|---|---|---:|---:|---:|
| manifest labels | calibration | 100.0% / 84.6% | 100.0% / 92.3% | 5.9% |
| manifest labels | holdout | 100.0% / 73.3% | 100.0% / 80.0% | 4.5% |
| PP-OCRv6 medium (guided or blind) | all | 100.0% / 71.4% | 100.0% / 81.0% | 6.9% |
| PP-OCRv6 small (guided or blind) | all | 100.0% / 66.7% | 100.0% / 76.2% | 6.9% |
| Tesseract (guided or blind) | all | 100.0% / 66.7% | 100.0% / 76.2% | 6.9% |
| PP-OCRv6 tiny (guided or blind) | all | 100.0% / 61.9% | 100.0% / 71.4% | 6.9% |
| PDFium, guided | all | 100.0% / 50.0% | 100.0% / 50.0% | 0.0% |
| PDFium, blind | all | 100.0% / 41.7% | 100.0% / 41.7% | 0.0% |

Two things matter here.

**Precision is 100% everywhere; recall is the constraint.** Not one material mismatch was accepted, including the paired one-character negatives. The false negatives are a dropped character (`Evacuaton`), an Australian/American spelling variant (`Analyser` / `Analyzer`), a real-word confusion (`Censor` / `Sensor`) and a morphological variant (`Forecasting` / `Forecast`). Each is a case a human should see, and each is currently routed to `mismatch` rather than `review`.

**The metadata-guided and metadata-blind tracks are identical for every OCR engine.** Guiding candidate selection with the submitter's metadata title buys nothing on OCR output, because the title is already the first line. The title figures are therefore not inflated by knowing the answer. Guidance only helps PDFium (50.0% vs 41.7%), where born-digital titles wrap across lines and have to be rejoined.

### The fuzzy score cannot be thresholded

Among non-equality cases, true matches score 0.766-0.830 and material mismatches score 0.187-0.847. **The ranges overlap.** The clearest pair:

| Case | Metadata title | Poster title | Score | Correct answer |
|---|---|---|---:|---|
| `doc-031` | Solar Microgrid Health Monitor | Solar Microgrid **Heaith** Monitor | 0.820 | match |
| `doc-032` | Urban Heat **Island** Explorer | Urban Heat **Inland** Explorer | 0.817 | mismatch |

Three thousandths of a point apart, opposite correct answers. No threshold separates them. Only the deterministic glyph-confusion rule does, and it decided 2 cases while the threshold branch decided 0. The threshold sweep is still worth running — it shows the value must sit above 0.847 to avoid false positives — but it is a rejection floor, not a decision rule.

## Grammar and spelling

Both engines untuned, Australian English, 32 cases of which 18 are deliberately clean technical prose.

| Engine | Precision | Recall | False positives | of which vocabulary | Clean cases fully silent |
|---|---:|---:|---:|---:|---:|
| Harper 2.7.0 | 50.0% | 52.6% | 10 | 10 | 11/18 |
| LanguageTool 6.6 | 56.0% | 73.7% | 11 | 10 | 10/18 |

Per split — Harper calibration 42.9% / 37.5%, holdout 53.8% / 63.6%; LanguageTool calibration 50.0% / 50.0%, holdout 58.8% / 90.9%.

**Every Harper false positive and 10 of 11 LanguageTool false positives are unknown-vocabulary flags**, not rule misfires: `NebulaGrid`, `microgrid`, `PKCE`, `Nyquist`, `TimescaleDB`, `hypertables`, `Vitest`, `MinIO`, `Mailpit`, `PaddleOCR`, `Redis`, `WebSocket`. LanguageTool's single non-vocabulary false positive is a compound rule firing on `anti-aliasing`.

If a curated domain vocabulary resolved every dictionary-category flag, precision would be 100.0% for Harper and 93.3% for LanguageTool. That is arithmetic on the measured findings, not a result: **no dictionary was built or tuned**, precisely so that no holdout case has been used to improve a number reported as unbiased.

Recall is the other half. Both engines miss subject-verb agreement in several forms (`procedures was`, `Each of the three controllers report`, `The pipeline don't`) and the comma splice; LanguageTool misses less.

## Lexical duplicate baseline

14 queries ranked against a shared 42-candidate pool. The ranking function receives only candidate title and text; relevance, relation and split labels are attached afterwards.

| Split | Exact detection | Recall@1 | Recall@3 | Recall@5 |
|---|---:|---:|---:|---:|
| calibration | 100.0% | 80.0% | 100.0% | 100.0% |
| holdout | 100.0% | 100.0% | 100.0% | 100.0% |
| all | 100.0% | 92.9% | 100.0% | 100.0% |

The one Recall@1 miss is `duplicate-013`: a decoy sharing the full capstone boilerplate sentence and differing only in "timetable" versus "roster" outranks the genuine near duplicate. The true match is still at rank 2, so a shortlist recovers it.

Exact and normalization-only duplicates score 1.0. Paraphrased near duplicates score 0.35-0.53, barely above cross-case noise, which is why the calibration-selected candidate threshold lands at 0.30 and carries a 30% irrelevant-candidate rate at full recall. **The trustworthy interface is a ranked shortlist, not a single similarity threshold.**

## Phase 0 decisions

`SELECT` means the measured component is suitable for the stated bounded role. It does not mean that a neighbouring candidate is a production default, and it never grants autonomous authority over staff review.

| Candidate | Decision | Role | Basis |
|---|---|---|---|
| PDFium native extraction | **SELECT** | deterministic native extraction | 100% exact born-digital title recovery, 2.9 ms p50, safe corrupt failure, and scanned PDFs correctly signal OCR need. |
| Tesseract 5.5.3 | **DEFER** | performance leader | 85.2% exact title recovery and 16.0% WER fail the complete OCR gate (>=95% exact and <=12% WER), despite 157 ms p50 and 52 MiB. It remains a measured candidate, not a production default. |
| PP-OCRv6 tiny | **DEFER** | candidate | Its 85.2% exact title recovery and 11.3% WER do not meet the complete OCR gate. |
| PP-OCRv6 small | **DEFER** | candidate | Its 88.9% exact title recovery and 14.6% WER do not meet the complete OCR gate. |
| PP-OCRv6 medium | **DEFER** | quality leader | Best measured quality (92.6% exact title recovery; 11.4% WER) still misses the 95% exact-title target and costs 8.1 s p50 / 2.1 GiB. |
| Strict title identity check | **SELECT** | safe agreement primitive | The documented normalized-equality, approved-alias, allowed-subtitle and narrow glyph-confusion paths have 100% holdout precision. This is safe agreement only, not high-recall validation. |
| Broader deterministic title consistency | **DEFER** | assistive review | Holdout strict recall is 73.3% and permissive recall is 80.0%; non-identity cases need human review. |
| Fuzzy title scoring | **DEFER** | assistive review | True-match and material-mismatch score ranges overlap. A scalar score must not automatically pass a title. |
| Harper 2.7.0 | **DEFER** | candidate | Untuned precision/recall is 50.0% / 52.6%; vocabulary coverage needs separate evidence. |
| LanguageTool 6.6 | **DEFER** | candidate | Untuned precision/recall is 56.0% / 73.7%; vocabulary coverage needs separate evidence. |
| Lexical duplicate ranking | **SELECT** | assistive shortlist | 100% exact detection and 100% Recall@3/@5. Selection is for ranked candidate generation and human review, not authoritative duplicate classification. |
| Embeddings | **DEFER** | candidate | No lexical shortlist miss currently justifies an embedding benchmark. |
| Generative local LLM | **DEFER** | candidate | Not executed and no measured Phase 0 role requires generative authority. |
| Vision-language model | **DEFER** | candidate | Not executed; specialist OCR has a measured evidence baseline first. |

No candidate is classified `REJECT`. Nothing measured here is bad enough to close off, and nothing was rejected for being unavailable or inconvenient. No candidate is `INSUFFICIENT_EVIDENCE` either: every OCR and grammar engine named in Phase 0 was executed on this machine.

## Provisional Phase 1 recommendation

After maintainer approval and merge, lock PDFium as the selected native-first extraction component; define a provider-independent OCR abstraction; retain the Tesseract and PP-OCRv6-medium evidence without hard-coding an automatic cascade; implement strict deterministic title identity agreement; and route non-equality or ambiguous title cases to assistive review. Grammar, embeddings, local LLMs and VLMs remain later benchmark-driven work.

## What Phase 0 does not establish

- Whether an escalation policy (cheap OCR first, heavy OCR on failure) pays for itself — no confidence signal or failure predictor was measured.
- Whether a curated domain dictionary actually reaches the projected grammar precision — it must be built and then measured on cases held out from its construction.
- Whether the four remaining title false negatives (dropped character, spelling variant, real-word confusion, morphological variant) are best handled by widening the `review` decision or by extending normalization. Both need a decision about staff review-queue volume that Phase 0 did not measure.
- Any figure on real participant material. The corpus is entirely synthetic by design.
- Throughput under concurrency. Every measurement is single-document, single-process.
