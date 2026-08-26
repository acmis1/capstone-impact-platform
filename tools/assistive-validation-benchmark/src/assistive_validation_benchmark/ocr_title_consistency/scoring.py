from __future__ import annotations

from typing import Any

from ..ocr_failure_analysis.ordering import apply_order
from ..ocr_iteration2_calibration.scoring import _word_counts, operational_checks, operational_measurements
from ..ocr_productionization.title_safety import binary_metrics, normalize_metric_title
from .capture import CAPTURE_SCHEMA
from .renderer import reference_text
from .selector import evaluate_title_outcome, select_title_candidates


def _ratio(numerator: int, denominator: int) -> float:
    return numerator / denominator if denominator else 1.0


def score_capture(
    capture: dict[str, Any],
    corpus: dict[str, Any],
    protocol: dict[str, Any],
    *,
    expected_split: str = "calibration",
) -> dict[str, Any]:
    if capture.get("schema_version") != CAPTURE_SCHEMA:
        raise ValueError("unsupported title-consistency capture")
    if capture.get("configuration") != protocol["configuration"]:
        raise ValueError("capture configuration differs from the title protocol")
    if capture.get("versions") != protocol["candidate"]["runtime"]:
        raise ValueError("capture runtime differs from the title protocol")
    cases = {case["id"]: case for case in corpus["ocr_cases"] if case["split"] == expected_split}
    observed = {record["case_id"]: record for record in capture["records"]}
    failures = {failure["case_id"] for failure in capture["failures"]}
    if set(observed) | failures != set(cases) or set(observed) & failures:
        raise ValueError(f"capture identities differ from the title {expected_split} corpus")

    records = []
    body_edits = 0
    body_words = 0
    for case_id in sorted(observed):
        raw = observed[case_id]
        case = cases[case_id]
        candidates = select_title_candidates(raw["blocks"])
        selected = candidates[0].text if candidates else ""
        outcome = evaluate_title_outcome(case["metadata_title"], candidates)
        expected_title = case["expected_visible_title"]
        title_exact = (
            None
            if expected_title is None
            else bool(selected) and normalize_metric_title(selected) == normalize_metric_title(expected_title)
        )
        ordered = apply_order(raw["blocks"], "geometry")
        edits, words = _word_counts(reference_text(case), "\n".join(block["text"] for block in ordered))
        body_edits += edits
        body_words += words
        records.append(
            {
                "case_id": case_id,
                "expected_consistency": case["expected_consistency"],
                "expected_visible_title": expected_title,
                "selected_title": selected,
                "title_exact": title_exact,
                "outcome": outcome["outcome"],
                "reason": outcome["reason"],
                "lexical_score": outcome["score"],
                "runtime_ms": raw["runtime_ms"],
            }
        )

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
    agrees = [record for record in records if record["outcome"] == "AGREES"]
    agreement_precision = _ratio(
        sum(record["expected_consistency"] == "CONSISTENT" for record in agrees),
        len(agrees),
    )
    review_count = sum(record["outcome"] == "REVIEW" for record in records)
    review_rate = _ratio(review_count, len(records))
    measurements = operational_measurements(
        cold_start_ms=capture.get("cold_start_ms"),
        runtimes_ms=[float(record["runtime_ms"]) for record in records],
        peak_working_set_bytes=capture.get("peak_working_set_bytes"),
        artifact_footprint_bytes=capture.get("artifact_footprint_bytes"),
    )
    operational = operational_checks(measurements, protocol["operational_gates"])
    operational["worker_concurrency"] = capture.get("worker_concurrency") <= protocol["operational_gates"]["worker_concurrency_maximum"]
    gates = protocol["quality_gates"]
    final_checks = {
        "all_scored_cases_executed": not failures and len(records) == len(cases),
        "exact_title_recovery": exact_rate >= gates["exact_title_rate_minimum"],
        "inconsistency_precision": detection["precision"] >= gates["inconsistency_precision_minimum"],
        "inconsistency_recall": detection["recall"] >= gates["inconsistency_recall_minimum"],
        "material_false_automatic_agreements": false_agreements <= gates["material_false_automatic_agreements_maximum"],
        "operational": all(operational.values()),
        "provisioning": capture["provisioning"]["downloaded_during_capture"] is False,
        "offline_security": capture["offline"]["enabled"] is True and capture["offline"]["self_test_passed"] is True,
    }
    margin = protocol["calibration_margin"]
    margin_checks = {
        "exact_title_recovery": exact_rate >= margin["exact_title_rate_minimum"],
        "inconsistency_precision": detection["precision"] >= margin["inconsistency_precision_minimum"],
        "inconsistency_recall": detection["recall"] >= margin["inconsistency_recall_minimum"],
        "material_false_automatic_agreements": false_agreements <= margin["material_false_automatic_agreements_maximum"],
    }
    gates_passed = all(final_checks.values())
    margin_passed = gates_passed and all(margin_checks.values())
    if expected_split == "calibration":
        decision = "READY_TO_FREEZE_TITLE_PROTOCOL" if margin_passed else "CONTINUE_TITLE_CALIBRATION"
    else:
        decision = "READY_FOR_TITLE_OCR_INTEGRATION" if gates_passed else "OCR_TITLE_PROVIDER_DEFERRED"
    return {
        "schema_version": "pp1-ocr-title-consistency-score/v1",
        "role": expected_split,
        "protocol_version": protocol["protocol_version"],
        "corpus_version": corpus["corpus_version"],
        "candidate": "PP-OCRv6 Small title evidence",
        "configuration": capture["configuration"],
        "versions": capture["versions"],
        "case_count": len(cases),
        "failure_count": len(failures),
        "visible_title_case_count": len(exact_records),
        "title_absent_or_unscored_count": len(records) - len(exact_records),
        "exact_title_count": exact_count,
        "exact_title_rate": exact_rate,
        "inconsistency_detection": detection,
        "automatic_agreement_precision": agreement_precision,
        "material_false_automatic_agreements": false_agreements,
        "review_count": review_count,
        "review_rate": review_rate,
        "body_wer_diagnostic": {
            "role": "DIAGNOSTIC_NON_GATING",
            "word_edits": body_edits,
            "reference_words": body_words,
            "wer": body_edits / body_words if body_words else None,
        },
        "operational": {"measurements": measurements, "checks": operational, "passed": all(operational.values())},
        "provisioning": capture["provisioning"],
        "offline": capture["offline"],
        "final_gate_checks": final_checks,
        "final_gates_passed": gates_passed,
        "calibration_margin_checks": margin_checks,
        "calibration_margin_passed": margin_passed,
        "decision": decision,
        "records": records,
    }
