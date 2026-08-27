"""Corrected candidate eligibility, repeat aggregation and prospective preference order.

The defect this module exists to correct: the previous iteration's ``_selection_eligible``
required a candidate to *contain an optimization feature* (an explicit thread count plus
MKL-DNN or a cropped fast region) before it could be selected, which silently excluded the
simplest candidate even though that candidate had satisfied every prospective requirement.
Eligibility here depends only on whether a candidate satisfies the frozen requirements, and
preference is lowest architectural complexity first.
"""

from __future__ import annotations

from typing import Any


COMPLEXITY_RANKS = {
    "full_page_single_pass": 0,
    "cropped_region_fast_path": 1,
    "multi_pass_ocr": 2,
    "backend_specific_acceleration": 3,
    "high_performance_inference_or_document_vlm": 4,
}


def architecture(configuration: dict[str, Any]) -> str:
    """Name the architecture a configuration implements, independent of how fast it is."""
    if configuration.get("enable_hpi"):
        return "high_performance_inference_or_document_vlm"
    if configuration.get("enable_mkldnn"):
        return "backend_specific_acceleration"
    if configuration.get("fast_region_ratio") is not None:
        return "cropped_region_fast_path"
    if configuration.get("page_scope") != "FULL_PAGE":
        return "multi_pass_ocr"
    return "full_page_single_pass"


def complexity_rank(configuration: dict[str, Any]) -> int:
    return COMPLEXITY_RANKS[architecture(configuration)]


def _effective_cpu_threads(scores: list[dict[str, Any]]) -> int:
    values = {int(score["effective_paddle_configuration"]["cpu_threads"]) for score in scores}
    if len(values) != 1:
        raise ValueError("effective CPU thread count differs between repeats of one candidate")
    return values.pop()


def aggregate_candidate(candidate_id: str, reports: list[dict[str, Any]], protocol: dict[str, Any]) -> dict[str, Any]:
    """Reduce every repeat of one candidate to the values the selection rule may consult."""
    required = protocol["repeatability"]["required_independent_repeats"]
    scores = sorted((report["score"] for report in reports), key=lambda score: score["repeat"])
    if [score["repeat"] for score in scores] != list(range(1, len(scores) + 1)):
        raise ValueError(f"candidate repeats are not a contiguous one-based sequence: {candidate_id}")
    configurations = {tuple(sorted(score["configuration"].items())) for score in scores}
    if len(configurations) != 1:
        raise ValueError(f"candidate repeats do not share one configuration: {candidate_id}")
    selectors = {score["selector_id"] for score in scores}
    if len(selectors) != 1:
        raise ValueError(f"candidate repeats do not share one selector: {candidate_id}")
    configuration = scores[0]["configuration"]
    repeats = [
        {
            "repeat": score["repeat"],
            "exact_title_rate": score["exact_title_rate"],
            "exact_title_count": score["exact_title_count"],
            "visible_title_case_count": score["visible_title_case_count"],
            "exact_title_failure_case_ids": score["exact_title_failure_case_ids"],
            "inconsistency_precision": score["inconsistency_detection"]["precision"],
            "inconsistency_recall": score["inconsistency_detection"]["recall"],
            "automatic_agreement_precision": score["automatic_agreement_precision"],
            "material_false_automatic_agreements": score["material_false_automatic_agreements"],
            "review_rate": score["review_rate"],
            "failure_count": score["failure_count"],
            "p50_ms": score["operational"]["measurements"]["p50_ms"],
            "p95_ms": score["operational"]["measurements"]["p95_ms"],
            "cold_start_ms": score["operational"]["measurements"]["cold_start_ms"],
            "maximum_case_runtime_ms": score["operational"]["measurements"]["maximum_case_runtime_ms"],
            "peak_working_set_bytes": score["operational"]["measurements"]["peak_working_set_bytes"],
            "artifact_footprint_bytes": score["operational"]["measurements"]["artifact_footprint_bytes"],
            "final_gates_passed": score["final_gates_passed"],
            "calibration_margin_passed": score["calibration_margin_passed"],
        }
        for score in scores
    ]
    repeat_count = len(repeats)
    stability = {
        "required_independent_repeats": required,
        "observed_repeats": repeat_count,
        "repeat_count_satisfied": repeat_count >= required,
        "every_repeat_passed_final_gates": all(item["final_gates_passed"] for item in repeats),
        "every_repeat_passed_calibration_margin": all(item["calibration_margin_passed"] for item in repeats),
    }
    return {
        "candidate_id": candidate_id,
        "selector_id": scores[0]["selector_id"],
        "configuration": configuration,
        "architecture": architecture(configuration),
        "complexity_rank": complexity_rank(configuration),
        "effective_cpu_threads": _effective_cpu_threads(scores),
        "repeat_count": repeat_count,
        "repeats": repeats,
        "worst_repeat_p50_ms": max(item["p50_ms"] for item in repeats),
        "worst_repeat_p95_ms": max(item["p95_ms"] for item in repeats),
        "worst_repeat_cold_start_ms": max(item["cold_start_ms"] for item in repeats),
        "worst_repeat_peak_working_set_bytes": max(item["peak_working_set_bytes"] for item in repeats),
        "worst_repeat_exact_title_rate": min(item["exact_title_rate"] for item in repeats),
        "worst_repeat_inconsistency_precision": min(item["inconsistency_precision"] for item in repeats),
        "worst_repeat_inconsistency_recall": min(item["inconsistency_recall"] for item in repeats),
        "worst_repeat_automatic_agreement_precision": min(item["automatic_agreement_precision"] for item in repeats),
        "maximum_material_false_automatic_agreements": max(
            item["material_false_automatic_agreements"] for item in repeats
        ),
        "stability": stability,
        "selection_eligible": all(stability.values()),
        "ineligibility_reasons": sorted(key for key, value in stability.items() if value is False),
    }


def preferred_candidate(candidates: list[dict[str, Any]]) -> dict[str, Any]:
    """Lowest architectural complexity first; then measured worst-repeat stability."""
    eligible = [item for item in candidates if item["selection_eligible"]]
    if not eligible:
        raise ValueError("no full-page candidate satisfies the repeated calibration margin")
    minimum_rank = min(item["complexity_rank"] for item in eligible)
    simplest = [item for item in eligible if item["complexity_rank"] == minimum_rank]
    return min(
        simplest,
        key=lambda item: (
            item["worst_repeat_p95_ms"],
            item["worst_repeat_p50_ms"],
            item["effective_cpu_threads"],
            item["candidate_id"],
        ),
    )
