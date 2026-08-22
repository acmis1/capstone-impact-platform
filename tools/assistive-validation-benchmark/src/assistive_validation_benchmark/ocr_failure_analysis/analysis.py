"""Aggregate captured OCR observations into diagnostic evidence.

Everything in this module is a deterministic function of a capture file plus the exposed
development corpus. No OCR runs here, so the whole analysis can be re-derived and re-checked
for free, including in CI against the committed report.
"""

from __future__ import annotations

from typing import Any

from ..core import timing_summary
from ..ocr_productionization.title_safety import (
    binary_metrics,
    evaluate_title_safety,
    normalize_metric_title,
)
from .capture import exposed_development_cases
from .selectors import SELECTOR_VARIANTS, run_variant, title_oracle
from .taxonomy import category_counts, classify, wer_decomposition


# Development go/no-go gate. This is deliberately weaker than the final production gate
# (95% exact title / 12% WER); it only decides whether a fresh holdout is worth spending.
DEVELOPMENT_GATE = {
    "exact_title_rate_minimum": 0.90,
    "mean_wer_maximum": 0.15,
    "material_false_agreements_maximum": 0,
    "all_cases_executed": True,
}

# Operational plausibility for the 16 GiB functional-minimum direction. These mirror the
# merged operational ceilings; a development candidate that cannot plausibly meet them is
# not worth a holdout even if its quality is good.
OPERATIONAL_CEILINGS = {
    "cold_start_ms_maximum": 30000,
    "p50_ms_maximum": 10000,
    "p95_ms_maximum": 20000,
    "peak_working_set_bytes_maximum": 4294967296,
}

LAYOUT_KEYS = ("one_column", "two_column", "three_column")
MEDIA_KEYS = ("png", "jpeg", "scanned_pdf")
DIFFICULTY_KEYS = ("clean", "challenging")
# Condition slices are predicates over real corpus fields, not free-text tag guesses, so a
# renamed tag cannot silently empty a slice.
CONDITIONS: dict[str, Any] = {
    "low_resolution": lambda case: "low_resolution" in case["tags"],
    "compression": lambda case: "compression" in case["tags"],
    "noise": lambda case: case["noise"] == "mild",
    "wrapped_title": lambda case: case["title_style"] == "wrapped",
    "letter_spaced_title": lambda case: case["title_style"] == "letterspaced",
    "decorative_title": lambda case: case["title_style"] == "decorative",
    "small_body_text": lambda case: "small_body_text" in case["tags"],
    "low_contrast": lambda case: case["contrast"] == "low",
}


def _mean(values: list[float]) -> float | None:
    return sum(values) / len(values) if values else None


def _rate(count: int, total: int) -> float | None:
    return count / total if total else None


def _case_index() -> dict[str, dict[str, Any]]:
    return {case["id"]: case for case in exposed_development_cases()}


def _breakdown(records: list[dict[str, Any]], cases: dict[str, dict[str, Any]]) -> dict[str, Any]:
    def slice_metrics(subset: list[dict[str, Any]]) -> dict[str, Any]:
        return {
            "case_count": len(subset),
            "exact_title_count": sum(record["title_exact"] for record in subset),
            "exact_title_rate": _rate(sum(record["title_exact"] for record in subset), len(subset)),
            "mean_raw_wer": _mean([record["wer"]["raw_wer"] for record in subset]),
            "mean_best_wer": _mean([record["wer"]["best_wer"] for record in subset]),
        }

    return {
        "difficulty": {
            key: slice_metrics([record for record in records if record["difficulty"] == key])
            for key in DIFFICULTY_KEYS
        },
        "layout": {
            key: slice_metrics([record for record in records if record["layout"] == key]) for key in LAYOUT_KEYS
        },
        "media": {
            key: slice_metrics([record for record in records if record["media"] == key]) for key in MEDIA_KEYS
        },
        "condition": {
            name: slice_metrics([record for record in records if predicate(cases[record["case_id"]])])
            for name, predicate in CONDITIONS.items()
        },
    }


def _selector_study(
    capture: dict[str, Any], cases: dict[str, dict[str, Any]]
) -> dict[str, dict[str, Any]]:
    """Score every metadata-blind selector/ordering pair, including its safety behaviour."""
    study: dict[str, dict[str, Any]] = {}
    for selector, order in SELECTOR_VARIANTS:
        exact = 0
        expected: list[bool] = []
        agrees: list[bool] = []
        assistive: list[bool] = []
        false_agreements = 0
        for record in capture["records"]:
            case = cases[record["case_id"]]
            candidates = run_variant(selector, order, record["blocks"])
            top = candidates[0].text if candidates else ""
            if top and normalize_metric_title(top) == normalize_metric_title(case["title"]):
                exact += 1
            safety = evaluate_title_safety(case["metadata_title"], candidates)
            expected.append(bool(case["expected_agreement"]))
            agrees.append(safety["outcome"] == "AGREES")
            assistive.append(safety["outcome"] in {"AGREES", "REVIEW"})
            if not case["expected_agreement"] and safety["outcome"] == "AGREES":
                false_agreements += 1
        total = len(capture["records"])
        study[f"{selector}@{order}"] = {
            "selector": selector,
            "reading_order": order,
            "case_count": total,
            "exact_title_count": exact,
            "exact_title_rate": _rate(exact, total),
            "equality_path": binary_metrics(expected, agrees),
            "assistive_review_path": binary_metrics(expected, assistive),
            "material_false_agreements": false_agreements,
        }
    return study


def analyse_capture(capture: dict[str, Any]) -> dict[str, Any]:
    """Full diagnostic summary for one engine at one raster configuration."""
    cases = _case_index()
    unknown = [record["case_id"] for record in capture["records"] if record["case_id"] not in cases]
    if unknown:
        raise ValueError(f"capture references cases outside the exposed development corpus: {unknown[:3]}")
    records = [classify(cases[record["case_id"]], record["blocks"]) for record in capture["records"]]
    for record, source in zip(records, capture["records"]):
        record["runtime_ms"] = source["runtime_ms"]
    total = capture["case_count"]
    scored = len(records)
    exact = sum(record["title_exact"] for record in records)
    oracle_keys = ("top1", "top3", "top5", "top8", "in_individual_blocks", "recoverable")
    latency = timing_summary([float(record["runtime_ms"]) for record in records])
    safety_expected = [bool(cases[record["case_id"]]["expected_agreement"]) for record in records]
    production_safety = [
        evaluate_title_safety(
            cases[record["case_id"]]["metadata_title"],
            run_variant("production_geometry_prominence", "raw", source["blocks"]),
        )
        for record, source in zip(records, capture["records"])
    ]
    material_false_agreements = sum(
        not expected and safety["outcome"] == "AGREES"
        for expected, safety in zip(safety_expected, production_safety)
    )
    return {
        "engine": capture["engine"],
        "configuration_id": capture["configuration_id"],
        "configuration": capture["configuration"],
        "case_count": total,
        "scored_case_count": scored,
        "failures": capture["failures"],
        "exact_title_count": exact,
        "exact_title_rate": _rate(exact, scored),
        "mean_raw_wer": _mean([record["wer"]["raw_wer"] for record in records]),
        "mean_geometry_wer": _mean([record["wer"]["geometry_wer"] for record in records]),
        "mean_column_wer": _mean([record["wer"]["column_wer"] for record in records]),
        "mean_best_wer": _mean([record["wer"]["best_wer"] for record in records]),
        "mean_raw_cer": _mean([record["wer"]["raw_cer"] for record in records]),
        "reading_order_material_cases": sum(record["wer"]["reading_order_material"] for record in records),
        "title_oracle": {
            key: {
                "count": sum(record["oracle"][key] for record in records),
                "rate": _rate(sum(record["oracle"][key] for record in records), scored),
            }
            for key in oracle_keys
        },
        "adjacent_group_recoverable": {
            order: {
                "count": sum(record["oracle"][f"in_adjacent_groups_{order}"] for record in records),
                "rate": _rate(sum(record["oracle"][f"in_adjacent_groups_{order}"] for record in records), scored),
            }
            for order in ("raw", "geometry", "column")
        },
        "failure_taxonomy": category_counts(records),
        "baseline_failure_taxonomy": category_counts(records, key="baseline_category"),
        "breakdown": _breakdown(records, cases),
        "selector_study": _selector_study(capture, cases),
        "production_title_safety": {
            "equality_path": binary_metrics(
                safety_expected, [safety["outcome"] == "AGREES" for safety in production_safety]
            ),
            "assistive_review_path": binary_metrics(
                safety_expected, [safety["outcome"] in {"AGREES", "REVIEW"} for safety in production_safety]
            ),
            "material_false_agreements": material_false_agreements,
        },
        "cold_start_ms": capture["cold_start_ms"],
        "latency": latency,
        "peak_working_set_bytes": capture["peak_working_set_bytes"],
        "versions": capture["versions"],
        "offline": capture["offline"],
        "records": records,
    }


def development_gate(summary: dict[str, Any], selector_key: str) -> dict[str, Any]:
    """Evaluate the development (holdout-worthiness) gate for one engine/config/selector."""
    variant = summary["selector_study"][selector_key]
    wer = summary["mean_best_wer"]
    latency = summary["latency"]
    checks = {
        "exact_title": (variant["exact_title_rate"] or 0.0) >= DEVELOPMENT_GATE["exact_title_rate_minimum"],
        "mean_wer": wer is not None and wer <= DEVELOPMENT_GATE["mean_wer_maximum"],
        "material_false_agreements": variant["material_false_agreements"]
        <= DEVELOPMENT_GATE["material_false_agreements_maximum"],
        "all_cases_executed": not summary["failures"] and summary["scored_case_count"] == summary["case_count"],
        "cold_start": summary["cold_start_ms"] <= OPERATIONAL_CEILINGS["cold_start_ms_maximum"],
        "p50": latency["p50_ms"] is not None and latency["p50_ms"] <= OPERATIONAL_CEILINGS["p50_ms_maximum"],
        "p95": latency["p95_ms"] is not None and latency["p95_ms"] <= OPERATIONAL_CEILINGS["p95_ms_maximum"],
        "peak_memory": summary["peak_working_set_bytes"]
        <= OPERATIONAL_CEILINGS["peak_working_set_bytes_maximum"],
    }
    return {
        "engine": summary["engine"],
        "configuration_id": summary["configuration_id"],
        "selector": selector_key,
        "exact_title_rate": variant["exact_title_rate"],
        "exact_title_count": variant["exact_title_count"],
        "mean_wer": wer,
        "material_false_agreements": variant["material_false_agreements"],
        "cold_start_ms": summary["cold_start_ms"],
        "p50_ms": latency["p50_ms"],
        "p95_ms": latency["p95_ms"],
        "peak_working_set_bytes": summary["peak_working_set_bytes"],
        "checks": checks,
        "holdout_worthy": all(checks.values()),
    }
