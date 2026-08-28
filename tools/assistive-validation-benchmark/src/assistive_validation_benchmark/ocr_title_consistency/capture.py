from __future__ import annotations

import os
import platform
import time
from pathlib import Path
from typing import Any

from ..engines import current_process_peak_memory
from ..ocr_iteration3.capture import verify_small_candidate
from ..ocr_productionization.engine import _make_paddle, _run_paddle
from ..ocr_productionization.offline import enable_offline_guard
from .renderer import generate_assets, raster_path


CAPTURE_SCHEMA = "pp1-ocr-title-consistency-capture/v1"
MAX_CAPTURED_BLOCKS = 5000


def _compact_blocks(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if len(blocks) > MAX_CAPTURED_BLOCKS:
        raise ValueError("title OCR block count exceeds the frozen capture bound")
    compact = []
    for block in blocks:
        box = block.get("box")
        compact.append(
            {
                "page_number": int(block.get("page_number") or 1),
                "text": str(block.get("text") or "")[:400],
                "box": (
                    {key: round(float(box[key]), 1) for key in ("left", "top", "right", "bottom")}
                    if isinstance(box, dict)
                    else None
                ),
            }
        )
    return compact


def capture_calibration(
    corpus: dict[str, Any],
    protocol: dict[str, Any],
    *,
    run_dir: Path,
    models_dir: Path,
) -> dict[str, Any]:
    assets_dir = run_dir / "corpus"
    generation = generate_assets(corpus, assets_dir)
    provisioning = verify_small_candidate(protocol, models_dir)
    offline = enable_offline_guard()
    baseline_memory = current_process_peak_memory()
    started = time.perf_counter()
    instance, observed_versions = _make_paddle("paddle-small", models_dir)
    versions = {name: observed_versions[name] for name in ("paddleocr", "paddlepaddle", "paddlex")}
    configuration = protocol["configuration"]
    warmup = next(case for case in corpus["ocr_cases"] if case["split"] == "warmup")
    rendered_dir = run_dir / "rendered"
    warmup_path = raster_path(
        warmup,
        assets_dir,
        rendered_dir,
        configuration["raster_dpi"],
        configuration["max_input_dimension"],
    )
    warmup_result = _run_paddle(instance, warmup_path)
    cold_start_ms = (time.perf_counter() - started) * 1000
    records = []
    failures = []
    for case in [case for case in corpus["ocr_cases"] if case["split"] == "calibration"]:
        path = raster_path(
            case,
            assets_dir,
            rendered_dir,
            configuration["raster_dpi"],
            configuration["max_input_dimension"],
        )
        try:
            observation = _run_paddle(instance, path)
        except Exception as error:
            failures.append(
                {
                    "case_id": case["id"],
                    "error_type": type(error).__name__,
                    "message": str(error)[:300],
                }
            )
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
        "engine": "paddle-small",
        "configuration_id": "title-dpi180-edge1920-cpu",
        "configuration": configuration,
        "versions": versions,
        "offline": offline,
        "environment": {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "machine": platform.machine(),
            "processor": platform.processor(),
            "cpu_count": os.cpu_count(),
            "per_case_timeout_seconds": protocol["operational_gates"]["per_case_timeout_seconds"],
        },
        "worker_concurrency": 1,
        "generation": generation,
        "provisioning": provisioning,
        "cold_start_ms": cold_start_ms,
        "warmup_runtime_ms": warmup_result["runtime_ms"],
        "memory_baseline_bytes": baseline_memory,
        "peak_working_set_bytes": max(
            [warmup_result.get("peak_memory_bytes") or 0, current_process_peak_memory() or 0]
            + [record.get("peak_memory_bytes") or 0 for record in records]
        ),
        "artifact_footprint_bytes": provisioning["artifact_footprint_bytes"],
        "case_count": len([case for case in corpus["ocr_cases"] if case["split"] == "calibration"]),
        "failures": failures,
        "records": records,
    }
