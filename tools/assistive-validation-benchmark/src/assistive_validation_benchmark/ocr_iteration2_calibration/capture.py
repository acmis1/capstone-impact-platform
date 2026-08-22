from __future__ import annotations

import os
import platform
import subprocess
import time
from pathlib import Path
from typing import Any, Callable

from ..engines import current_process_peak_memory
from ..ocr_productionization.engine import (
    PADDLE_MODELS,
    _make_paddle,
    _run_paddle,
    _run_tesseract,
    _tesseract_executable,
)
from ..ocr_productionization.offline import enable_offline_guard
from ..ocr_productionization.provision import directory_bytes
from .corpus import raster_path


CAPTURE_SCHEMA = "pp1-ocr-iteration2-capture/v1"
MAX_CAPTURED_BLOCKS = 5000


def _compact_blocks(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
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
    configuration_id: str,
    cases: list[dict[str, Any]],
    warmup_case: dict[str, Any],
    assets_dir: Path,
    rendered_dir: Path,
    models_dir: Path,
    raster_dpi: int,
    max_input_dimension: int,
    tesseract_executable: str | None,
) -> dict[str, Any]:
    if engine not in {"tesseract", *PADDLE_MODELS}:
        raise ValueError("unknown OCR engine")
    offline = enable_offline_guard()
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
        if not version.startswith("tesseract v5.5.3"):
            raise ValueError(f"Tesseract version differs from the frozen candidate: {version}")
        runner: Callable[[Path], dict[str, Any]] = lambda path: _run_tesseract(path, executable, 3)
        versions = {"tesseract": version}
        footprint = sum(
            path.stat().st_size
            for path in (Path(executable), Path(executable).parent / "tessdata" / "eng.traineddata")
            if path.is_file()
        )
    else:
        instance, versions = _make_paddle(engine, models_dir)
        runner = lambda path: _run_paddle(instance, path)
        detection, recognition = PADDLE_MODELS[engine]
        footprint = sum(
            directory_bytes(models_dir / f"{model}_infer")
            for model in (detection, recognition)
        )
    warmup_path = raster_path(warmup_case, assets_dir, rendered_dir, raster_dpi, max_input_dimension)
    warmup = runner(warmup_path)
    cold_start_ms = (time.perf_counter() - started) * 1000

    records: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    for case in cases:
        path = raster_path(case, assets_dir, rendered_dir, raster_dpi, max_input_dimension)
        try:
            observation = runner(path)
        except Exception as error:
            failures.append({"case_id": case["id"], "error_type": type(error).__name__, "message": str(error)[:300]})
            continue
        records.append(
            {
                "case_id": case["id"],
                "runtime_ms": observation["runtime_ms"],
                "peak_memory_bytes": observation.get("peak_memory_bytes"),
                "blocks": _compact_blocks(observation["blocks"]),
            }
        )
    return {
        "schema_version": CAPTURE_SCHEMA,
        "engine": engine,
        "configuration_id": configuration_id,
        "configuration": {
            "raster_dpi": raster_dpi,
            "max_input_dimension": max_input_dimension,
            "device": "cpu",
            "enable_mkldnn": False if engine in PADDLE_MODELS else None,
            "tesseract_psm": 3 if engine == "tesseract" else None,
        },
        "versions": versions,
        "offline": offline,
        "environment": {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "machine": platform.machine(),
            "processor": platform.processor(),
            "cpu_count": os.cpu_count(),
        },
        "cold_start_ms": cold_start_ms,
        "warmup_runtime_ms": warmup["runtime_ms"],
        "memory_baseline_bytes": baseline_memory,
        "peak_working_set_bytes": max(
            [warmup.get("peak_memory_bytes") or 0, current_process_peak_memory() or 0]
            + [record.get("peak_memory_bytes") or 0 for record in records]
        ),
        "artifact_footprint_bytes": footprint,
        "case_count": len(cases),
        "failures": failures,
        "records": records,
    }
