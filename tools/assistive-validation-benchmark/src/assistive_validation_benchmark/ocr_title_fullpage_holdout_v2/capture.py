"""Single sealed capture for the post-freeze full-page title holdout."""

from __future__ import annotations

import os
import platform
import time
from pathlib import Path
from typing import Any

from ..engines import current_process_peak_memory
from ..ocr_title_fullpage.host_load import HostLoadSampler
from ..ocr_title_fullpage.pipeline import PaddleStageProfiler, make_paddle, run_case
from ..ocr_title_fullpage.schema import CAPTURE_SCHEMA, file_sha256


def verify_assets(generation: dict[str, Any], assets_dir: Path) -> None:
    for asset in generation["assets"]:
        path = assets_dir / asset["asset"]
        if not path.is_file() or path.stat().st_size != asset["bytes"] or file_sha256(path) != asset["sha256"]:
            raise ValueError(f"sealed title-fullpage v2 asset differs: {asset['asset']}")


def capture_holdout(
    corpus: dict[str, Any],
    protocol: dict[str, Any],
    generation: dict[str, Any],
    configuration: dict[str, Any],
    selector_id: str,
    preflight: dict[str, Any],
    *,
    assets_dir: Path,
    run_dir: Path,
    models_dir: Path,
) -> dict[str, Any]:
    verify_assets(generation, assets_dir)
    host_control = protocol["repeatability"]["host_load_control"]
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
    sampler = HostLoadSampler(host_control["sampling_interval_seconds"])
    sampler.prime()
    sampler.start()
    records: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []
    for case in [case for case in corpus["ocr_cases"] if case["split"] == "holdout"]:
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
            failures.append(
                {"case_id": case["id"], "error_type": type(error).__name__, "message": str(error)[:300]}
            )
    host_load = {
        **sampler.stop(),
        "precondition": preflight["host_precondition"],
        "control": host_control,
    }
    host_load["quiescent"] = (
        host_load["mean_external_cpu_percent"] is not None
        and host_load["mean_external_cpu_percent"] <= host_control["maximum_external_cpu_percent"]
    )
    peak_memory = max(
        [baseline_memory or 0, warmup_result.get("peak_memory_bytes") or 0, current_process_peak_memory() or 0]
        + [record.get("peak_memory_bytes") or 0 for record in records]
    )
    return {
        "schema_version": CAPTURE_SCHEMA,
        "candidate_id": configuration["candidate_id"],
        "repeat": 1,
        "selector_id": selector_id,
        "configuration": configuration,
        "effective_paddle_configuration": effective_configuration,
        "versions": versions,
        "offline": preflight["offline"],
        "preflight": preflight,
        "environment": {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "machine": platform.machine(),
            "processor": platform.processor(),
            "logical_cpu_count": os.cpu_count(),
        },
        "worker_concurrency": 1,
        "host_load": host_load,
        "generation": generation,
        "provisioning": preflight["provisioning"],
        "model_initialization_ms": model_initialization_ms,
        "cold_start_ms": cold_start_ms,
        "warmup_runtime_ms": warmup_result["runtime_ms"],
        "memory_baseline_bytes": baseline_memory,
        "peak_working_set_bytes": peak_memory,
        "artifact_footprint_bytes": preflight["provisioning"]["artifact_footprint_bytes"],
        "case_count": 60,
        "failures": failures,
        "records": records,
    }
