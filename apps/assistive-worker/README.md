# Capstone assistive worker

Standalone Python 3.11 document extraction boundary for PP1 assistive validation. It accepts only bounded PDF, PNG, and JPEG bytes (or a safe relative path inside a trusted staging root), performs PDFium native extraction first, and returns versioned evidence. It has no authentication, database, workflow, publication, or UI authority.

## Local setup

```powershell
cd apps/assistive-worker
py -3.11 -m venv .venv
.venv\Scripts\python -m pip install -e .
.venv\Scripts\python -m unittest discover -s tests -v
.venv\Scripts\python tests\fixtures\generate.py --output-dir $env:TEMP\capstone-phase1-fixtures
```

Core operation requires only PDFium (`pypdfium2`) and Pillow. No OCR engine is required. To diagnose a staged document without OCR:

```powershell
.venv\Scripts\capstone-assistive-extract `
  --staging-root C:\trusted\staging `
  --relative-path poster.pdf
```

Tesseract remains an optional local executable adapter. The production title provider is an
explicitly selected PP-OCRv6 Small adapter; it is not installed with the core worker because
generic CI and native extraction do not need Paddle. Install its exact qualified runtime with:

```powershell
.venv\Scripts\python -m pip install -e ".[paddle-title]"
```

Model weights are provisioned separately and never downloaded by the worker. Set
`CAPSTONE_ASSISTIVE_PADDLE_MODELS_DIR` on the Node coordinator to a directory containing the
qualified `PP-OCRv6_small_det_infer` and `PP-OCRv6_small_rec_infer` trees. The coordinator then
selects `PADDLE_TITLE`; otherwise OCR remains disabled and scanned input degrades to partial.
See [`ocr-title-fullpage-production.md`](../../docs/assistive-validation/ocr-title-fullpage-production.md)
for the frozen configuration, hashes, safety boundary, and failure behavior.

Phase 4 adds a one-task process contract used by the trusted Node coordinator. The coordinator
passes a fixed staging root as an argument and one strict `assistive-worker-task/v1` object on
stdin; the worker emits exactly one bounded `assistive-worker-task-result/v1` JSON line on stdout.
The task accepts only `document.pdf`, `document.png`, or `document.jpg`. It has no Supabase
credential, database client, network queue, or project mutation capability. Check the process
boundary without running a task with:

```powershell
.venv\Scripts\capstone-assistive-task --health
```

See [`docs/assistive-validation/phase-1-document-extraction.md`](../../docs/assistive-validation/phase-1-document-extraction.md) for extraction and [`docs/assistive-validation/phase-4-async-job-coordination.md`](../../docs/assistive-validation/phase-4-async-job-coordination.md) for coordination, lifecycle, and operator commands.

## Container images

Two images are built from this directory. Both are pinned by immutable digest wherever they are
deployed; neither is ever referenced by a mutable tag.

| Dockerfile | Contents | Used by |
| --- | --- | --- |
| `Dockerfile.hosted` | Node, Python, Java 17, the qualified PP-OCRv6 Small model trees, and LanguageTool 6.6, each verified against a frozen SHA-256 during the build | Both execution profiles: the scale-to-zero heavy worker and the School-owned continuous worker |
| `Dockerfile.dispatcher` | A single bundled Node entry point and nothing else. No Paddle, no Java, no LanguageTool, no model artifacts | The scheduled dispatcher, which must start quickly inside a 15-second timeout |

The dispatcher deliberately shares no runtime with the worker: it reaches only the execution-control
database role and the cloud control plane, never project content, and it exposes no inbound
interface.

Building either image locally requires no registry. Publishing them is a separate, deliberate
decision — read [`docs/handover/third-party-licences.md`](../../docs/handover/third-party-licences.md)
first, because the image embeds third-party model and language artifacts.

## Execution profiles

The same worker image runs in two supported profiles: a zero-cost on-demand executor bounded by a
database-enforced launch ceiling, and a School-owned continuous worker with no ceiling and no cloud
dependency. Deployment, operation, and troubleshooting for both are in
[`docs/operations/zero-cost-assistive-executor.md`](../../docs/operations/zero-cost-assistive-executor.md).
