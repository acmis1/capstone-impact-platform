from __future__ import annotations

import hashlib
from typing import Any

from ..ocr_iteration2_calibration.corpus import reference_text as iteration2_calibration_reference
from ..ocr_iteration2_calibration.scoring import (
    _classification_counts,
    _word_counts,
    operational_checks,
    operational_measurements,
)
from ..ocr_iteration2_holdout_protocol.renderer import reference_text as iteration2_holdout_reference
from ..ocr_iteration3.renderer import reference_text as iteration3_reference
from ..ocr_productionization.title_safety import evaluate_title_safety, normalize_metric_title
from .provider import select_title_candidates
from .renderer import reference_text
from .schema import (
    calibration_data_root,
    calibration_evidence_root,
    corpus_summary,
    load_json,
    normalize_identity_text,
    repository_root,
    validate_corpus,
    validate_protocol,
    value_sha256,
)


HISTORICAL_CORPORA = (
    "tools/assistive-validation-benchmark/corpus/manifest.json",
    "tools/assistive-validation-benchmark/ocr-productionization/corpus/calibration.json",
    "tools/assistive-validation-benchmark/ocr-productionization/corpus/holdout.json",
    "tools/assistive-validation-benchmark/ocr-iteration2-calibration/corpus/calibration.json",
    "tools/assistive-validation-benchmark/ocr-iteration2-fresh-holdout/corpus/holdout.json",
    "tools/assistive-validation-benchmark/ocr-iteration3-calibration/corpus/calibration.json",
    "tools/assistive-validation-benchmark/ocr-iteration3-fresh-holdout/corpus/holdout.json",
)


def _cases(value: dict[str, Any]) -> list[dict[str, Any]]:
    return list(value.get("ocr_cases") or value.get("cases") or [])


def _title(case: dict[str, Any]) -> str:
    return str(case.get("title") or case.get("poster_title") or "")


def _legacy_reference(relative: str, case: dict[str, Any]) -> str:
    if "ocr-iteration3" in relative:
        return iteration3_reference(case)
    if "ocr-iteration2-fresh-holdout" in relative:
        return iteration2_holdout_reference(case)
    if "ocr-iteration2-calibration" in relative:
        return iteration2_calibration_reference(case)
    title = _title(case)
    body = case.get("body")
    if isinstance(body, str):
        return "\n".join(part for part in (title, body) if part)
    return title


def _record(case_id: str, title: str, full_reference: str) -> dict[str, str]:
    normalized_reference = normalize_identity_text(full_reference)
    return {
        "case_id": case_id,
        "normalized_title": normalize_identity_text(title),
        "normalized_full_reference_sha256": hashlib.sha256(normalized_reference.encode("utf-8")).hexdigest(),
    }


def non_reuse_evidence(
    corpus: dict[str, Any],
    *,
    split: str,
    additional: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    root = repository_root()
    prior_titles: set[str] = set()
    prior_references: set[str] = set()
    sources = []
    historical_count = 0
    for relative in HISTORICAL_CORPORA:
        value = load_json(root / relative)
        source_cases = _cases(value)
        historical_count += len(source_cases)
        sources.append({"path": relative, "case_count": len(source_cases), "sha256": value_sha256(value)})
        for case in source_cases:
            record = _record(str(case.get("id") or ""), _title(case), _legacy_reference(relative, case))
            if record["normalized_title"]:
                prior_titles.add(record["normalized_title"])
            prior_references.add(record["normalized_full_reference_sha256"])
    for item in additional or []:
        prior_titles.add(item["normalized_title"])
        prior_references.add(item["normalized_full_reference_sha256"])
    records = [
        _record(case["id"], case["title"], reference_text(case))
        for case in corpus["ocr_cases"]
        if case["split"] == split
    ]
    title_reuse = sorted(item["case_id"] for item in records if item["normalized_title"] in prior_titles)
    reference_reuse = sorted(
        item["case_id"] for item in records if item["normalized_full_reference_sha256"] in prior_references
    )
    duplicate_titles = len({item["normalized_title"] for item in records}) != len(records)
    duplicate_references = len({item["normalized_full_reference_sha256"] for item in records}) != len(records)
    return {
        "schema_version": "pp1-ocr-iteration4-non-reuse/v1",
        "role": split,
        "historical_case_count": historical_count,
        "historical_sources": sources,
        "additional_prior_case_count": len(additional or []),
        "current_case_count": len(records),
        "normalized_title_reuse_case_ids": title_reuse,
        "normalized_full_reference_reuse_case_ids": reference_reuse,
        "duplicate_current_titles": duplicate_titles,
        "duplicate_current_full_references": duplicate_references,
        "passed": not title_reuse and not reference_reuse and not duplicate_titles and not duplicate_references,
        "records": records,
    }


def _aggregate(records: list[dict[str, Any]]) -> dict[str, Any]:
    edits = sum(record["word_error_rate"]["word_edits"] for record in records)
    words = sum(record["word_error_rate"]["reference_words"] for record in records)
    return {"word_edits": edits, "reference_words": words, "wer": edits / words if words else None}


def _breakdown(records: list[dict[str, Any]], cases: dict[str, dict[str, Any]], key: str) -> dict[str, Any]:
    return {
        value: {
            "case_count": len(selected),
            "exact_title_count": sum(record["title_exact"] for record in selected),
            "wer": _aggregate(selected)["wer"],
        }
        for value in sorted({case[key] for case in cases.values()})
        if (selected := [record for record in records if cases[record["case_id"]][key] == value])
    }


def score_capture(capture: dict[str, Any], corpus: dict[str, Any], protocol: dict[str, Any]) -> dict[str, Any]:
    if capture.get("schema_version") != "pp1-ocr-iteration4-capture/v1":
        raise ValueError("unsupported Iteration 4 capture")
    cases = {case["id"]: case for case in corpus["ocr_cases"] if case["split"] in {"calibration", "holdout"}}
    observed = {record["case_id"]: record for record in capture["records"]}
    failures = {failure["case_id"] for failure in capture["failures"]}
    if set(observed) | failures != set(cases) or set(observed) & failures:
        raise ValueError("Iteration 4 capture identities differ from the scored corpus")
    records = []
    for case_id in sorted(observed):
        raw = observed[case_id]
        case = cases[case_id]
        candidates = select_title_candidates(raw["blocks"])
        selected_title = candidates[0].text if candidates else ""
        safety = evaluate_title_safety(case["metadata_title"], candidates)
        hypothesis = "\n".join(block["text"] for block in sorted(raw["blocks"], key=lambda item: item["order"]))
        edits, words = _word_counts(reference_text(case), hypothesis)
        records.append(
            {
                "case_id": case_id,
                "expected_agreement": case["expected_agreement"],
                "selected_title": selected_title,
                "title_exact": bool(selected_title)
                and normalize_metric_title(selected_title) == normalize_metric_title(case["title"]),
                "title_safety_outcome": safety["outcome"],
                "runtime_ms": raw["runtime_ms"],
                "block_count": len(raw["blocks"]),
                "word_error_rate": {"word_edits": edits, "reference_words": words},
            }
        )
    labels = [record["expected_agreement"] for record in records]
    equality = [record["title_safety_outcome"] == "AGREES" for record in records]
    assistive = [record["title_safety_outcome"] in {"AGREES", "REVIEW"} for record in records]
    exact_count = sum(record["title_exact"] for record in records)
    material_false = sum(not label and prediction for label, prediction in zip(labels, equality))
    title_rate = exact_count / len(cases)
    primary_wer = _aggregate(records)
    measurements = operational_measurements(
        cold_start_ms=capture.get("cold_start_ms"),
        runtimes_ms=[float(record["runtime_ms"]) for record in records],
        peak_working_set_bytes=capture.get("peak_working_set_bytes"),
        artifact_footprint_bytes=capture.get("artifact_footprint_bytes"),
    )
    operational = operational_checks(measurements, protocol["operational_gates"])
    operational.update(
        {
            "worker_concurrency": capture.get("worker_concurrency")
            <= protocol["operational_gates"]["worker_concurrency_maximum"],
            "whole_run": capture.get("total_run_ms") is not None
            and capture["total_run_ms"] <= protocol["operational_gates"]["whole_run_timeout_seconds"] * 1000,
        }
    )
    quality = protocol["quality_gates"]
    final_checks = {
        "all_scored_cases_executed": not failures and len(records) == len(cases),
        "exact_title": title_rate >= quality["exact_title_rate_minimum"],
        "primary_wer": primary_wer["wer"] is not None and primary_wer["wer"] <= quality["primary_wer_maximum"],
        "material_false_automatic_agreements": not failures
        and material_false <= quality["material_false_automatic_agreements_maximum"],
        "operational": all(operational.values()),
        "provisioning": capture["provisioning"]["downloaded_during_capture"] is False
        and capture["provisioning"]["local_directories_explicit"] is True,
        "offline_security": capture["offline"]["enabled"] is True
        and capture["offline"]["self_test_passed"] is True,
    }
    margin = protocol["calibration_selection"]
    margin_checks = {
        "exact_title_margin": title_rate >= margin["exact_title_rate_minimum"],
        "wer_margin": primary_wer["wer"] is not None and primary_wer["wer"] <= margin["primary_wer_maximum"],
    }
    return {
        "schema_version": "pp1-ocr-iteration4-score/v1",
        "protocol_version": protocol["protocol_version"],
        "corpus_version": corpus["corpus_version"],
        "candidate": "PaddleOCR-VL-1.6 native CPU",
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
        "title_mismatch_fail_safe": not failures and material_false == 0,
        "word_error_rate": primary_wer,
        "difficulty_breakdown": _breakdown(records, cases, "difficulty"),
        "media_breakdown": _breakdown(records, cases, "media"),
        "layout_breakdown": _breakdown(records, cases, "layout"),
        "operational": {"measurements": measurements, "current_checks": operational, "passed": all(operational.values())},
        "final_gate_checks": final_checks,
        "calibration_margin_checks": margin_checks,
        "calibration_margin_passed": all(final_checks.values()) and all(margin_checks.values()),
        "calibration_decision": (
            "PROCEED_TO_CANDIDATE_FREEZE"
            if all(final_checks.values()) and all(margin_checks.values())
            else "ITERATION4_CALIBRATION_INSUFFICIENT"
        ),
        "records": records,
    }


def build_calibration_report(capture: dict[str, Any], corpus: dict[str, Any], protocol: dict[str, Any]) -> dict[str, Any]:
    non_reuse = non_reuse_evidence(corpus, split="calibration")
    if not non_reuse["passed"]:
        raise ValueError("Iteration 4 calibration reuses exposed OCR content")
    score = score_capture(capture, corpus, protocol)
    return {
        "schema_version": "pp1-ocr-iteration4-calibration-evidence/v1",
        "protocol_sha256": value_sha256(protocol),
        "corpus_sha256": value_sha256(corpus),
        "capture_sha256": value_sha256(capture),
        "corpus_summary": corpus_summary(corpus, split="calibration"),
        "non_reuse": non_reuse,
        "score": score,
        "holdout_permitted": score["calibration_margin_passed"],
        "production_integration_permitted": False,
    }


def validate_calibration_report(
    report: dict[str, Any], capture: dict[str, Any], corpus: dict[str, Any], protocol: dict[str, Any]
) -> dict[str, Any]:
    if report != build_calibration_report(capture, corpus, protocol):
        raise ValueError("stored Iteration 4 calibration evidence differs from recomputation")
    return report


def calibration_inputs() -> tuple[dict[str, Any], dict[str, Any]]:
    protocol = validate_protocol(load_json(calibration_data_root() / "protocol.json"))
    corpus = validate_corpus(
        load_json(calibration_data_root() / "corpus" / "calibration.json"),
        expected_split="calibration",
        expected_count=27,
    )
    return protocol, corpus


def tracked_calibration_evidence() -> tuple[dict[str, Any], dict[str, Any]]:
    root = calibration_evidence_root()
    return load_json(root / "calibration-capture.json"), load_json(root / "calibration-report.json")
