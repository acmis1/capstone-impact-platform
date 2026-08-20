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

### Export reviewed evidence

The runnable report intentionally retains full local diagnostic output. To preserve a reviewed synthetic run without
committing local paths or redundant OCR transcripts, export a compact audit copy. It preserves aggregate, split and
per-case outcomes and recalculates the current decision contract from the recorded results:

```powershell
.venv\Scripts\python -m assistive_validation_benchmark export-evidence `
  --input-report artifacts\final-v2\report.json `
  --output ..\..\docs\assistive-validation\evidence\phase-0-report.json
```

Use this only for a validated synthetic report from the recorded benchmark commit; it does not run an engine or alter
any measured value.

### Run one OCR variant per process when memory matters

The harness can only observe the peak working set of the whole benchmark process, and that figure is
monotonic. Two PP-OCR variants selected in one command therefore share a peak: the second variant's
number silently includes the first variant's resident model. Every report states this in
`memory_attribution` and `memory_note`, but the only way to obtain an attributable figure is one
variant per invocation:

```powershell
foreach ($variant in "tiny", "small", "medium") {
  .venv\Scripts\python -m assistive_validation_benchmark run `
    --sections ocr --ocr-engines "paddle-$variant" --output-dir "artifacts\v2-paddle-$variant"
}
```

Latency is unaffected by co-residency, so a single combined run remains valid for runtime comparison.

## Optional local engines

### PP-OCRv6

The benchmark pins PaddleOCR 3.7.0 and CPU PaddlePaddle 3.3.0. On Windows, install the CPU runtime from PaddlePaddle's official index, then the optional benchmark extra:

```powershell
.venv\Scripts\python -m pip install paddlepaddle==3.3.0 -i https://www.paddlepaddle.org.cn/packages/stable/cpu/
.venv\Scripts\python -m pip install -e ".[paddle]"
```

The first execution of a selected PP-OCRv6 variant may download its official model weights into the user's Paddle cache. That first call is reported separately as `cold_start_ms` and excluded from every warm latency figure. The harness never downloads from a fixture-controlled URL and never tracks weights. CPU is the default even when a GPU exists. The Windows adapter disables oneDNN because PaddlePaddle 3.3.0's oneDNN executor fails on the PP-OCRv6 graph with an unsupported PIR array-attribute conversion; the backend choice and every other execution setting are recorded in `settings` on each result.

Supported explicit pairs:

- tiny: `PP-OCRv6_tiny_det` + `PP-OCRv6_tiny_rec`;
- small: `PP-OCRv6_small_det` + `PP-OCRv6_small_rec`;
- medium: `PP-OCRv6_medium_det` + `PP-OCRv6_medium_rec`.

### Tesseract

Tesseract publishes an official Windows installer from its own repository. Install it from the
project's own winget publisher, or from the equivalent release asset, and confirm the version:

```powershell
winget install --id tesseract-ocr.tesseract --version 5.5.3 --exact --source winget --scope machine
& "C:\Program Files\Tesseract-OCR\tesseract.exe" --version
```

Machine scope needs elevation. Afterwards ensure `tesseract` is on `PATH`, or set `TESSERACT_CMD` to the executable. The harness invokes it directly with an argument array; fixture content never reaches a shell command.

The adapter defaults to `--psm 3` (automatic page segmentation) and records the mode in `settings`.
That default matters for fairness: `--psm 6` treats the page as a single uniform block, which
suppresses layout analysis and is not equivalent to PP-OCR's detection stage, so the two engines
would not be compared on equal terms. Override with `--tesseract-psm` only with a stated reason.

### Harper

Harper runs offline through isolated `harper.js` 2.7.0 and Node 24. The adapter uses Harper's official inlined WASM export so Windows worktree paths containing spaces do not affect model loading. The package version is recorded separately from the Harper monorepo release:

```powershell
npm install
```

`node_modules/` is local and ignored. The generated package lock should be retained when dependency installation is intentionally refreshed so the benchmark records an exact graph.

### LanguageTool

Use a local LanguageTool distribution with Java 17 or later, started on loopback:

```powershell
java -cp languagetool-server.jar org.languagetool.server.HTTPServer --config server.properties --port 8081
```

**Pin a numbered release, not a snapshot.** `LanguageTool-stable.zip` on the project's own download
index is the newest packaged self-hosted server distribution and is a fixed numbered release; the
project also publishes numbered `org.languagetool:languagetool-server` artifacts on Maven Central
beyond that. A `-SNAPSHOT` build is a moving target and cannot be reproduced by a later reviewer, so
it must not be the basis of long-lived Phase 0 evidence. Record the exact archive and its SHA-256
alongside any grammar result.

The adapter refuses non-loopback URLs. It never uses LanguageTool's cloud endpoint. The report records the version returned by the local server. Pass `--languagetool-pid <PID>` to include the Java server's peak working set; without it, memory is explicitly unmeasured. `--languagetool-language` selects the dialect sent to the server and defaults to `en-AU`, matching Harper's configured dialect and the corpus's Australian-English clean cases.

## Corpus and metrics

`corpus/manifest.json` is the committed machine-readable ground truth. Generated binary fixtures are reproducible from the manifest and seed. Corpus `pp1-assistive-v2` holds 85 cases: 39 document, 32 grammar, and 14 duplicate queries over a shared 42-candidate pool. Splits are assigned in the manifest before any engine runs.

Document cases cover born-digital and scanned PDF, PNG, JPEG, eight distinct typeface classes, one-, two- and three-column layouts, tables, diagrams, rotation, skew, noise, low resolution, stylized titles, title variants and critical negatives, corrupt/empty/unsupported inputs, bounded long text, and an inert visible prompt-injection sentence. The typefaces that actually resolved on the running machine are recorded in `generation.json`, because a silent font fallback would quietly remove the typographic variation the manifest claims.

### Title metrics

`match_title` reports three decisions rather than one boolean:

- `match` — equality after the documented normalization, an approved alias, or an explicitly allowed subtitle. This is the only confident automatic agreement.
- `review` — lexically close but not equal. Assistive only; a human decides.
- `mismatch` — clearly different.

The report shows the equality path and the permissive assistive path separately, per split, so a loose near match can never be read as successful extraction. It also reports the score range occupied by true matches and by material mismatches: on this corpus those ranges overlap, which is the evidence that no single fuzzy threshold can separate OCR noise from a one-token substitution.

Title evidence is reported in two kinds of track. The **manifest-label track** compares the metadata title with the poster title declared in the corpus; it isolates the matcher, exercises no extraction, and is an upper bound. The **extracted-candidate tracks** feed the matcher the candidate an extractor actually produced, in both a metadata-guided and a metadata-blind variant.

### OCR metrics

CER/WER use only NFKC Unicode normalization plus whitespace collapse. They do not remove punctuation or fold case. Whole-poster WER can be pessimistic for multi-column reading order, so title recovery is reported separately, and `title_recovery_rate` means exact equality after normalization — never a fuzzy match.

Latency is reported as cold start, warm p50/p95, and scored-case p50/p95. The empty and oversized-text controls are excluded from quality scoring, so they are also excluded from the scored latency summary; including them makes p95 describe a case that no quality metric counts.

### Duplicate metrics

Every query is ranked against the shared candidate pool using canonical SHA-256 equality, normalized title equality, token overlap, and character trigram cosine similarity. The ranking function is given only candidate title and text; relevance labels, relation labels and split membership are attached after ranking. The candidate threshold is swept and selected on the calibration split alone. Embeddings are intentionally absent.

## Tests

```powershell
.venv\Scripts\python -m unittest discover -s tests -v
.venv\Scripts\python -m assistive_validation_benchmark generate --output-dir artifacts\repeat-a
.venv\Scripts\python -m assistive_validation_benchmark generate --output-dir artifacts\repeat-b
```

Unit tests cover manifest rejection, traversal protection, layout/typeface validation, corpus composition guarantees, CER/WER edge cases, normalization, the flood/fire critical negative, the narrow glyph-confusion rule and its material-substitution regression guard, score separation, extracted-candidate tracks, degenerate-calibration reporting, grammar span scoring per split, latency exclusion of unscored controls, lexical ranking label independence, deterministic asset bytes, scanned PDFs carrying no native text, report generation, local-only LanguageTool, and missing Tesseract behaviour. Heavy models are never a normal CI prerequisite.

## Adding a case or challenger

Add one bounded entry to `corpus/manifest.json`, keep all text synthetic, assign `calibration` or `holdout` before looking at results, and extend `manifest.py` only if a genuinely new case shape is needed. Rerun validation, deterministic generation, and unit tests.

New engines belong behind a local adapter in `engines.py`. An adapter must return explicit `ok`, `failed`, or `unavailable` status; record versions/model IDs/runtime/memory/settings; accept only bounded local files or loopback services; and remain outside the Admin/CMS package graph.

## Cleanup

Delete only the chosen `artifacts/<run>` directory, the local `.venv`, isolated `node_modules`, or user-level Paddle model cache after confirming the exact path. Do not clean the repository worktree. Benchmark reports are machine-specific and must be rerun after material tool/model changes.
