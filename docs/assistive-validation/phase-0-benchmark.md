# Phase 0 assistive-validation benchmark

## Purpose and boundary

This benchmark exists to decide which specialist, local technologies deserve later PP1 integration. It is research tooling only. Existing deterministic validation remains authoritative, staff remain final authority, and no result changes project lifecycle, review, approval, publication readiness, participant preview, Supabase data, or Duda.

The implementation is isolated at `tools/assistive-validation-benchmark/`. It does not import or extend the dormant `apps/admin-cms/src/lib/gemini/` scaffold and makes no Gemini or other cloud call. Generated files, environments, caches, weights, and reports are ignored.

## Current dependency evidence (checked 2026-08-20)

Only official project documentation, repositories, and package indexes were used for freshness and licensing checks:

| Candidate | Version/model evidence | License evidence | Phase 0 treatment |
|---|---|---|---|
| PDFium via pypdfium2 | [pypdfium2 5.13.0](https://pypi.org/project/pypdfium2/) provides Windows x64 wheels and PDFium bindings | pypdfium2: Apache-2.0 or BSD-3-Clause; PDFium: BSD-style; bundled dependency notices also apply | pinned core dependency |
| Pillow | [Pillow 12.3.0](https://pypi.org/project/pillow/) supports Python 3.11+ | MIT-CMU expression on PyPI | pinned deterministic fixture generator |
| PaddleOCR / PP-OCRv6 | [PaddleOCR 3.7.0](https://github.com/PaddlePaddle/PaddleOCR) and [official model list](https://www.paddleocr.ai/main/en/version3.x/pipeline_usage/OCR.html) identify tiny/small/medium det+rec variants | PaddleOCR repository: Apache-2.0. No separate PP-OCRv6 weight license was stated on the inspected official model table; downloaded bundle notices must be checked before production redistribution | optional local CPU adapter; exact model IDs recorded |
| PaddlePaddle | [Windows installation guide](https://www.paddlepaddle.org.cn/documentation/docs/en/install/index_en.html) documents CPU 3.3.0 and Python 3.9-3.13 | Apache-2.0 project license | optional isolated runtime |
| Tesseract | [Tesseract 5.5.2](https://github.com/tesseract-ocr/tesseract/releases) is the current stable source release | Apache-2.0; Leptonica dependency is BSD-2-Clause | external local executable adapter |
| Harper | [Harper 2.8.0](https://github.com/Automattic/harper/releases) is the current monorepo release; the npm registry published `harper.js` 2.7.0 when checked. [Official Node guidance](https://writewithharper.com/docs/harperjs/node) documents the local WASM adapter | Apache-2.0 | isolated `harper.js` 2.7.0 Node adapter; runtime package version recorded |
| LanguageTool | [official roadmap](https://github.com/languagetool-org/languagetool-org.github.io/blob/master/roadmap.md) says snapshots replaced fixed releases after 6.6; [local server guide](https://github.com/languagetool-org/languagetool-org.github.io/blob/master/http-server.md) documents embedded loopback operation | LanguageTool core: LGPL-2.1-or-later; third-party notices apply | user-supplied loopback server; runtime version recorded |

The benchmark report, not this candidate list, owns SELECT / REJECT / DEFER / INSUFFICIENT_EVIDENCE decisions. Unavailable installation is not evidence of poor quality.

## Interpretation

- Native born-digital PDFs are measured before OCR. Exploratory extraction signals are not production thresholds.
- OCR reports CER, WER, title recovery, normalized title accuracy, per-case latency, p50/p95, failures, model IDs, and best-available peak process memory.
- Multi-column reading order can depress WER even when titles are recovered; this limitation stays visible.
- Title matching uses an explicit calibration/holdout split and includes the required flood/fire critical negative.
- Grammar findings are span-matched to the same labelled technical-English cases. Valid acronyms and terminology contribute false positives if flagged.
- Duplicate evaluation reports exact detection, Recall@1/3/5, irrelevant-candidate rate, and complete rankings. No embedding or vector database is present.

See the tool README for setup, exact commands, corpus extension, challenger extension, and cleanup. A checked-in machine evidence summary is added only after a complete representative comparison actually executes; missing results are never fabricated.
