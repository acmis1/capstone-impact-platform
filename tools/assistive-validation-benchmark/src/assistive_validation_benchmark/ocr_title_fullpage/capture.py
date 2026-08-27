"""One independent calibration repeat: fresh process, fresh model, complete corpus."""

from __future__ import annotations

import os
import platform
import time
from pathlib import Path
from typing import Any

from ..engines import current_process_peak_memory
from ..ocr_iteration3.capture import verify_small_candidate
from ..ocr_productionization.offline import enable_offline_guard
from .pipeline import PaddleStageProfiler, make_paddle, run_case
from .renderer import generate_assets
from .schema import CAPTURE_SCHEMA


def candidate_configuration(
    protocol: dict[str, Any],
    *,
    candidate_id: str,
    cpu_threads: int | None,
) -> dict[str, Any]:
    options = protocol["bounded_options"]
    if cpu_threads not in options["cpu_threads"]:
        raise ValueError("CPU thread count is outside the bounded candidate set")
    if not candidate_id or len(candidate_id) > 80:
        raise ValueError("candidate ID is invalid")
    fixed = protocol["fixed_configuration"]
    return {
        "candidate_id": candidate_id,
        "page_scope": "FULL_PAGE",
        "fast_region_ratio": None,
        "device": "cpu",
        "raster_dpi": fixed["raster_dpi"],
        "max_input_dimension": fixed["max_input_dimension"],
        "enable_mkldnn": False,
        "mkldnn_cache_capacity": fixed["mkldnn_cache_capacity"],
        "cpu_threads": cpu_threads,
        "enable_hpi": False,
        "worker_concurrency": 1,
    }


def capture_repeat(
    corpus: dict[str, Any],
    protocol: dict[str, Any],
    configuration: dict[str, Any],
    *,
    repeat: int,
    selector_id: str,
    run_dir: Path,
    models_dir: Path,
) -> dict[str, Any]:
    if repeat < 1:
        raise ValueError("calibration repeat index must be one-based")
    assets_dir = run_dir / "corpus"
    generation = generate_assets(corpus, assets_dir)
    provisioning = verify_small_candidate(protocol, models_dir)
    offline = enable_offline_guard()
    baseline_memory = current_process_peak_memory()
    lifecycle_started = time.perf_counter()
    model_started = time.perf_counter()
    instance, versions, effective_configuration = make_paddle(models_dir, configuration)
    model_initialization_ms = (time.perf_counter() - model_started) * 1000
    profiler = PaddleStageProfiler(instance)
    rendered_dir = run_dir / "rendered"
    warmup = next(case for case in corpus["ocr_cases"] if case["split"] == "warmup")
    warmup_result = run_case(
        instance,
        profiler,
        warmup,
        configuration,
        assets_dir=assets_dir,
        rendered_dir=rendered_dir,
        selector_id=selector_id,
    )
    cold_start_ms = (time.perf_counter() - lifecycle_started) * 1000
    records: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []
    for case in [case for case in corpus["ocr_cases"] if case["split"] == "calibration"]:
        try:
            records.append(
                run_case(
                    instance,
                    profiler,
                    case,
                    configuration,
                    assets_dir=assets_dir,
                    rendered_dir=rendered_dir,
                    selector_id=selector_id,
                )
            )
        except Exception as error:
            failures.append({"case_id": case["id"], "error_type": type(error).__name__, "message": str(error)[:300]})
    peak_memory = max(
        [baseline_memory or 0, warmup_result.get("peak_memory_bytes") or 0, current_process_peak_memory() or 0]
        + [record.get("peak_memory_bytes") or 0 for record in records]
    )
    return {
        "schema_version": CAPTURE_SCHEMA,
        "candidate_id": configuration["candidate_id"],
        "repeat": repeat,
        "selector_id": selector_id,
        "configuration": configuration,
        "effective_paddle_configuration": effective_configuration,
        "versions": versions,
        "offline": offline,
        "environment": {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "machine": platform.machine(),
            "processor": platform.processor(),
            "logical_cpu_count": os.cpu_count(),
        },
        "worker_concurrency": 1,
        "generation": generation,
        "provisioning": provisioning,
        "model_initialization_ms": model_initialization_ms,
        "cold_start_ms": cold_start_ms,
        "warmup_runtime_ms": warmup_result["runtime_ms"],
        "memory_baseline_bytes": baseline_memory,
        "peak_working_set_bytes": peak_memory,
        "artifact_footprint_bytes": provisioning["artifact_footprint_bytes"],
        "case_count": len([case for case in corpus["ocr_cases"] if case["split"] == "calibration"]),
        "failures": failures,
        "records": records,
    }
