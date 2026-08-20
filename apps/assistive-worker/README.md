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

See [`docs/assistive-validation/phase-1-document-extraction.md`](../../docs/assistive-validation/phase-1-document-extraction.md) for the contract, limits, decisions, and known limitations.
