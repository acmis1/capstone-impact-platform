from __future__ import annotations

import statistics
from typing import Any

from ..ocr_iteration2_calibration.scoring import operational_checks, operational_measurements
from ..ocr_productionization.title_safety import binary_metrics, normalize_metric_title
from ..ocr_title_consistency.selector import evaluate_title_outcome, select_title_candidates
from .schema import CAPTURE_SCHEMA


def _ratio(numerator: int, denominator: int) -> float:
    return numerator / denominator if denominator else 1.0


def _mean(values: list[float]) -> float | None:
    return statistics.fmean(values) if values else None


def _median(values: list[float]) -> float | None:
    return statistics.median(values) if values else None


def score_capture(capture: dict[str, Any], corpus: dict[str, Any], protocol: dict[str, Any]) -> dict[str, Any]:
    if capture.get("schema_version") != CAPTURE_SCHEMA:
        raise ValueError("unsupported title-latency capture")
    cases = {case["id"]: case for case in corpus["ocr_cases"] if case["split"] == "calibration"}
    observed = {record["case_id"]: record for record in capture["records"]}
    failed = {failure["case_id"] for failure in capture["failures"]}
    if set(observed) | failed != set(cases) or set(observed) & failed:
        raise ValueError("capture case identities differ from calibration corpus")
    records = []
    false_fast_acceptances = 0
    for case_id in sorted(observed):
        raw, case = observed[case_id], cases[case_id]
        candidates = select_title_candidates(raw["blocks"])
        selected = candidates[0].text if candidates else ""
        outcome = evaluate_title_outcome(case["metadata_title"], candidates)
        expected_title = case["expected_visible_title"]
        title_exact = None if expected_title is None else bool(selected) and normalize_metric_title(selected) == normalize_metric_title(expected_title)
        if raw["path_used"] == "FAST_TITLE_REGION" and title_exact is not True:
            false_fast_acceptances += 1
        records.append({
            "case_id": case_id,
            "expected_consistency": case["expected_consistency"],
            "expected_visible_title": expected_title,
            "selected_title": selected,
            "title_exact": title_exact,
            "outcome": outcome["outcome"],
            "reason": outcome["reason"],
            "lexical_score": outcome["score"],
            "runtime_ms": raw["runtime_ms"],
            "path_used": raw["path_used"],
            "fallback_reason": raw["fallback_reason"],
            "stage_ms": raw["stage_ms"],
        })
    exact_records = [record for record in records if record["title_exact"] is not None]
    exact_count = sum(record["title_exact"] is True for record in exact_records)
    exact_rate = _ratio(exact_count, len(exact_records))
    expected_inconsistency = [record["expected_consistency"] == "INCONSISTENT" for record in records]
    predicted_inconsistency = [record["outcome"] in {"REVIEW", "MISMATCH"} for record in records]
    detection = binary_metrics(expected_inconsistency, predicted_inconsistency)
    false_agreements = sum(
        record["expected_consistency"] == "INCONSISTENT" and record["outcome"] == "AGREES"
        for record in records
    )
    agreements = [record for record in records if record["outcome"] == "AGREES"]
    agreement_precision = _ratio(sum(record["expected_consistency"] == "CONSISTENT" for record in agreements), len(agreements))
    review_count = sum(record["outcome"] == "REVIEW" for record in records)
    runtimes = [float(record["runtime_ms"]) for record in records]
    measurements = operational_measurements(
        cold_start_ms=capture.get("cold_start_ms"), runtimes_ms=runtimes,
        peak_working_set_bytes=capture.get("peak_working_set_bytes"),
        artifact_footprint_bytes=capture.get("artifact_footprint_bytes"),
    )
    operation_checks = operational_checks(measurements, protocol["operational_gates"])
    operation_checks["worker_concurrency"] = capture["worker_concurrency"] <= protocol["operational_gates"]["worker_concurrency_maximum"]
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
        "false_fast_path_acceptances": false_fast_acceptances <= margin["false_fast_path_acceptances_maximum"],
        "p50": measurements["p50_ms"] <= margin["p50_ms_maximum"],
        "p95": measurements["p95_ms"] <= margin["p95_ms_maximum"],
    }
    stage_names = (
        "rasterization_ms", "detection_ms", "recognition_ms", "other_ocr_ms",
        "candidate_selection_ms", "deterministic_comparison_ms",
    )
    stage_profile = {
        name: {
            "mean_ms": _mean([float(record["stage_ms"][name]) for record in records]),
            "p50_ms": _median([float(record["stage_ms"][name]) for record in records]),
        }
        for name in stage_names
    }
    fast = [record for record in records if record["path_used"] == "FAST_TITLE_REGION"]
    fallback = [record for record in records if record["path_used"] == "FULL_PAGE_FALLBACK"]
    return {
        "schema_version": "pp1-ocr-title-latency-score/v1",
        "role": "calibration",
        "candidate_id": capture["candidate_id"],
        "configuration": capture["configuration"],
        "effective_paddle_configuration": capture["effective_paddle_configuration"],
        "versions": capture["versions"],
        "case_count": len(cases),
        "failure_count": len(failed),
        "visible_title_case_count": len(exact_records),
        "exact_title_count": exact_count,
        "exact_title_rate": exact_rate,
        "inconsistency_detection": detection,
        "automatic_agreement_precision": agreement_precision,
        "material_false_automatic_agreements": false_agreements,
        "review_count": review_count,
        "review_rate": _ratio(review_count, len(records)),
        "false_fast_path_acceptances": false_fast_acceptances,
        "fast_path": {
            "hit_count": len(fast), "fallback_count": len(fallback),
            "hit_rate": _ratio(len(fast), len(records)),
            "average_fast_path_latency_ms": _mean([record["runtime_ms"] for record in fast]),
            "average_fallback_latency_ms": _mean([record["runtime_ms"] for record in fallback]),
            "aggregate_average_latency_ms": _mean(runtimes),
        },
        "model_initialization_ms": capture["model_initialization_ms"],
        "stage_profile": stage_profile,
        "operational": {"measurements": measurements, "checks": operation_checks, "passed": all(operation_checks.values())},
        "provisioning": capture["provisioning"],
        "offline": capture["offline"],
        "final_gate_checks": final_checks,
        "final_gates_passed": all(final_checks.values()),
        "calibration_margin_checks": margin_checks,
        "calibration_margin_passed": all(final_checks.values()) and all(margin_checks.values()),
        "decision": "ELIGIBLE_FOR_SELECTION" if all(final_checks.values()) and all(margin_checks.values()) else "CONTINUE_OPTIMIZATION",
        "records": records,
    }
