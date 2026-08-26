from __future__ import annotations

import multiprocessing
import os
import platform
import queue
import time
from pathlib import Path
from typing import Any

from ..engines import current_process_peak_memory
from ..ocr_productionization.offline import enable_offline_guard
from .provider import load_and_verify_model_manifest, make_pipeline, run_pipeline, runtime_versions
from .renderer import generate_assets, raster_path
from .schema import calibration_data_root


CAPTURE_SCHEMA = "pp1-ocr-iteration4-capture/v1"
PER_CASE_TIMEOUT_SECONDS = 180
WHOLE_RUN_TIMEOUT_SECONDS = 300


def _worker(model_dir: str, layout_dir: str, requests: Any, responses: Any) -> None:
    try:
        offline = enable_offline_guard()
        baseline = current_process_peak_memory()
        versions = runtime_versions()
        instance = make_pipeline(Path(model_dir), Path(layout_dir))
        responses.put({"kind": "ready", "offline": offline, "baseline": baseline, "versions": versions})
        while True:
            item = requests.get()
            if item is None:
                return
            try:
                observation = run_pipeline(instance, Path(item["path"]))
                responses.put({"kind": "result", "case_id": item["case_id"], "observation": observation})
            except Exception as error:
                responses.put(
                    {
                        "kind": "error",
                        "case_id": item["case_id"],
                        "error_type": type(error).__name__,
                        "message": str(error)[:300],
                    }
                )
    except Exception as error:
        responses.put({"kind": "fatal", "error_type": type(error).__name__, "message": str(error)[:300]})


def _receive(responses: Any, *, timeout: int, expected_case: str | None = None) -> dict[str, Any]:
    try:
        result = responses.get(timeout=timeout)
    except queue.Empty as error:
        raise TimeoutError(f"PaddleOCR-VL worker exceeded {timeout}s for {expected_case or 'initialization'}") from error
    if expected_case is not None and result.get("case_id") != expected_case:
        raise ValueError("PaddleOCR-VL worker returned an unexpected case identity")
    return result


def _failure(case_id: str, error_type: str, message: str) -> dict[str, str]:
    return {"case_id": case_id, "error_type": error_type[:80], "message": message[:300]}


def warmup_timeout_capture(
    corpus: dict[str, Any],
    protocol: dict[str, Any],
    *,
    run_dir: Path,
    model_dir: Path,
    layout_dir: Path,
    manifest_path: Path,
    observed_message: str,
) -> dict[str, Any]:
    """Serialize the observed failed attempt without starting inference again."""
    assets_dir = run_dir / "corpus"
    generation = generate_assets(corpus, assets_dir)
    provisioning = load_and_verify_model_manifest(manifest_path, model_dir, layout_dir)
    offline = enable_offline_guard()
    cases = [case for case in corpus["ocr_cases"] if case["split"] == "calibration"]
    message = "unscored warmup exceeded the frozen 180s timeout; scored calibration did not begin"
    return {
        "schema_version": CAPTURE_SCHEMA,
        "engine": "paddleocr-vl-1.6-native",
        "configuration_id": "v1.6-native-cpu-layoutv3-threads10",
        "configuration": protocol["configuration"],
        "versions": runtime_versions(),
        "offline": offline,
        "environment": {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "machine": platform.machine(),
            "processor": platform.processor(),
            "cpu_count": os.cpu_count(),
            "worker_start_method": "spawn",
            "per_case_timeout_seconds": PER_CASE_TIMEOUT_SECONDS,
            "whole_run_timeout_seconds": WHOLE_RUN_TIMEOUT_SECONDS,
        },
        "generation": generation,
        "provisioning": provisioning,
        "cold_start_ms": None,
        "warmup_runtime_ms": None,
        "memory_baseline_bytes": None,
        "peak_working_set_bytes": None,
        "artifact_footprint_bytes": provisioning["artifact_footprint_bytes"],
        "worker_concurrency": 1,
        "total_run_ms": None,
        "case_count": len(cases),
        "execution_failure": {
            "stage": "warmup",
            "case_id": "ocr4-cal-warmup-001",
            "timeout_seconds": PER_CASE_TIMEOUT_SECONDS,
            "process_exit_code": 1,
            "message": observed_message,
        },
        "failures": [_failure(case["id"], "CalibrationNotExecuted", message) for case in cases],
        "records": [],
    }


def capture_corpus(
    corpus: dict[str, Any],
    protocol: dict[str, Any],
    *,
    split: str,
    run_dir: Path,
    model_dir: Path,
    layout_dir: Path,
    manifest_path: Path,
    sealed_generation: dict[str, Any] | None = None,
) -> dict[str, Any]:
    run_started = time.perf_counter()
    assets_dir = run_dir / "corpus"
    generation = generate_assets(corpus, assets_dir)
    if sealed_generation is not None and generation != sealed_generation:
        raise ValueError("generated Iteration 4 assets differ from the sealed manifest")
    provisioning = load_and_verify_model_manifest(manifest_path, model_dir, layout_dir)
    context = multiprocessing.get_context("spawn")
    requests, responses = context.Queue(), context.Queue()
    worker = context.Process(target=_worker, args=(str(model_dir), str(layout_dir), requests, responses))
    worker.start()
    rendered_dir = run_dir / "rendered"
    records: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []
    peak_values: list[int] = []
    ready: dict[str, Any] = {}
    cold_start_ms: float | None = None
    warmup_runtime_ms: float | None = None
    cases = [case for case in corpus["ocr_cases"] if case["split"] == split]
    try:
        ready = _receive(responses, timeout=PER_CASE_TIMEOUT_SECONDS)
        if ready.get("kind") != "ready":
            raise RuntimeError(f"PaddleOCR-VL worker failed during initialization: {ready}")
        cold_start_ms = (time.perf_counter() - run_started) * 1000
        warmup = next(case for case in corpus["ocr_cases"] if case["split"] == "warmup")
        warmup_path = raster_path(
            warmup,
            assets_dir,
            rendered_dir,
            protocol["rendering"]["raster_dpi"],
            protocol["rendering"]["max_input_dimension"],
        )
        requests.put({"case_id": warmup["id"], "path": str(warmup_path)})
        try:
            warmup_response = _receive(responses, timeout=PER_CASE_TIMEOUT_SECONDS, expected_case=warmup["id"])
        except TimeoutError:
            failures.extend(
                _failure(
                    case["id"],
                    "CalibrationNotExecuted",
                    "unscored warmup exceeded the frozen 180s timeout; scored calibration did not begin",
                )
                for case in cases
            )
            worker.terminate()
            warmup_response = None
        if warmup_response is not None and warmup_response.get("kind") != "result":
            raise RuntimeError(f"PaddleOCR-VL warmup failed: {warmup_response}")
        if warmup_response is not None:
            warmup_result = warmup_response["observation"]
            warmup_runtime_ms = float(warmup_result["runtime_ms"])
            peak_values.append(int(warmup_result.get("peak_memory_bytes") or 0))
        for position, case in enumerate([] if warmup_response is None else cases):
            elapsed = time.perf_counter() - run_started
            if elapsed > WHOLE_RUN_TIMEOUT_SECONDS:
                failures.extend(
                    _failure(remaining["id"], "WholeRunTimeout", "whole assistive run exceeded 300 seconds")
                    for remaining in cases[position:]
                )
                worker.terminate()
                break
            path = raster_path(
                case,
                assets_dir,
                rendered_dir,
                protocol["rendering"]["raster_dpi"],
                protocol["rendering"]["max_input_dimension"],
            )
            requests.put({"case_id": case["id"], "path": str(path)})
            remaining_seconds = max(1, int(WHOLE_RUN_TIMEOUT_SECONDS - elapsed))
            try:
                response = _receive(
                    responses,
                    timeout=min(PER_CASE_TIMEOUT_SECONDS, remaining_seconds),
                    expected_case=case["id"],
                )
            except TimeoutError as error:
                timeout_kind = "WholeRunTimeout" if remaining_seconds < PER_CASE_TIMEOUT_SECONDS else "TimeoutError"
                failures.append(_failure(case["id"], timeout_kind, str(error)))
                failures.extend(
                    _failure(remaining["id"], "WorkerUnavailable", "worker terminated after timeout")
                    for remaining in cases[position + 1 :]
                )
                worker.terminate()
                break
            if response.get("kind") != "result":
                failures.append(
                    _failure(
                        case["id"],
                        response.get("error_type", "WorkerError"),
                        response.get("message", "PaddleOCR-VL worker failed"),
                    )
                )
                continue
            observation = response["observation"]
            peak_values.append(int(observation.get("peak_memory_bytes") or 0))
            records.append(
                {
                    "case_id": case["id"],
                    "runtime_ms": observation["runtime_ms"],
                    "peak_memory_bytes": observation.get("peak_memory_bytes"),
                    "blocks": observation["blocks"],
                }
            )
    finally:
        if worker.is_alive():
            requests.put(None)
            worker.join(timeout=10)
        if worker.is_alive():
            worker.terminate()
            worker.join(timeout=5)
    total_run_ms = (time.perf_counter() - run_started) * 1000
    return {
        "schema_version": CAPTURE_SCHEMA,
        "engine": "paddleocr-vl-1.6-native",
        "configuration_id": "v1.6-native-cpu-layoutv3-threads10",
        "configuration": protocol["configuration"],
        "versions": ready.get("versions") or runtime_versions(),
        "offline": ready.get("offline") or {"enabled": False, "self_test_passed": False},
        "environment": {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "machine": platform.machine(),
            "processor": platform.processor(),
            "cpu_count": os.cpu_count(),
            "worker_start_method": "spawn",
            "per_case_timeout_seconds": PER_CASE_TIMEOUT_SECONDS,
            "whole_run_timeout_seconds": WHOLE_RUN_TIMEOUT_SECONDS,
        },
        "generation": generation,
        "provisioning": provisioning,
        "cold_start_ms": cold_start_ms,
        "warmup_runtime_ms": warmup_runtime_ms,
        "memory_baseline_bytes": ready.get("baseline"),
        "peak_working_set_bytes": max(peak_values or [0]),
        "artifact_footprint_bytes": provisioning["artifact_footprint_bytes"],
        "worker_concurrency": 1,
        "total_run_ms": total_run_ms,
        "case_count": len(cases),
        "failures": failures,
        "records": records,
    }


def capture_calibration(
    corpus: dict[str, Any],
    protocol: dict[str, Any],
    *,
    run_dir: Path,
    model_dir: Path,
    layout_dir: Path,
) -> dict[str, Any]:
    return capture_corpus(
        corpus,
        protocol,
        split="calibration",
        run_dir=run_dir,
        model_dir=model_dir,
        layout_dir=layout_dir,
        manifest_path=calibration_data_root() / "model-manifest.json",
    )
