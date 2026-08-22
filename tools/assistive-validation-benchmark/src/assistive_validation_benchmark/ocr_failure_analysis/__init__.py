"""PP1 assistive OCR failure decomposition and calibration diagnostics (Iteration 2A).

This package is diagnostic-only. It reads the merged v1 benchmark corpus as an exposed
development corpus, never re-freezes a holdout, and never changes production behaviour.
It deliberately lives outside ``ocr_productionization`` so the merged protocol-freeze tree
stays byte-identical.
"""
