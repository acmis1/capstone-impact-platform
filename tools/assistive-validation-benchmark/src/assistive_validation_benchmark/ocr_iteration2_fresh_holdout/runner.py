"""Guarded one-shot PP-OCRv6 Small runner for the later Iteration 2B3B task."""

from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path
from typing import Any, Callable, TypeVar

from ..ocr_failure_analysis.ordering import apply_order
from ..ocr_failure_analysis.selectors import run_variant
from ..ocr_iteration2_calibration.report import _merged_operational_evidence
from ..ocr_iteration2_calibration.scoring import operational_checks, operational_measurements, _word_counts
from ..ocr_iteration2_holdout_protocol.fingerprint import require_canonical_renderer
from ..ocr_iteration2_holdout_protocol.manifest import verify_candidate_artifacts
from ..ocr_iteration2_holdout_protocol.renderer import generate_holdout_assets, reference_text
from ..ocr_iteration2_holdout_protocol.schema import (
    canonical_json_bytes,
    data_root as protocol_data_root,
    load_json,
    tool_root,
    validate_protocol,
    value_sha256,
)
from ..ocr_productionization.title_safety import (
    binary_metrics,
    evaluate_title_safety,
    normalize_metric_title,
)
from .corpus import corpus_path
from .seal import (
    _generation_manifest,
    generation_manifest_path,
    pre_run_seal_path,
    validate_seal,
)


RUN_STATE_SCHEMA = "pp1-ocr-iteration2-one-shot-state/v1"
CAPTURE_FILENAME = "holdout-capture.json"
REPORT_FILENAME = "holdout-report.json"
T = TypeVar("T")


def state_path(run_dir: Path) -> Path:
    return run_dir / "one-shot-state.json"


def _write_state(path: Path, state: dict[str, Any]) -> None:
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_bytes(canonical_json_bytes(state))
    os.replace(temporary, path)


def atomic_claim_run_state(path: Path, binding: dict[str, Any]) -> dict[str, Any]:
    """Claim the sole legitimate run with an O_EXCL create before crossing the OCR boundary."""
    path.parent.mkdir(parents=True, exist_ok=True)
    state = {
        "schema_version": RUN_STATE_SCHEMA,
        "status": "running",
        "pre_run_seal_sha256": binding["pre_run_seal_sha256"],
        "corpus_sha256": binding["corpus_sha256"],
        "candidate_engine": "paddle-small",
        "ocr_run_count": 1,
        "ocr_executed": True,
        "holdout_capture_exists": False,
        "holdout_result_exists": False,
        "rerun_permitted": False,
    }
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    try:
        descriptor = os.open(path, flags, 0o600)
    except FileExistsError as error:
        raise ValueError("one-shot run state already exists; a second first run is refused") from error
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(canonical_json_bytes(state))
        stream.flush()
        os.fsync(stream.fileno())
    return state


def execute_once(
    path: Path,
    binding: dict[str, Any],
    *,
    preflight: Callable[[], T],
    operation: Callable[[T], dict[str, Any]],
) -> dict[str, Any]:
    """Run preflight before claiming; every post-claim failure consumes the one shot."""
    prepared = preflight()
    state = atomic_claim_run_state(path, binding)
    try:
        result = operation(prepared)
    except Exception:
        state["status"] = "failed"
        state["rerun_permitted"] = False
        _write_state(path, state)
        raise
    state["status"] = "completed"
    state["holdout_capture_exists"] = True
    state["holdout_result_exists"] = True
    state["result_sha256"] = value_sha256(result)
    _write_state(path, state)
    return result


def _classification(expected: list[bool], predicted: list[bool]) -> dict[str, Any]:
    return binary_metrics(expected, predicted)


def _aggregate_wer(records: list[dict[str, Any]], order: str) -> dict[str, Any]:
    edits = sum(record["reading_orders"][order]["word_edits"] for record in records)
    words = sum(record["reading_orders"][order]["reference_words"] for record in records)
    return {"word_edits": edits, "reference_words": words, "wer": edits / words if words else None}


def _breakdown(records: list[dict[str, Any]], cases: dict[str, dict[str, Any]], key: str) -> dict[str, Any]:
    result = {}
    for value in sorted({case[key] for case in cases.values()}):
        selected = [record for record in records if cases[record["case_id"]][key] == value]
        result[value] = {
            "case_count": len(selected),
            "exact_title_count": sum(record["title_exact"] for record in selected),
            "primary_wer": _aggregate_wer(selected, "column")["wer"],
        }
    return result


def score_holdout_capture(
    capture: dict[str, Any],
    *,
    corpus: dict[str, Any],
    protocol: dict[str, Any],
) -> dict[str, Any]:
    """Score the one capture through frozen selector, safety, ordering, WER and ceiling APIs."""
    if capture.get("schema_version") != "pp1-ocr-iteration2-capture/v1":
        raise ValueError("unsupported Iteration 2 holdout capture")
    if capture.get("engine") != "paddle-small" or capture.get("configuration_id") != "dpi180-edge1920":
        raise ValueError("holdout capture candidate or raster identity changed")
    cases = {
        case["id"]: case
        for case in corpus["ocr_cases"]
        if case["split"] == "holdout"
    }
    observed = {record["case_id"]: record for record in capture["records"]}
    failures = {failure["case_id"] for failure in capture["failures"]}
    if set(observed) | failures != set(cases) or set(observed) & failures:
        raise ValueError("holdout capture case identities differ from the sealed corpus")
    selector = protocol["title_contract"]
    reading_orders = [protocol["wer_contract"]["primary_order"], *protocol["wer_contract"]["required_diagnostic_orders"]]
    records = []
    for case_id in sorted(observed):
        raw = observed[case_id]
        case = cases[case_id]
        candidates = run_variant(selector["selector"], selector["order"], raw["blocks"])
        title = candidates[0].text if candidates else ""
        safety = evaluate_title_safety(case["metadata_title"], candidates)
        orders = {}
        for order in reading_orders:
            hypothesis = "\n".join(block["text"] for block in apply_order(raw["blocks"], order))
            edits, words = _word_counts(reference_text(case), hypothesis)
            orders[order] = {"word_edits": edits, "reference_words": words}
        records.append(
            {
                "case_id": case_id,
                "expected_agreement": case["expected_agreement"],
                "title_exact": bool(title) and normalize_metric_title(title) == normalize_metric_title(case["title"]),
                "safety_outcome": safety["outcome"],
                "runtime_ms": raw["runtime_ms"],
                "reading_orders": orders,
            }
        )
    expected = [record["expected_agreement"] for record in records]
    automatic = [record["safety_outcome"] == "AGREES" for record in records]
    assistive = [record["safety_outcome"] in {"AGREES", "REVIEW"} for record in records]
    exact_count = sum(record["title_exact"] for record in records)
    material_false = sum(not label and prediction for label, prediction in zip(expected, automatic))
    orders = {order: _aggregate_wer(records, order) for order in reading_orders}
    measurements = operational_measurements(
        cold_start_ms=capture.get("cold_start_ms"),
        runtimes_ms=[float(record["runtime_ms"]) for record in records],
        peak_working_set_bytes=capture.get("peak_working_set_bytes"),
        artifact_footprint_bytes=capture.get("artifact_footprint_bytes"),
    )
    ceilings = protocol["operational_gate"]["ceilings"]
    current_checks = operational_checks(measurements, ceilings)
    historical = _merged_operational_evidence(ceilings)["paddle-small"]
    quality = protocol["quality_gate"]
    quality_checks = {
        "all_scored_cases_executed": not failures and len(records) == quality["scored_case_count"],
        "exact_title": exact_count >= quality["minimum_exact_titles"],
        "primary_wer": orders["column"]["wer"] is not None
        and orders["column"]["wer"] <= quality["primary_mean_wer_maximum"],
        "material_false_automatic_agreements": material_false <= quality["material_false_agreements_maximum"],
    }
    operational = {
        "historical_prior": historical,
        "current_configuration_measurements": measurements,
        "current_configuration_checks": current_checks,
        "passed": historical["plausibly_inside_established_limits"] and all(current_checks.values()),
    }
    passed = all(quality_checks.values()) and operational["passed"]
    return {
        "schema_version": "pp1-ocr-iteration2-one-shot-result/v1",
        "protocol_version": protocol["protocol_version"],
        "corpus_version": corpus["corpus_version"],
        "corpus_sha256": value_sha256(corpus),
        "candidate": "PP-OCRv6 Small",
        "configuration": {"raster_dpi": 180, "max_input_dimension": 1920, "device": "cpu"},
        "selector": selector["selector_id"],
        "primary_reading_order": "column",
        "diagnostic_reading_orders": ["raw", "geometry"],
        "title_exact_count": exact_count,
        "title_exact_rate": exact_count / 40,
        "assistive_title_result": {record["case_id"]: record["safety_outcome"] for record in records},
        "equality_precision_recall": _classification(expected, automatic),
        "assistive_precision_recall": _classification(expected, assistive),
        "material_false_automatic_agreements": material_false,
        "word_error_rate": orders,
        "clean_wer": _breakdown(records, cases, "difficulty")["clean"]["primary_wer"],
        "challenging_wer": _breakdown(records, cases, "difficulty")["challenging"]["primary_wer"],
        "media_breakdown": _breakdown(records, cases, "media"),
        "layout_breakdown": _breakdown(records, cases, "layout"),
        "quality_checks": quality_checks,
        "operational": operational,
        "records": records,
        "decision": "READY_FOR_OCR_PROVIDER_INTEGRATION" if passed else "OCR_PROVIDER_DEFERRED",
        "scientific_integrity": {
            "holdout_runs": 1,
            "post_result_tuning_permitted": False,
            "corpus_regeneration_permitted": False,
            "production_selection_implemented_by_this_run": False,
        },
    }


def _prepare_assets(prepared_dir: Path, models_dir: Path) -> dict[str, Any]:
    sealed = validate_seal()
    protocol = validate_protocol(load_json(protocol_data_root() / "protocol.json"))
    corpus = load_json(corpus_path())
    candidate = verify_candidate_artifacts(protocol, models_dir)
    renderer = require_canonical_renderer()
    generated = generate_holdout_assets(corpus, prepared_dir)
    observed_manifest = _generation_manifest(corpus, protocol, generated)
    stored_manifest = load_json(generation_manifest_path())
    if observed_manifest != stored_manifest:
        raise ValueError("regenerated assets differ from the sealed generation manifest")
    return {
        "sealed": sealed,
        "protocol": protocol,
        "corpus": corpus,
        "candidate": candidate,
        "renderer": renderer,
        "prepared_dir": prepared_dir,
    }


def _capture(prepared: dict[str, Any], run_dir: Path, models_dir: Path) -> dict[str, Any]:
    from ..ocr_iteration2_calibration.capture import capture_engine

    assets_dir = run_dir / "corpus"
    if assets_dir.exists():
        raise ValueError("one-shot asset directory already exists")
    shutil.copytree(prepared["prepared_dir"], assets_dir)
    corpus = prepared["corpus"]
    cases = [case for case in corpus["ocr_cases"] if case["split"] == "holdout"]
    warmup = next(case for case in corpus["ocr_cases"] if case["split"] == "warmup")
    capture = capture_engine(
        "paddle-small",
        configuration_id="dpi180-edge1920",
        cases=cases,
        warmup_case=warmup,
        assets_dir=assets_dir,
        rendered_dir=run_dir / "rendered" / "dpi180-edge1920",
        models_dir=models_dir,
        raster_dpi=180,
        max_input_dimension=1920,
        tesseract_executable=None,
    )
    (run_dir / CAPTURE_FILENAME).write_bytes(canonical_json_bytes(capture))
    report = score_holdout_capture(capture, corpus=corpus, protocol=prepared["protocol"])
    (run_dir / REPORT_FILENAME).write_bytes(canonical_json_bytes(report))
    return report


def run_one_shot(run_dir: Path, models_dir: Path) -> dict[str, Any]:
    """Perform the later 2B3B run. This function must not be called during holdout sealing."""
    if (run_dir / CAPTURE_FILENAME).exists() or (run_dir / REPORT_FILENAME).exists():
        raise ValueError("holdout capture or report already exists; rerun is refused")
    seal = load_json(pre_run_seal_path())
    binding = {
        "pre_run_seal_sha256": value_sha256(seal),
        "corpus_sha256": seal["corpus_sha256"],
    }
    with tempfile.TemporaryDirectory(prefix="ocr2h-one-shot-preflight-") as temporary:
        prepared_dir = Path(temporary) / "corpus"
        return execute_once(
            state_path(run_dir),
            binding,
            preflight=lambda: _prepare_assets(prepared_dir, models_dir),
            operation=lambda prepared: _capture(prepared, run_dir, models_dir),
        )
