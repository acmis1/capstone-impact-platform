# Phase 0 assistive-validation benchmark

## Purpose and boundary

This benchmark exists to decide which specialist, local technologies deserve later PP1 integration. It is research tooling only. Existing deterministic validation remains authoritative, staff remain final authority, and no result changes project lifecycle, review, approval, publication readiness, participant preview, Supabase data, or Duda.

The implementation is isolated at `tools/assistive-validation-benchmark/`. It does not import or extend the dormant `apps/admin-cms/src/lib/gemini/` scaffold and makes no Gemini or other cloud call. Generated files, environments, caches, weights, and reports are ignored.

Executed results live in [phase-0-results.md](phase-0-results.md).

## Current dependency evidence (checked 2026-08-20)

Only official project documentation, repositories, and package indexes were used for freshness and licensing checks:

| Candidate | Version/model evidence | License evidence | Phase 0 treatment |
|---|---|---|---|
| PDFium via pypdfium2 | [pypdfium2 5.13.0](https://pypi.org/project/pypdfium2/) provides Windows x64 wheels and PDFium bindings | pypdfium2: Apache-2.0 or BSD-3-Clause; PDFium: BSD-style; bundled dependency notices also apply | pinned core dependency |
| Pillow | [Pillow 12.3.0](https://pypi.org/project/pillow/) supports Python 3.11+ | MIT-CMU expression on PyPI | pinned deterministic fixture generator |
| PaddleOCR / PP-OCRv6 | [PaddleOCR 3.7.0](https://github.com/PaddlePaddle/PaddleOCR) and [official model list](https://www.paddleocr.ai/main/en/version3.x/pipeline_usage/OCR.html) identify tiny/small/medium det+rec variants | PaddleOCR repository: Apache-2.0. No separate PP-OCRv6 weight license was stated on the inspected official model table; downloaded bundle notices must be checked before production redistribution | optional local CPU adapter; exact model IDs recorded |
| PaddlePaddle | [Windows installation guide](https://www.paddlepaddle.org.cn/documentation/docs/en/install/index_en.html) documents CPU 3.3.0 and Python 3.9-3.13 | Apache-2.0 project license | optional isolated runtime |
| Tesseract | [Tesseract 5.5.3](https://github.com/tesseract-ocr/tesseract/releases) is the current stable release and the only asset it publishes is the official `tesseract-ocr-w64-setup` Windows installer | Apache-2.0; Leptonica dependency is BSD-2-Clause | installed locally from the project's own winget publisher `tesseract-ocr.tesseract`; executed |
| Harper | [Harper 2.8.0](https://github.com/Automattic/harper/releases) is the current monorepo release; the npm registry published `harper.js` 2.7.0 when checked. [Official Node guidance](https://writewithharper.com/docs/harperjs/node) documents the local WASM adapter | Apache-2.0 | isolated `harper.js` 2.7.0 Node adapter; runtime package version recorded |
| LanguageTool | The project's own [download index](https://languagetool.org/download/) publishes numbered self-hosted ZIPs up to 6.6 plus `LanguageTool-stable.zip`, and Maven Central carries numbered `org.languagetool:languagetool-server` artifacts through 6.8; the GitHub repository has tags `v6.7` and `v6.8` but publishes no GitHub release assets | LanguageTool core: LGPL-2.1-or-later; third-party notices apply | user-supplied loopback server pinned to the numbered stable distribution, never a `-SNAPSHOT` build; archive SHA-256 and runtime version recorded |

The benchmark report, not this candidate list, owns SELECT / REJECT / DEFER / INSUFFICIENT_EVIDENCE decisions. Unavailable installation is not evidence of poor quality.

## Reproducibility rules

- Pin numbered releases. A moving `-SNAPSHOT` or `latest` archive cannot be reproduced by a later reviewer and must not underpin Phase 0 evidence. Record the exact archive and its SHA-256.
- Record model identifiers, framework versions, and every execution setting that changes the measurement (device, oneDNN, page segmentation mode, dialect).
- Record whether a cold start also downloaded weights. A first run that fetches a model is not comparable with one that loads a cached model.
- Run one OCR variant per process whenever memory is being compared. In-process peak working set is monotonic and cumulative, so two variants in one process share a peak and the second one's figure silently includes the first one's resident model.
- Assign calibration and holdout splits in the manifest before any engine executes, and never tune a threshold or a custom dictionary using holdout cases.

## Interpretation

- Native born-digital PDFs are measured before OCR. Exploratory extraction signals are not production thresholds.
- OCR reports CER, WER, exact-normalized title recovery, a separate permissive assistive agreement rate, per-case latency, cold start, warm and scored-case p50/p95, failures, model IDs, settings, and best-available peak process memory with its attribution stated.
- `title_recovery_rate` always means exact equality after the documented normalization. A near match is never counted as successful extraction; it is reported separately as an assistive rate.
- Whole-page WER can be depressed by multi-column reading order even when the title is recovered perfectly; the corpus includes one-, two- and three-column cases precisely so that this limitation stays visible.
- Title matching produces three decisions — confident match, review, mismatch — because Phase 0 measurement showed that a single boolean hides where the evidence is. The report gives the equality path and the permissive path separately, per split, and for the manifest labels as well as for candidates that extractors actually produced.
- The corpus deliberately contains paired title cases that differ by a single character in both directions: an OCR glyph confusion that should still match, and a material substitution that must not. Their weighted lexical scores overlap, which is the evidence that the fuzzy score alone cannot be turned into a trustworthy automatic threshold.
- Grammar findings are span-matched to labelled technical-English cases written in Australian English, matching both engines' configured dialect so that a dialect mismatch cannot be miscounted as a tool false positive. Valid acronyms, product names and project names contribute false positives if flagged. No custom dictionary tuning is applied to either engine.
- Duplicate evaluation reports exact detection, Recall@1/3/5, irrelevant-candidate rate at a calibration-selected threshold, and complete rankings. The ranking function sees only candidate title and text. No embedding or vector database is present.

See the tool README for setup, exact commands, corpus extension, challenger extension, and cleanup.
