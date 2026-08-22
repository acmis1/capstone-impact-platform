"""Capture bounded raw OCR observations so diagnostics never need to rerun OCR.

The merged v1 run stored per-case metrics but not OCR blocks, so failure decomposition is
impossible from the merged report alone. This module runs the same engines through the same
adapters at a chosen raster configuration and stores the block geometry and text. Every
later diagnostic is then a pure, free, deterministic function of a capture file.

Engine adapters are imported from the merged benchmark rather than reimplemented, so a
capture is OCR-identical to the merged measurement at the same configuration.
"""

from __future__ import annotations

import os
import platform
import subprocess
import time
from pathlib import Path
from typing import Any, Callable

from ..engines import current_process_peak_memory
from ..ocr_productionization.corpus import raster_path
from ..ocr_productionization.engine import (
    PADDLE_MODELS,
    _make_paddle,
    _run_paddle,
    _run_tesseract,
    _tesseract_executable,
)
from ..ocr_productionization.offline import enable_offline_guard
from ..ocr_productionization.schema import load_json, data_root


CAPTURE_SCHEMA = "pp1-ocr-diagnostic-capture/v1"
MAX_CAPTURED_BLOCKS = 5000


def configuration_id(raster_dpi: int, max_input_dimension: int) -> str:
    return f"dpi{raster_dpi}-edge{max_input_dimension}"


def exposed_development_cases() -> list[dict[str, Any]]:
    """The 48 scored cases of the merged v1 corpus, now an exposed development corpus."""
    calibration = load_json(data_root() / "corpus" / "calibration.json")
    holdout = load_json(data_root() / "corpus" / "holdout.json")
    cases = [case for case in calibration["ocr_cases"] if case["split"] == "calibration"]
    cases.extend(case for case in holdout["ocr_cases"] if case["split"] == "holdout")
    return sorted(cases, key=lambda case: case["id"])


def warmup_case() -> dict[str, Any]:
    calibration = load_json(data_root() / "corpus" / "calibration.json")
    return next(case for case in calibration["ocr_cases"] if case["split"] == "warmup")


def _compact_blocks(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep only what diagnostics need: text and integer-rounded geometry."""
    compact = []
    for block in blocks[:MAX_CAPTURED_BLOCKS]:
        box = block.get("box")
        compact.append(
            {
                "page_number": int(block.get("page_number") or 1),
                "text": str(block.get("text") or ""),
                "box": (
                    {key: round(float(box[key]), 1) for key in ("left", "top", "right", "bottom")}
                    if isinstance(box, dict)
                    else None
                ),
            }
        )
    return compact


def capture_engine(
    engine: str,
    *,
    cases: list[dict[str, Any]],
    assets_dir: Path,
    rendered_dir: Path,
    models_dir: Path,
    raster_dpi: int,
    max_input_dimension: int,
    tesseract_psm: int = 3,
    tesseract_executable: str | None = None,
    offline: bool = True,
) -> dict[str, Any]:
    if engine not in {"tesseract", *PADDLE_MODELS}:
        raise ValueError("unknown OCR engine")
    offline_result = enable_offline_guard() if offline else {"enabled": False, "self_test_passed": False}
    baseline_memory = current_process_peak_memory()
    started = time.perf_counter()
    if engine == "tesseract":
        executable = _tesseract_executable(tesseract_executable)
        version = subprocess.run(
            [executable, "--version"],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=10,
            shell=False,
            check=True,
        ).stdout.splitlines()[0]
        runner: Callable[[Path], dict[str, Any]] = lambda path: _run_tesseract(path, executable, tesseract_psm)
        versions = {"tesseract": version}
    else:
        instance, versions = _make_paddle(engine, models_dir)
        runner = lambda path: _run_paddle(instance, path)
    warmup = warmup_case()
    runner(raster_path(warmup, assets_dir, rendered_dir, raster_dpi, max_input_dimension))
    cold_start_ms = (time.perf_counter() - started) * 1000

    records: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    for case in cases:
        path = raster_path(case, assets_dir, rendered_dir, raster_dpi, max_input_dimension)
        try:
            observation = runner(path)
        except Exception as error:  # bounded: a failed case is evidence, not a crash
            failures.append({"case_id": case["id"], "error_type": type(error).__name__, "message": str(error)[:300]})
            continue
        records.append(
            {
                "case_id": case["id"],
                "split": case["split"],
                "media": case["media"],
                "layout": case["layout"],
                "difficulty": case["difficulty"],
                "tags": list(case["tags"]),
                "runtime_ms": observation["runtime_ms"],
                "peak_memory_bytes": observation.get("peak_memory_bytes"),
                "blocks": _compact_blocks(observation["blocks"]),
            }
        )
    return {
        "schema_version": CAPTURE_SCHEMA,
        "engine": engine,
        "configuration_id": configuration_id(raster_dpi, max_input_dimension),
        "configuration": {
            "raster_dpi": raster_dpi,
            "max_input_dimension": max_input_dimension,
            "device": "cpu",
            "enable_mkldnn": False if engine in PADDLE_MODELS else None,
            "tesseract_psm": tesseract_psm if engine == "tesseract" else None,
        },
        "versions": versions,
        "offline": offline_result,
        "environment": {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "cpu_count": os.cpu_count(),
        },
        "cold_start_ms": cold_start_ms,
        "memory_baseline_bytes": baseline_memory,
        "peak_working_set_bytes": max(
            [current_process_peak_memory() or 0] + [record.get("peak_memory_bytes") or 0 for record in records]
        ),
        "case_count": len(cases),
        "failures": failures,
        "records": records,
    }
