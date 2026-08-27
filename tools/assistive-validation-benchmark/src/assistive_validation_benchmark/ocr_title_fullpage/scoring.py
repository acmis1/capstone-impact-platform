"""Frozen scoring for one full-page candidate repeat. Every metric is recomputed from blocks."""

from __future__ import annotations

import statistics
from typing import Any

from ..ocr_iteration2_calibration.scoring import operational_checks, operational_measurements
from ..ocr_productionization.title_safety import binary_metrics, normalize_metric_title
from .schema import CAPTURE_SCHEMA
from .selectors import resolve


def _ratio(numerator: int, denominator: int) -> float:
    return numerator / denominator if denominator else 1.0


def _mean(values: list[float]) -> float | None:
    return statistics.fmean(values) if values else None


def _median(values: list[float]) -> float | None:
    return statistics.median(values) if values else None


STAGE_NAMES = (
    "rasterization_ms",
    "detection_ms",
    "recognition_ms",
    "other_ocr_ms",
    "candidate_selection_ms",
    "deterministic_comparison_ms",
)


def score_capture(capture: dict[str, Any], corpus: dict[str, Any], protocol: dict[str, Any]) -> dict[str, Any]:
    if capture.get("schema_version") != CAPTURE_SCHEMA:
        raise ValueError("unsupported title-fullpage capture")
    if capture["configuration"].get("page_scope") != "FULL_PAGE":
        raise ValueError("title-fullpage capture is not a full-page candidate")
    selector_id = capture["selector_id"]
    select, evaluate = resolve(selector_id)
    cases = {case["id"]: case for case in corpus["ocr_cases"] if case["split"] == "calibration"}
    observed = {record["case_id"]: record for record in capture["records"]}
    failed = {failure["case_id"] for failure in capture["failures"]}
    if set(observed) | failed != set(cases) or set(observed) & failed:
        raise ValueError("capture case identities differ from calibration corpus")
    records = []
    for case_id in sorted(observed):
        raw, case = observed[case_id], cases[case_id]
        if raw.get("selector_id") != selector_id or raw.get("page_scope") != "FULL_PAGE":
            raise ValueError("captured case identity differs from the frozen full-page selector")
        candidates = select(raw["blocks"])
        selected = candidates[0].text if candidates else ""
        outcome = evaluate(case["metadata_title"], candidates)
        expected_title = case["expected_visible_title"]
        title_exact = (
            None
            if expected_title is None
            else bool(selected) and normalize_metric_title(selected) == normalize_metric_title(expected_title)
        )
        records.append(
            {
                "case_id": case_id,
                "family": case["family"],
                "expected_consistency": case["expected_consistency"],
                "expected_visible_title": expected_title,
                "selected_title": selected,
                "title_exact": title_exact,
                "outcome": outcome["outcome"],
                "reason": outcome["reason"],
                "lexical_score": outcome["score"],
                "runtime_ms": raw["runtime_ms"],
                "stage_ms": raw["stage_ms"],
            }
        )
    exact_records = [record for record in records if record["title_exact"] is not None]
    exact_count = sum(record["title_exact"] is True for record in exact_records)
    exact_rate = _ratio(exact_count, len(exact_records))
    expected_inconsistency = [record["expected_consistency"] == "INCONSISTENT" for record in records]
    predicted_inconsistency = [record["outcome"] in {"REVIEW", "MISMATCH"} for record in records]
    detection = binary_metrics(expected_inconsistency, predicted_inconsistency)
    false_agreements = sum(
        record["expected_consistency"] == "INCONSISTENT" and record["outcome"] == "AGREES" for record in records
    )
    agreements = [record for record in records if record["outcome"] == "AGREES"]
    agreement_precision = _ratio(
        sum(record["expected_consistency"] == "CONSISTENT" for record in agreements), len(agreements)
    )
    review_count = sum(record["outcome"] == "REVIEW" for record in records)
    runtimes = [float(record["runtime_ms"]) for record in records]
    measurements = operational_measurements(
        cold_start_ms=capture.get("cold_start_ms"),
        runtimes_ms=runtimes,
        peak_working_set_bytes=capture.get("peak_working_set_bytes"),
        artifact_footprint_bytes=capture.get("artifact_footprint_bytes"),
    )
    operation_checks = operational_checks(measurements, protocol["operational_gates"])
    operation_checks["worker_concurrency"] = (
        capture["worker_concurrency"] <= protocol["operational_gates"]["worker_concurrency_maximum"]
    )
    quality = protocol["quality_gates"]
    final_checks = {
        "all_scored_cases_executed": not failed and len(records) == len(cases),
        "exact_title_recovery": exact_rate >= quality["exact_title_rate_minimum"],
        "inconsistency_precision": detection["precision"] >= quality["inconsistency_precision_minimum"],
        "inconsistency_recall": detection["recall"] >= quality["inconsistency_recall_minimum"],
        "automatic_agreement_precision": agreement_precision >= quality["automatic_agreement_precision_target"],
        "material_false_automatic_agreements": false_agreements <= quality["material_false_automatic_agreements_maximum"],
        "operational": all(operation_checks.values()),
        "provisioning": capture["provisioning"]["downloaded_during_capture"] is False,
        "offline_security": capture["offline"]["enabled"] is True and capture["offline"]["self_test_passed"] is True,
    }
    margin = protocol["calibration_margin"]
    margin_checks = {
        "exact_title_recovery": exact_rate >= margin["exact_title_rate_minimum"],
        "inconsistency_precision": detection["precision"] >= margin["inconsistency_precision_minimum"],
        "inconsistency_recall": detection["recall"] >= margin["inconsistency_recall_minimum"],
        "automatic_agreement_precision": agreement_precision >= margin["automatic_agreement_precision_target"],
        "material_false_automatic_agreements": false_agreements <= margin["material_false_automatic_agreements_maximum"],
        "cold_start": measurements["cold_start_ms"] is not None
        and measurements["cold_start_ms"] <= margin["cold_start_ms_maximum"],
        "p50": measurements["p50_ms"] is not None and measurements["p50_ms"] <= margin["p50_ms_maximum"],
        "p95": measurements["p95_ms"] is not None and measurements["p95_ms"] <= margin["p95_ms_maximum"],
    }
    stage_profile = {
        name: {
            "mean_ms": _mean([float(record["stage_ms"][name]) for record in records]),
            "p50_ms": _median([float(record["stage_ms"][name]) for record in records]),
        }
        for name in STAGE_NAMES
    }
    return {
        "schema_version": "pp1-ocr-title-fullpage-score/v1",
        "role": "calibration",
        "candidate_id": capture["candidate_id"],
        "repeat": capture["repeat"],
        "selector_id": selector_id,
        "configuration": capture["configuration"],
        "effective_paddle_configuration": capture["effective_paddle_configuration"],
        "versions": capture["versions"],
        "case_count": len(cases),
        "failure_count": len(failed),
        "visible_title_case_count": len(exact_records),
        "exact_title_count": exact_count,
        "exact_title_rate": exact_rate,
        "exact_title_failure_case_ids": sorted(
            record["case_id"] for record in exact_records if record["title_exact"] is not True
        ),
        "inconsistency_detection": detection,
        "automatic_agreement_precision": agreement_precision,
        "material_false_automatic_agreements": false_agreements,
        "review_count": review_count,
        "review_rate": _ratio(review_count, len(records)),
        "model_initialization_ms": capture["model_initialization_ms"],
        "stage_profile": stage_profile,
        "operational": {"measurements": measurements, "checks": operation_checks, "passed": all(operation_checks.values())},
        "provisioning": capture["provisioning"],
        "offline": capture["offline"],
        "final_gate_checks": final_checks,
        "final_gates_passed": all(final_checks.values()),
        "calibration_margin_checks": margin_checks,
        "calibration_margin_passed": all(final_checks.values()) and all(margin_checks.values()),
        "decision": (
            "REPEAT_SATISFIES_CALIBRATION_MARGIN"
            if all(final_checks.values()) and all(margin_checks.values())
            else "REPEAT_BELOW_CALIBRATION_MARGIN"
        ),
        "records": records,
    }
