"""Exposed development evidence for the Iteration 2 upper-page challenge.

The challenge is derived only from the already-exposed Iteration 2 calibration corpus.
Its ``ocr2-dev-*`` namespace and synthetic labels are deliberately separate from the future
``ocr2h-*`` holdout namespace. Ground truth is used to score development results, never by
the runtime selectors.
"""

from __future__ import annotations

import copy
import hashlib
from pathlib import Path
from typing import Any

from ..ocr_failure_analysis.selectors import run_variant
from ..ocr_failure_analysis.taxonomy import edit_counts, order_text
from ..ocr_iteration2_calibration.schema import validate_corpus as validate_calibration_corpus
from ..ocr_productionization.title_safety import evaluate_title_safety, normalize_metric_title
from .renderer import _write_case_asset, reference_text
from .schema import canonical_json_bytes, file_sha256, load_json, tool_root, value_sha256


DEVELOPMENT_EVIDENCE_SCHEMA = "pp1-ocr-iteration2-distractor-calibration/v1"
DEVELOPMENT_CAPTURE_ENGINE = "paddle-small"
DEVELOPMENT_CONFIGURATION_ID = "dpi180-edge1920"
SELECTOR_CONTRACTS: tuple[dict[str, str], ...] = (
    {"id": "first_bounded_group@geometry", "selector": "first_bounded_group", "order": "geometry"},
    {"id": "top_band_prominence@geometry", "selector": "top_band_prominence", "order": "geometry"},
    {
        "id": "centred_top_band_prominence@geometry",
        "selector": "centred_top_band_prominence",
        "order": "geometry",
    },
)
READING_ORDERS = ("raw", "geometry", "column")
SELECTOR_GATE = {
    "exact_title_rate_minimum": 0.90,
    "material_false_automatic_agreements_maximum": 0,
}

DISTRACTOR_LIBRARY: tuple[dict[str, str], ...] = (
    {"kind": "school_or_faculty_masthead", "text": "SCHOOL OF SCIENCE AND ENGINEERING"},
    {"kind": "program_name", "text": "Bachelor of Software Engineering (Honours)"},
    {"kind": "discipline", "text": "Computing Technologies"},
    {"kind": "unit_or_course_code", "text": "COSC2758 Capstone Project"},
    {"kind": "year_or_date", "text": "2026 Project Showcase"},
    {"kind": "supervisor_label", "text": "Supervisor: Dr Avery Nguyen"},
    {"kind": "category_or_tag", "text": "Category: Responsible Innovation"},
    {"kind": "event_or_showcase_heading", "text": "STUDENT PROJECT SHOWCASE"},
    {"kind": "team_label", "text": "Team Delta"},
)


def calibration_corpus_path() -> Path:
    return tool_root() / "ocr-iteration2-calibration" / "corpus" / "calibration.json"


def load_calibration_corpus() -> dict[str, Any]:
    return validate_calibration_corpus(load_json(calibration_corpus_path()))


def _development_id(index: int) -> str:
    return f"ocr2-dev-{index + 1:03d}"


def development_cases(corpus: dict[str, Any]) -> list[dict[str, Any]]:
    """Derive deterministic distractor variants without authoring holdout content."""
    source = [case for case in corpus["ocr_cases"] if case["split"] == "calibration"]
    cases: list[dict[str, Any]] = []
    for index, original in enumerate(source):
        case = copy.deepcopy(original)
        case_id = _development_id(index)
        case.update(
            {
                "id": case_id,
                "split": "development",
                "asset": case_id + Path(str(original["asset"])).suffix.casefold(),
                "source_calibration_case_id": original["id"],
                "measurement_role": "development_only",
            }
        )
        distractors: list[dict[str, str]] = []
        if index < 22:
            distractors.append({**DISTRACTOR_LIBRARY[index % len(DISTRACTOR_LIBRARY)], "position": "above"})
        if index % 2 == 0:
            distractors.append(
                {**DISTRACTOR_LIBRARY[(index + 4) % len(DISTRACTOR_LIBRARY)], "position": "near"}
            )
        case["distractors"] = distractors
        cases.append(case)
    return cases


def development_warmup(corpus: dict[str, Any]) -> dict[str, Any]:
    source = copy.deepcopy(next(case for case in corpus["ocr_cases"] if case["split"] == "warmup"))
    source.update(
        {
            "id": "ocr2-dev-warmup-001",
            "split": "warmup",
            "asset": "ocr2-dev-warmup-001" + Path(str(source["asset"])).suffix.casefold(),
            "source_calibration_case_id": source["id"],
            "measurement_role": "development_only",
            "distractors": [],
        }
    )
    return source


def challenge_summary(cases: list[dict[str, Any]]) -> dict[str, Any]:
    kinds = {
        item["kind"]
        for case in cases
        for item in case["distractors"]
    }
    return {
        "case_count": len(cases),
        "case_id_namespace": "ocr2-dev-*",
        "source": "already-exposed Iteration 2 calibration cases",
        "synthetic_development_text_only": True,
        "cases_with_distractor_above_title": sum(
            any(item["position"] == "above" for item in case["distractors"]) for case in cases
        ),
        "cases_with_distractor_near_title": sum(
            any(item["position"] == "near" for item in case["distractors"]) for case in cases
        ),
        "cases_with_both": sum(
            {item["position"] for item in case["distractors"]} == {"above", "near"}
            for case in cases
        ),
        "cases_with_title_as_topmost_textual_region": sum(
            not any(item["position"] == "above" for item in case["distractors"]) for case in cases
        ),
        "distractor_kinds": sorted(kinds),
    }


def generate_development_assets(corpus: dict[str, Any], output_dir: Path) -> dict[str, Any]:
    cases = development_cases(corpus)
    warmup = development_warmup(corpus)
    output_dir.mkdir(parents=True, exist_ok=True)
    records: list[dict[str, Any]] = []
    for case in [*cases, warmup]:
        target = output_dir / case["asset"]
        _write_case_asset(case, corpus["seed"], target)
        records.append(
            {
                "case_id": case["id"],
                "asset": case["asset"],
                "bytes": target.stat().st_size,
                "sha256": file_sha256(target),
            }
        )
    digest = hashlib.sha256()
    for record in sorted(records, key=lambda item: item["case_id"]):
        digest.update(record["case_id"].encode("utf-8"))
        digest.update(b"\0")
        digest.update(bytes.fromhex(record["sha256"]))
    result = {
        "schema_version": "pp1-ocr-iteration2-distractor-development-assets/v1",
        "measurement_role": "development_only",
        "independent_holdout": False,
        "fresh_holdout_consumed": False,
        "seed": corpus["seed"],
        "asset_count": len(records),
        "asset_tree_sha256": digest.hexdigest(),
        "challenge": challenge_summary(cases),
        "assets": sorted(records, key=lambda item: item["case_id"]),
    }
    (output_dir / "generation.json").write_bytes(canonical_json_bytes(result))
    return result


def _validate_capture(capture: dict[str, Any], cases: list[dict[str, Any]]) -> dict[str, Any]:
    if capture.get("schema_version") != "pp1-ocr-iteration2-capture/v1":
        raise ValueError("unsupported development OCR capture")
    if capture.get("engine") != DEVELOPMENT_CAPTURE_ENGINE:
        raise ValueError("development evidence must use PP-OCRv6 Small")
    if capture.get("configuration_id") != DEVELOPMENT_CONFIGURATION_ID:
        raise ValueError("development evidence must use the selected dpi180-edge1920 raster")
    expected = {case["id"] for case in cases}
    observed = {record["case_id"] for record in capture.get("records", [])}
    failed = {record["case_id"] for record in capture.get("failures", [])}
    if observed | failed != expected or observed & failed:
        raise ValueError("development capture case identities do not match the exposed corpus")
    if failed or len(observed) != len(expected):
        raise ValueError("development evidence requires a successful OCR record for every case")
    return capture


def _safe_rate(numerator: int, denominator: int) -> float | None:
    return numerator / denominator if denominator else None


def _score_dataset(cases: list[dict[str, Any]], capture: dict[str, Any]) -> dict[str, Any]:
    validated = _validate_capture(capture, cases)
    by_case = {case["id"]: case for case in cases}
    observations = {record["case_id"]: record for record in validated["records"]}
    selector_results: dict[str, Any] = {}
    for contract in SELECTOR_CONTRACTS:
        exact_count = 0
        material_false_agreements = 0
        safety_counts = {outcome: 0 for outcome in ("AGREES", "REVIEW", "MISMATCH", "NOT_EVALUATED")}
        for case_id in sorted(observations):
            case = by_case[case_id]
            candidates = run_variant(contract["selector"], contract["order"], observations[case_id]["blocks"])
            selected = candidates[0].text if candidates else ""
            exact_count += bool(selected) and normalize_metric_title(selected) == normalize_metric_title(case["title"])
            safety = evaluate_title_safety(case["metadata_title"], candidates)
            safety_counts[safety["outcome"]] += 1
            material_false_agreements += case["expected_agreement"] is False and safety["outcome"] == "AGREES"
        selector_results[contract["id"]] = {
            "exact_title_count": exact_count,
            "exact_title_rate": _safe_rate(exact_count, len(cases)),
            "material_false_automatic_agreements": material_false_agreements,
            "safety_outcomes": safety_counts,
        }

    order_results: dict[str, Any] = {}
    for order in READING_ORDERS:
        word_edits = 0
        reference_words = 0
        for case_id in sorted(observations):
            result = edit_counts(reference_text(by_case[case_id]), order_text(observations[case_id]["blocks"], order))
            word_edits += result["word_edits"]
            reference_words += result["reference_words"]
        order_results[order] = {
            "word_edits": word_edits,
            "reference_words": reference_words,
            "wer": _safe_rate(word_edits, reference_words),
        }
    return {
        "case_count": len(cases),
        "selectors": selector_results,
        "reading_orders": order_results,
    }


def _select_replacement(datasets: dict[str, dict[str, Any]]) -> dict[str, Any]:
    qualified: list[str] = []
    for contract in SELECTOR_CONTRACTS:
        selector_id = contract["id"]
        if all(
            dataset["selectors"][selector_id]["exact_title_rate"] >= SELECTOR_GATE["exact_title_rate_minimum"]
            and dataset["selectors"][selector_id]["material_false_automatic_agreements"]
            <= SELECTOR_GATE["material_false_automatic_agreements_maximum"]
            for dataset in datasets.values()
        ):
            qualified.append(selector_id)
    selected = qualified[0] if qualified else None
    return {
        "requirements": SELECTOR_GATE,
        "qualified_selectors": qualified,
        "tie_break": "reviewed candidate order; prefer the simpler top-band selector before its centring-assumption variant",
        "selected_selector": selected,
        "passed": selected is not None,
    }


def build_development_evidence(
    original_capture: dict[str, Any], development_capture: dict[str, Any]
) -> dict[str, Any]:
    corpus = load_calibration_corpus()
    original_cases = [case for case in corpus["ocr_cases"] if case["split"] == "calibration"]
    challenged_cases = development_cases(corpus)
    captures = {
        "original_exposed_calibration": original_capture,
        "exposed_development_distractor_challenge": development_capture,
    }
    datasets = {
        "original_exposed_calibration": _score_dataset(original_cases, original_capture),
        "exposed_development_distractor_challenge": _score_dataset(challenged_cases, development_capture),
    }
    selector_gate = _select_replacement(datasets)
    primary_wer = datasets["exposed_development_distractor_challenge"]["reading_orders"]["column"]["wer"]
    return {
        "schema_version": DEVELOPMENT_EVIDENCE_SCHEMA,
        "measurement_role": "development_only",
        "independent_holdout": False,
        "fresh_holdout_consumed": False,
        "ocr_executed": True,
        "unbiased_accuracy_claimed": False,
        "source_calibration_corpus_sha256": file_sha256(calibration_corpus_path()),
        "challenge_definition_sha256": value_sha256(challenged_cases),
        "challenge": challenge_summary(challenged_cases),
        "candidate": {
            "engine": DEVELOPMENT_CAPTURE_ENGINE,
            "family": "PP-OCRv6",
            "variant": "small",
            "configuration_id": DEVELOPMENT_CONFIGURATION_ID,
        },
        "selector_candidates": list(SELECTOR_CONTRACTS),
        "datasets": datasets,
        "selector_gate": selector_gate,
        "development_wer_check": {
            "primary_order": "column",
            "diagnostic_orders": ["raw", "geometry"],
            "primary_mean_wer_maximum": 0.15,
            "primary_mean_wer": primary_wer,
            "passed": primary_wer is not None and primary_wer <= 0.15,
            "future_fresh_holdout_gate_unchanged": 0.12,
        },
        "captures_sha256": {name: value_sha256(capture) for name, capture in captures.items()},
        "captures": captures,
        "holdout_status": {
            "fresh_holdout_exists": False,
            "fresh_case_ids_instantiated": False,
            "fresh_holdout_ocr": False,
            "fresh_holdout_metrics": False,
        },
    }


def validate_development_evidence(stored: dict[str, Any]) -> dict[str, Any]:
    if stored.get("schema_version") != DEVELOPMENT_EVIDENCE_SCHEMA:
        raise ValueError("unsupported Iteration 2 distractor development evidence")
    captures = stored.get("captures")
    if not isinstance(captures, dict):
        raise ValueError("development evidence does not contain its raw captures")
    expected = build_development_evidence(
        captures["original_exposed_calibration"],
        captures["exposed_development_distractor_challenge"],
    )
    if stored != expected:
        raise ValueError("stored distractor development evidence does not recompute")
    return {
        "measurement_role": expected["measurement_role"],
        "selected_selector": expected["selector_gate"]["selected_selector"],
        "selector_gate_passed": expected["selector_gate"]["passed"],
        "development_primary_wer": expected["development_wer_check"]["primary_mean_wer"],
        "development_wer_passed": expected["development_wer_check"]["passed"],
        "fresh_holdout_consumed": False,
    }
