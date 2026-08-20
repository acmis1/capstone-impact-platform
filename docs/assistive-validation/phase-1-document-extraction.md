# Phase 1 production document extraction

## Purpose and boundary

Phase 1 implements a production-oriented, local document-to-evidence boundary for later PP1 assistive validation. It is deterministic-first, provider-independent, bounded, and human-authoritative.

The worker can only transform one bounded local document into a versioned extraction result. It cannot authenticate users, access Supabase or Duda, edit project metadata, create findings, change workflow state, approve, archive, publish, or remove content. The Admin/CMS remains authoritative for all of those responsibilities.

Implemented in this phase:

- PDF, PNG, and JPEG signature/type validation;
- PDFium native PDF text and geometry extraction;
- conservative native extraction-quality classification;
- bounded incremental PDF rasterization for an explicitly selected OCR provider;
- a provider-neutral local OCR contract;
- an optional explicitly selected Tesseract executable adapter;
- strict versioned result serialization, synthetic golden fixtures, and security-bound tests.

Deferred:

- PP-OCRv6 Medium adapter and reproducible production model provisioning;
- any OCR production default or automatic provider cascade;
- queue, job, database, HTTP worker, Admin UI, or workflow integration;
- title consistency, grammar, duplicate ranking, findings, or staff review behavior;
- hosted AI/OCR and all LLM/VLM use.

## Supported input and native-first flow

Only actual PDF (`%PDF-`), PNG, and JPEG signatures are accepted. Filename, extension, browser MIME, and a caller's claimed media type are not authoritative. A claimed type is optional; when supplied it must match the detected signature and decoded format.

```text
bounded bytes / trusted staged relative path
  -> signature and decoder validation
  -> PDF: bounded PDFium native extraction
       -> NATIVE_USABLE: return native evidence; never run OCR
       -> OCR_REQUIRED or AMBIGUOUS:
            -> no explicit provider: return OCR_REQUIRED
            -> explicit unavailable provider: return OCR_REQUIRED + UNAVAILABLE
            -> explicit available provider: rasterize and OCR one page at a time
  -> PNG/JPEG: validate dimensions and decoded pixels
       -> no explicit provider: return OCR_REQUIRED (not a failure)
       -> explicit provider: normalize to RGB PNG and run that provider
```

There is no provider registry, implicit OCR choice, confidence-based escalation, or Tesseract-to-Paddle fallback.

## Result contract

`assistive-document-extraction/v1` returns explicit enums for:

- overall status: `COMPLETED`, `OCR_REQUIRED`, or `FAILED`;
- source: `NATIVE_PDF`, `OCR`, or `NONE`;
- document type: `PDF`, `PNG`, or `JPEG`;
- native quality: `NATIVE_USABLE`, `OCR_REQUIRED`, `AMBIGUOUS`, `INVALID`, or `NOT_APPLICABLE`;
- OCR state: `NOT_REQUIRED`, `REQUIRED_NOT_RUN`, `COMPLETED`, `UNAVAILABLE`, or `FAILED`.

The result includes page count, bounded text, one-based page blocks, geometry where available, optional normalized confidence, quality evidence/reason codes, provider/runtime/model versions for OCR, bounded warnings, and one deterministic error code for a failed result. Strict deserialization rejects unknown or missing fields. It never carries arbitrary provider payloads, secrets, local paths, chain-of-thought, or business/workflow decisions.

Phase 2 can consume the text, page order, line/block geometry, native-quality evidence, and provider metadata for deterministic checks. Phase 1 does not interpret those fields as title agreement, prose quality, duplication, approval, or publication readiness.

## Quality gate

Measured by Phase 0:

- zero native characters in every measured scanned PDF means OCR is required;
- valid born-digital PDF text recovered measured titles exactly in the synthetic corpus;
- corrupt PDFs fail safely through PDFium.

Conservative operational safety heuristics (not accuracy results):

- fewer than 20 alphanumeric characters is `AMBIGUOUS`;
- printable ratio below 0.90 is `AMBIGUOUS`;
- replacement characters above 2% is `AMBIGUOUS`;
- non-empty text with no PDF text objects is `AMBIGUOUS`.

An ambiguous result is preserved as evidence but remains `OCR_REQUIRED` unless an explicitly selected provider completes. These thresholds are intentionally visible in `quality_gate.py`; they are routing safeguards, not benchmark-proven correctness claims.

## Trusted server-side limits

Documents are untrusted. `ExtractionLimits` is created by trusted worker configuration, never derived from document content or client-provided limit values.

| Limit | Default | Basis |
|---|---:|---|
| PDF input | 20 MiB | mirrors Admin/CMS media validation |
| Image input | 5 MiB | mirrors Admin/CMS media validation |
| PDF pages | 10 | conservative poster/supporting-page operational ceiling |
| Image dimensions | 10,000 x 10,000 | rejects extreme dimensions before decode |
| Decoded image pixels | 40,000,000 | supports large posters while bounding decompression |
| Raster DPI | 72-200; default 150 | prevents caller-selected unbounded rendering |
| Raster dimensions | 10,000 x 10,000 per page | preflighted before rendering |
| Raster pixels | 40,000,000/page; 80,000,000/document | limits page and aggregate render work |
| Extracted text | 100,000 characters | bounds returned and provider text |
| Text blocks / non-empty lines | 5,000 each | bounds structured output |
| Warnings | 50 | bounds provider and routing diagnostics |
| PDF text objects | 10,000 | bounds hostile/complex page object traversal |
| Provider stdout / stderr | 5 MiB / 8 KiB | bounds local process output |
| Provider execution | 90 seconds | deterministic timeout |

All resource-limit conditions return explicit errors rather than internal crashes. PDF dimensions are preflighted before rendering, pages are rendered and consumed incrementally, images are dimension/pixel-checked before full decode, and temporary Tesseract inputs live only in an automatically removed worker-created directory.

Path-based use requires a trusted staging root plus an untrusted relative path. Absolute paths, `..`, missing files, directories, and symlink escapes are rejected. Results never expose the resolved path.

## OCR provider contract and provisioning

An OCR provider reports stable provider identity/version metadata and availability, then accepts a normalized local PNG page and returns bounded text blocks, geometry, meaningful confidence when available, warnings, or an explicit failure. Core extraction works without any provider installed.

Phase 0 did not select a production OCR engine:

- Tesseract remains the measured performance leader only (85.2% exact title recovery, 16.0% mean WER, about 157 ms p50 and 52 MiB);
- PP-OCRv6 Medium remains the measured quality leader only (92.6% exact title recovery, 11.4% mean WER, about 8.1 s p50 and 2.1 GiB);
- neither met the complete OCR quality gate, and Phase 0 measured no trustworthy escalation signal.

The optional Tesseract adapter invokes a provisioned executable with an argument array (`shell=False`), fixed worker-created filename, configured timeout, and bounded stdout/stderr. Callers must instantiate/select it explicitly. `TESSERACT_CMD` may be set by trusted worker configuration. Missing or unusable executables report `UNAVAILABLE`; no download or install is attempted.

Paddle is deferred because its standard first run can download model weights and Phase 1 has no approved, versioned production distribution path. No model weight, cache, or runtime is tracked.

## Failure behavior

Error codes distinguish empty/unsupported/mismatched input, byte/page/dimension/pixel limits, malformed images, corrupt PDFs, text/block/object bounds, raster bounds/failure, staging traversal/read failures, unavailable/failed/invalid OCR output, and unexpected internal failure. Messages are bounded and sanitized; parser/provider raw errors and filesystem paths are not returned.

A valid image or scanned PDF with no selected OCR provider is not an error. It returns `OCR_REQUIRED` with `REQUIRED_NOT_RUN`. An explicitly selected but unavailable provider returns `OCR_REQUIRED` with `UNAVAILABLE`.

## Development and verification

```powershell
cd apps/assistive-worker
py -3.11 -m venv .venv
.venv\Scripts\python -m pip install -e .
.venv\Scripts\python -m unittest discover -s tests -v
.venv\Scripts\python tests\fixtures\generate.py --output-dir $env:TEMP\capstone-phase1-fixtures
```

Normal CI installs only `pypdfium2==5.13.0` and `Pillow==12.3.0`, runs the production unit/golden/security suite on Ubuntu, Windows, and macOS, generates the deterministic fixtures, and confirms no generated output changed tracked files. It requires no Tesseract installation, Paddle weights, GPU, database, or external AI service.

Fixture contract: the hand-built PDFs, malformed headers, and all generated fixture files are byte-golden. The tiny PNG/JPEG inputs under `tests/fixtures/canonical/` are checked-in canonical source bytes: generation copies them after verifying their SHA-256, rather than asking Pillow to render default-font text or re-encode images. The scanned PDF embeds that canonical JPEG, so it is byte-golden too. Tests additionally decode the canonical PNG/JPEG fixtures to assert their format and dimensions; the low-resolution fixture remains 64×64.

Dependency licenses:

- pypdfium2: Apache-2.0 or BSD-3-Clause; bundled PDFium and third-party notices apply;
- PDFium: BSD-style license and bundled dependency notices;
- Pillow: MIT-CMU;
- optional system Tesseract: Apache-2.0; Leptonica is BSD-2-Clause.

## Known Phase 1 limitations

- The quality heuristics are deliberately conservative and need representative operational evidence before tuning.
- PDFium geometry is returned as PDF points normalized to a top-left origin; complex reading order remains provider/parser evidence, not a semantic guarantee.
- Tesseract is an optional adapter, not an approved default, and its language data is provisioned outside this package.
- PP-OCRv6 Medium awaits an approved model provisioning, integrity, and redistribution design.
- No throughput/concurrency, queueing, persistence, staff review, or real participant-data behavior is claimed.
