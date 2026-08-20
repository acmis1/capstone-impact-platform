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

Tesseract is an optional local executable adapter and is used only when the caller explicitly passes `--ocr-provider tesseract`. It is not the production default. Paddle/PP-OCR is not implemented in Phase 1 because production model provisioning and redistribution have not been decided.

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
