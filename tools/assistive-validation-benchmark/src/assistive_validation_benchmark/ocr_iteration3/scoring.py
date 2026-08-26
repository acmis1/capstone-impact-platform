from __future__ import annotations

from pathlib import Path
from typing import Any

from ..ocr_failure_analysis.ordering import apply_order
from ..ocr_iteration2_calibration.report import _merged_operational_evidence
from ..ocr_iteration2_calibration.scoring import (
    _classification_counts,
    _word_counts,
    operational_checks,
    operational_measurements,
)
from ..ocr_iteration2_holdout_protocol.renderer import reference_text as iteration2_reference_text
from ..ocr_productionization.title_safety import evaluate_title_safety, normalize_metric_title
from .candidate_b import CAPTURE_SCHEMA as CANDIDATE_B_CAPTURE_SCHEMA
from .candidate_b import pp_structure_assisted_order
from .reading_order import adaptive_column_order_with_trace, apply_adaptive_order
from .renderer import reference_text
from .schema import load_json, repository_root
from .title_selector import select_title_candidates


def _aggregate(records: list[dict[str, Any]], order: str) -> dict[str, Any]:
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
            "adaptive_wer": _aggregate(selected, "adaptive")["wer"],
        }
    return result


def score_capture(capture: dict[str, Any], corpus: dict[str, Any], protocol: dict[str, Any]) -> dict[str, Any]:
    if capture.get("schema_version") != "pp1-ocr-iteration3-capture/v1":
        raise ValueError("unsupported Iteration 3 capture")
    cases = {case["id"]: case for case in corpus["ocr_cases"] if case["split"] in {"calibration", "holdout"}}
    observed = {record["case_id"]: record for record in capture["records"]}
    failures = {failure["case_id"] for failure in capture["failures"]}
    if set(observed) | failures != set(cases) or set(observed) & failures:
        raise ValueError("capture identities differ from the scored corpus")
    records = []
    for case_id in sorted(observed):
        raw = observed[case_id]
        case = cases[case_id]
        candidates = select_title_candidates(raw["blocks"])
        selected = candidates[0].text if candidates else ""
        safety = evaluate_title_safety(case["metadata_title"], candidates)
        hypotheses = {
            "raw": raw["blocks"],
            "iteration2_column": apply_order(raw["blocks"], "column"),
            "adaptive": apply_adaptive_order(raw["blocks"]),
        }
        reading_orders = {}
        reference = reference_text(case)
        for name, blocks in hypotheses.items():
            edits, words = _word_counts(reference, "\n".join(block["text"] for block in blocks))
            reading_orders[name] = {"word_edits": edits, "reference_words": words}
        _, trace = adaptive_column_order_with_trace(raw["blocks"])
        records.append(
            {
                "case_id": case_id,
                "expected_agreement": case["expected_agreement"],
                "title_exact": bool(selected) and normalize_metric_title(selected) == normalize_metric_title(case["title"]),
                "safety_outcome": safety["outcome"],
                "runtime_ms": raw["runtime_ms"],
                "reading_orders": reading_orders,
                "adaptive_trace": trace,
            }
        )
    labels = [record["expected_agreement"] for record in records]
    equality = [record["safety_outcome"] == "AGREES" for record in records]
    assistive = [record["safety_outcome"] in {"AGREES", "REVIEW"} for record in records]
    exact_count = sum(record["title_exact"] for record in records)
    material_false = sum(not label and prediction for label, prediction in zip(labels, equality))
    orders = {name: _aggregate(records, name) for name in ("raw", "iteration2_column", "adaptive")}
    measurements = operational_measurements(
        cold_start_ms=capture.get("cold_start_ms"),
        runtimes_ms=[float(record["runtime_ms"]) for record in records],
        peak_working_set_bytes=capture.get("peak_working_set_bytes"),
        artifact_footprint_bytes=capture.get("artifact_footprint_bytes"),
    )
    operational_current = operational_checks(measurements, protocol["operational_gates"])
    historical = _merged_operational_evidence(protocol["operational_gates"])["paddle-small"]
    title_rate = exact_count / len(cases)
    quality = protocol["quality_gates"]
    calibration = protocol["calibration_selection"]
    final_gate_checks = {
        "all_scored_cases_executed": not failures and len(records) == len(cases),
        "exact_title": title_rate >= quality["exact_title_rate_minimum"],
        "primary_wer": orders["adaptive"]["wer"] <= quality["primary_wer_maximum"],
        "material_false_automatic_agreements": material_false <= quality["material_false_automatic_agreements_maximum"],
        "operational": historical["plausibly_inside_established_limits"] and all(operational_current.values()),
        "provisioning": capture["provisioning"]["downloaded_during_capture"] is False,
        "offline_security": capture["offline"]["enabled"] is True and capture["offline"]["self_test_passed"] is True,
    }
    margin_checks = {
        "exact_title_margin": title_rate >= calibration["exact_title_rate_minimum"],
        "wer_margin": orders["adaptive"]["wer"] <= calibration["adaptive_wer_maximum"],
    }
    return {
        "schema_version": "pp1-ocr-iteration3-calibration-result/v1",
        "protocol_version": protocol["protocol_version"],
        "corpus_version": corpus["corpus_version"],
        "candidate": "PP-OCRv6 Small + adaptive deterministic reading order",
        "configuration": capture["configuration"],
        "versions": capture["versions"],
        "provisioning": capture["provisioning"],
        "offline": capture["offline"],
        "case_count": len(cases),
        "failure_count": len(failures),
        "title_exact_count": exact_count,
        "title_exact_rate": title_rate,
        "equality_path": _classification_counts(labels, equality),
        "assistive_path": _classification_counts(labels, assistive),
        "material_false_automatic_agreements": material_false,
        "word_error_rate": orders,
        "difficulty_breakdown": _breakdown(records, cases, "difficulty"),
        "media_breakdown": _breakdown(records, cases, "media"),
        "layout_breakdown": _breakdown(records, cases, "layout"),
        "operational": {
            "measurements": measurements,
            "current_checks": operational_current,
            "historical_prior": historical,
            "passed": historical["plausibly_inside_established_limits"] and all(operational_current.values()),
        },
        "final_gate_checks": final_gate_checks,
        "calibration_margin_checks": margin_checks,
        "candidate_a_sufficient": all(final_gate_checks.values()) and all(margin_checks.values()),
        "selection": "CANDIDATE_A" if all(final_gate_checks.values()) and all(margin_checks.values()) else "ESCALATE_TO_CANDIDATE_B",
        "records": records,
    }


def exposed_iteration2_diagnostic() -> dict[str, Any]:
    root = repository_root()
    capture = load_json(root / "docs" / "assistive-validation" / "evidence" / "ocr-iteration2-fresh-holdout" / "holdout-capture.json")
    corpus = load_json(root / "tools" / "assistive-validation-benchmark" / "ocr-iteration2-fresh-holdout" / "corpus" / "holdout.json")
    cases = {case["id"]: case for case in corpus["ocr_cases"] if case["split"] == "holdout"}
    totals = {name: {"word_edits": 0, "reference_words": 0} for name in ("iteration2_column", "adaptive")}
    modes: dict[str, int] = {}
    for record in capture["records"]:
        case = cases[record["case_id"]]
        reference = iteration2_reference_text(case)
        ordered = {
            "iteration2_column": apply_order(record["blocks"], "column"),
            "adaptive": apply_adaptive_order(record["blocks"]),
        }
        for name, blocks in ordered.items():
            edits, words = _word_counts(reference, "\n".join(block["text"] for block in blocks))
            totals[name]["word_edits"] += edits
            totals[name]["reference_words"] += words
        _, trace = adaptive_column_order_with_trace(record["blocks"])
        modes[trace["mode"]] = modes.get(trace["mode"], 0) + 1
    for values in totals.values():
        values["wer"] = values["word_edits"] / values["reference_words"]
    return {
        "role": "exposed_iteration2_failure_diagnostic_only",
        "case_count": len(cases),
        "iteration2_column": totals["iteration2_column"],
        "candidate_a_adaptive": totals["adaptive"],
        "candidate_a_modes": modes,
        "tuning_against_case_text_permitted": False,
    }


def score_candidate_b_capture(
    capture: dict[str, Any], corpus: dict[str, Any], protocol: dict[str, Any]
) -> dict[str, Any]:
    if capture.get("schema_version") != CANDIDATE_B_CAPTURE_SCHEMA:
        raise ValueError("unsupported Iteration 3 Candidate B capture")
    cases = {case["id"]: case for case in corpus["ocr_cases"] if case["split"] == "calibration"}
    observed = {record["case_id"]: record for record in capture["records"]}
    failures = {failure["case_id"] for failure in capture["failures"]}
    if set(observed) | failures != set(cases) or set(observed) & failures:
        raise ValueError("Candidate B capture identities differ from the calibration corpus")
    records = []
    for case_id in sorted(observed):
        raw = observed[case_id]
        case = cases[case_id]
        candidates = select_title_candidates(raw["blocks"])
        selected = candidates[0].text if candidates else ""
        safety = evaluate_title_safety(case["metadata_title"], candidates)
        parsing_text = "\n".join(
            item["block_content"]
            for item in sorted(raw["parsing_res_list"], key=lambda item: item["block_order"])
            if item["block_content"].strip()
        )
        hypotheses = {
            "raw": "\n".join(block["text"] for block in raw["blocks"]),
            "adaptive_only": "\n".join(block["text"] for block in apply_adaptive_order(raw["blocks"])),
            "pp_structure_parsing": parsing_text,
            "structure_assisted": "\n".join(
                block["text"]
                for block in pp_structure_assisted_order(raw["blocks"], raw["parsing_res_list"])
            ),
        }
        reading_orders = {}
        reference = reference_text(case)
        for name, hypothesis in hypotheses.items():
            edits, words = _word_counts(reference, hypothesis)
            reading_orders[name] = {"word_edits": edits, "reference_words": words}
        records.append(
            {
                "case_id": case_id,
                "expected_agreement": case["expected_agreement"],
                "title_exact": bool(selected)
                and normalize_metric_title(selected) == normalize_metric_title(case["title"]),
                "safety_outcome": safety["outcome"],
                "runtime_ms": raw["runtime_ms"],
                "parsing_block_count": len(raw["parsing_res_list"]),
                "reading_orders": reading_orders,
            }
        )
    labels = [record["expected_agreement"] for record in records]
    equality = [record["safety_outcome"] == "AGREES" for record in records]
    assistive = [record["safety_outcome"] in {"AGREES", "REVIEW"} for record in records]
    exact_count = sum(record["title_exact"] for record in records)
    material_false = sum(not label and prediction for label, prediction in zip(labels, equality))
    orders = {
        name: _aggregate(records, name)
        for name in ("raw", "adaptive_only", "pp_structure_parsing", "structure_assisted")
    }
    measurements = operational_measurements(
        cold_start_ms=capture.get("cold_start_ms"),
        runtimes_ms=[float(record["runtime_ms"]) for record in records],
        peak_working_set_bytes=capture.get("peak_working_set_bytes"),
        artifact_footprint_bytes=capture.get("artifact_footprint_bytes"),
    )
    operational_current = operational_checks(measurements, protocol["operational_gates"])
    historical_recognition_prior = _merged_operational_evidence(protocol["operational_gates"])["paddle-small"]
    title_rate = exact_count / len(cases)
    primary_wer = orders["structure_assisted"]["wer"]
    quality = protocol["quality_gates"]
    calibration = protocol["calibration_selection"]
    final_gate_checks = {
        "all_scored_cases_executed": not failures and len(records) == len(cases),
        "exact_title": title_rate >= quality["exact_title_rate_minimum"],
        "primary_wer": primary_wer <= quality["primary_wer_maximum"],
        "material_false_automatic_agreements": material_false
        <= quality["material_false_automatic_agreements_maximum"],
        "operational": all(operational_current.values()),
        "provisioning": capture["provisioning"]["downloaded_during_capture"] is False,
        "offline_security": capture["offline"]["enabled"] is True
        and capture["offline"]["self_test_passed"] is True,
    }
    margin_checks = {
        "exact_title_margin": title_rate >= calibration["exact_title_rate_minimum"],
        "wer_margin": primary_wer <= calibration["adaptive_wer_maximum"],
    }
    sufficient = all(final_gate_checks.values()) and all(margin_checks.values())
    return {
        "schema_version": "pp1-ocr-iteration3-candidate-b-result/v1",
        "candidate": capture["candidate"],
        "protocol_version": protocol["protocol_version"],
        "configuration": capture["configuration"],
        "versions": capture["versions"],
        "provisioning": capture["provisioning"],
        "offline": capture["offline"],
        "case_count": len(cases),
        "failure_count": len(failures),
        "title_exact_count": exact_count,
        "title_exact_rate": title_rate,
        "equality_path": _classification_counts(labels, equality),
        "assistive_path": _classification_counts(labels, assistive),
        "material_false_automatic_agreements": material_false,
        "word_error_rate": orders,
        "operational": {
            "measurements": measurements,
            "current_checks": operational_current,
            "historical_pp_ocrv6_small_prior": historical_recognition_prior,
            "passed": all(operational_current.values()),
        },
        "final_gate_checks": final_gate_checks,
        "calibration_margin_checks": margin_checks,
        "candidate_b_sufficient": sufficient,
        "selection": "CANDIDATE_B" if sufficient else "ESCALATE_TO_CANDIDATE_C",
        "records": records,
    }
