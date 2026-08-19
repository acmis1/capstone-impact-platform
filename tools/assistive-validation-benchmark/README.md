# PP1 assistive-validation benchmark

This directory is an isolated, local-only Phase 0 evidence harness. It measures native PDF extraction, OCR, deterministic title consistency, grammar/spelling tools, and lexical duplicate ranking on deterministic synthetic PP1-style material. It does not import application code, alter workflow state, access Supabase, call cloud AI/OCR, publish, or grant any document instruction authority.

## Quick start

Use Python 3.11. The production Admin/CMS dependency graph is intentionally not involved.

```powershell
cd tools/assistive-validation-benchmark
py -3.11 -m venv .venv
.venv\Scripts\python -m pip install --upgrade pip
.venv\Scripts\python -m pip install -e .
.venv\Scripts\python -m assistive_validation_benchmark validate
.venv\Scripts\python -m assistive_validation_benchmark run --output-dir artifacts\baseline
```

The default run attempts native PDFium extraction, Tesseract, PP-OCRv6 small and medium, title matching, Harper, local LanguageTool, and lexical duplicate ranking. Missing optional engines are recorded as `NOT EXECUTED` / `INSUFFICIENT_EVIDENCE`; they do not make the command fail and are never treated as quality results.

Select sections or OCR variants explicitly:

```powershell
.venv\Scripts\python -m assistive_validation_benchmark run `
  --sections native,ocr,title `
  --ocr-engines tesseract,paddle-tiny,paddle-small,paddle-medium `
  --seed 539362848 `
  --output-dir artifacts\ocr-comparison
```

Outputs are `report.json`, `summary.md`, generated `corpus/`, and temporary PDF renders. All are gitignored.

## Optional local engines

### PP-OCRv6

The benchmark pins PaddleOCR 3.7.0 and CPU PaddlePaddle 3.3.0. On Windows, install the CPU runtime from PaddlePaddle's official index, then the optional benchmark extra:

```powershell
.venv\Scripts\python -m pip install paddlepaddle==3.3.0 -i https://www.paddlepaddle.org.cn/packages/stable/cpu/
.venv\Scripts\python -m pip install -e ".[paddle]"
```

The first execution of a selected PP-OCRv6 variant may download its official model weights into the user's Paddle cache. The harness never downloads from a fixture-controlled URL and never tracks weights. CPU is the default even when a GPU exists. The Windows adapter disables oneDNN because PaddlePaddle 3.3.0's oneDNN executor fails on the PP-OCRv6 graph with an unsupported PIR array-attribute conversion; the backend choice is recorded in every result.

Supported explicit pairs:

- tiny: `PP-OCRv6_tiny_det` + `PP-OCRv6_tiny_rec`;
- small: `PP-OCRv6_small_det` + `PP-OCRv6_small_rec`;
- medium: `PP-OCRv6_medium_det` + `PP-OCRv6_medium_rec`.

### Tesseract

Install Tesseract 5.5.2 through an appropriate local system package and ensure `tesseract` is on `PATH`, or set `TESSERACT_CMD` to the executable. The harness invokes it directly with an argument array; fixture content never reaches a shell command.

### Harper

Harper runs offline through isolated `harper.js` 2.7.0 and Node 24. The adapter uses Harper's official inlined WASM export so Windows worktree paths containing spaces do not affect model loading. The package version is recorded separately from the Harper monorepo release:

```powershell
npm install
```

`node_modules/` is local and ignored. The generated package lock should be retained when dependency installation is intentionally refreshed so the benchmark records an exact graph.

### LanguageTool

Use a local LanguageTool snapshot with Java 17 or later. LanguageTool moved from numbered releases to daily snapshots after 6.6. Start the embedded server on loopback, for example from the unpacked distribution:

```powershell
java -cp languagetool-server.jar org.languagetool.server.HTTPServer --config server.properties --port 8081
```

The adapter refuses non-loopback URLs. It never uses LanguageTool's cloud endpoint. The report records the version returned by the local server. Pass `--languagetool-pid <PID>` to include the Java server's peak working set; without it, memory is explicitly unmeasured.

## Corpus and metrics

`corpus/manifest.json` is the committed machine-readable ground truth. Generated binary fixtures are reproducible from the manifest and seed. The 42 cases cover born-digital and scanned PDF, PNG, JPEG, layout/quality challenges, title variants and critical negatives, clean and faulty technical English, exact/near/topic duplicates, corrupt/empty/unsupported inputs, bounded long text, and an inert visible prompt-injection sentence.

OCR CER/WER uses only NFKC Unicode normalization plus whitespace collapse. It does not remove punctuation or fold case. Title comparison has a separately documented normalization path for Unicode, case, whitespace, common dash/quote forms, and punctuation. The threshold is selected on calibration cases and evaluated on holdout cases. Whole-poster WER can be pessimistic for multi-column reading order, so title recovery remains separate.

Duplicate results are rankings, not one opaque label. Every query is ranked against the shared candidate pool (24 candidates in corpus v1), using canonical SHA-256 equality, normalized title equality, token overlap, and character trigram cosine similarity. Embeddings are intentionally absent.

## Tests

```powershell
.venv\Scripts\python -m unittest discover -s tests -v
.venv\Scripts\python -m assistive_validation_benchmark generate --output-dir artifacts\repeat-a
.venv\Scripts\python -m assistive_validation_benchmark generate --output-dir artifacts\repeat-b
```

Unit tests cover manifest rejection, traversal protection, CER/WER edge cases, normalization, the flood/fire critical negative, OCR-like title substitutions, lexical ranking, deterministic asset bytes, report generation, local-only LanguageTool, and missing Tesseract behavior. Heavy models are never a normal CI prerequisite.

## Adding a case or challenger

Add one bounded entry to `corpus/manifest.json`, keep all text synthetic, assign `calibration` or `holdout` before looking at results, and extend `manifest.py` only if a genuinely new case shape is needed. Rerun validation, deterministic generation, and unit tests.

New engines belong behind a local adapter in `engines.py`. An adapter must return explicit `ok`, `failed`, or `unavailable` status; record versions/model IDs/runtime/memory; accept only bounded local files or loopback services; and remain outside the Admin/CMS package graph.

## Cleanup

Delete only the chosen `artifacts/<run>` directory, the local `.venv`, isolated `node_modules`, or user-level Paddle model cache after confirming the exact path. Do not clean the repository worktree. Benchmark reports are machine-specific and must be rerun after material tool/model changes.
