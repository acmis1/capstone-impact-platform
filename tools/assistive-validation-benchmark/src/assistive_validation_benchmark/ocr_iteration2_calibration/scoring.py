from __future__ import annotations

import math
from typing import Any

from ..core import levenshtein_distance, normalize_metric_text
from ..ocr_failure_analysis.ordering import apply_order
from ..ocr_failure_analysis.selectors import run_variant
from ..ocr_productionization.title_safety import evaluate_title_safety, normalize_metric_title
from .corpus import reference_text


def _word_counts(reference: str, hypothesis: str) -> tuple[int, int]:
    reference_words = normalize_metric_text(reference).split()
    hypothesis_words = normalize_metric_text(hypothesis).split()
    return levenshtein_distance(reference_words, hypothesis_words), len(reference_words)


def _safe_rate(numerator: int, denominator: int) -> float | None:
    return numerator / denominator if denominator else None


def _classification_counts(labels: list[bool], predictions: list[bool]) -> dict[str, Any]:
    true_positive = sum(label and prediction for label, prediction in zip(labels, predictions))
    false_positive = sum(not label and prediction for label, prediction in zip(labels, predictions))
    true_negative = sum(not label and not prediction for label, prediction in zip(labels, predictions))
    false_negative = sum(label and not prediction for label, prediction in zip(labels, predictions))
    return {
        "true_positive": true_positive,
        "false_positive": false_positive,
        "true_negative": true_negative,
        "false_negative": false_negative,
        "precision": _safe_rate(true_positive, true_positive + false_positive),
        "recall": _safe_rate(true_positive, true_positive + false_negative),
    }


def _percentile(values: list[float], quantile: float) -> float:
    ordered = sorted(values)
    return ordered[max(0, math.ceil(quantile * len(ordered)) - 1)]


def score_capture(
    capture: dict[str, Any],
    *,
    cases: list[dict[str, Any]],
    selector_contracts: list[dict[str, str]],
    reading_orders: list[str],
) -> dict[str, Any]:
    if capture.get("schema_version") != "pp1-ocr-iteration2-capture/v1":
        raise ValueError("unsupported Iteration 2 capture")
    by_case = {case["id"]: case for case in cases}
    observed = {record["case_id"]: record for record in capture["records"]}
    if set(observed) | {failure["case_id"] for failure in capture["failures"]} != set(by_case):
        raise ValueError("capture case identities do not match the calibration corpus")
    records: list[dict[str, Any]] = []
    for case_id in sorted(observed):
        raw = observed[case_id]
        case = by_case[case_id]
        selector_results: dict[str, Any] = {}
        for contract in selector_contracts:
            candidates = run_variant(contract["selector"], contract["order"], raw["blocks"])
            candidate = candidates[0].text if candidates else ""
            safety = evaluate_title_safety(case["metadata_title"], candidates)
            selector_results[contract["id"]] = {
                "title_exact": bool(candidate) and normalize_metric_title(candidate) == normalize_metric_title(case["title"]),
                "safety_outcome": safety["outcome"],
            }
        order_results: dict[str, Any] = {}
        reference = reference_text(case)
        for order in reading_orders:
            hypothesis = "\n".join(block["text"] for block in apply_order(raw["blocks"], order))
            edits, words = _word_counts(reference, hypothesis)
            order_results[order] = {"word_edits": edits, "reference_words": words}
        records.append(
            {
                "case_id": case_id,
                "expected_agreement": case["expected_agreement"],
                "runtime_ms": raw["runtime_ms"],
                "selectors": selector_results,
                "reading_orders": order_results,
            }
        )
    return {
        "engine": capture["engine"],
        "configuration_id": capture["configuration_id"],
        "configuration": capture["configuration"],
        "versions": capture["versions"],
        "environment": capture["environment"],
        "offline": capture["offline"],
        "cold_start_ms": capture["cold_start_ms"],
        "peak_working_set_bytes": capture["peak_working_set_bytes"],
        "artifact_footprint_bytes": capture["artifact_footprint_bytes"],
        "case_count": capture["case_count"],
        "failures": capture["failures"],
        "records": records,
    }


def summarize_records(scored: dict[str, Any]) -> dict[str, Any]:
    records = scored["records"]
    selector_ids = list(records[0]["selectors"]) if records else []
    order_ids = list(records[0]["reading_orders"]) if records else []
    selectors: dict[str, Any] = {}
    labels = [record["expected_agreement"] for record in records]
    for selector_id in selector_ids:
        values = [record["selectors"][selector_id] for record in records]
        equality = [value["safety_outcome"] == "AGREES" for value in values]
        assistive = [value["safety_outcome"] in {"AGREES", "REVIEW"} for value in values]
        exact_count = sum(value["title_exact"] for value in values)
        selectors[selector_id] = {
            "exact_title_count": exact_count,
            "exact_title_rate": _safe_rate(exact_count, len(values)),
            "equality_path": _classification_counts(labels, equality),
            "assistive_path": _classification_counts(labels, assistive),
            "material_false_automatic_agreements": sum(
                not label and prediction for label, prediction in zip(labels, equality)
            ),
        }
    orders: dict[str, Any] = {}
    for order_id in order_ids:
        edits = sum(record["reading_orders"][order_id]["word_edits"] for record in records)
        words = sum(record["reading_orders"][order_id]["reference_words"] for record in records)
        orders[order_id] = {
            "word_edits": edits,
            "reference_words": words,
            "wer": _safe_rate(edits, words),
        }
    runtimes = [float(record["runtime_ms"]) for record in records]
    return {
        "engine": scored["engine"],
        "configuration_id": scored["configuration_id"],
        "case_count": scored["case_count"],
        "failure_count": len(scored["failures"]),
        "selectors": selectors,
        "reading_orders": orders,
        "runtime": {
            "count": len(runtimes),
            "p50_ms": _percentile(runtimes, 0.5) if runtimes else None,
            "p95_ms": _percentile(runtimes, 0.95) if runtimes else None,
        },
    }


def select_configuration(
    scored: dict[str, Any],
    *,
    selector_priority: list[str],
    order_priority: list[str],
    development_gate: dict[str, Any],
    operational_plausible: bool,
) -> dict[str, Any]:
    aggregate = summarize_records(scored)
    selectors = aggregate["selectors"]
    safe_selectors = [
        selector_id
        for selector_id in selector_priority
        if selectors[selector_id]["material_false_automatic_agreements"] == 0
    ]
    if not safe_selectors:
        selected_selector = selector_priority[0]
    else:
        selected_selector = max(
            safe_selectors,
            key=lambda selector_id: (
                selectors[selector_id]["exact_title_rate"],
                selectors[selector_id]["equality_path"]["recall"] or 0,
                -selector_priority.index(selector_id),
            ),
        )
    selected_order = min(
        order_priority,
        key=lambda order_id: (aggregate["reading_orders"][order_id]["wer"], order_priority.index(order_id)),
    )
    title = selectors[selected_selector]
    order = aggregate["reading_orders"][selected_order]
    checks = {
        "exact_title": title["exact_title_rate"] >= development_gate["exact_title_rate_minimum"],
        "primary_wer": order["wer"] <= development_gate["primary_mean_wer_maximum"],
        "title_safety": title["material_false_automatic_agreements"] == 0,
        "executed_all_cases": len(scored["failures"]) == 0 and len(scored["records"]) == scored["case_count"],
        "operational_plausibility": operational_plausible,
    }
    return {
        **aggregate,
        "selected_selector": selected_selector,
        "selected_reading_order": selected_order,
        "selected_exact_title_rate": title["exact_title_rate"],
        "selected_primary_wer": order["wer"],
        "selected_material_false_automatic_agreements": title["material_false_automatic_agreements"],
        "development_gate_checks": checks,
        "holdout_worthy": all(checks.values()),
    }
