from __future__ import annotations

import hashlib
from typing import Any

from .renderer import reference_text
from .schema import (
    calibration_data_root,
    corpus_summary,
    file_sha256,
    load_json,
    normalize_identity_text,
    repository_root,
    semantic_case_hash,
    validate_corpus,
    validate_protocol,
    value_sha256,
)
from .scoring import exposed_iteration2_diagnostic, score_candidate_b_capture, score_capture


HISTORICAL_CORPORA = (
    "tools/assistive-validation-benchmark/corpus/manifest.json",
    "tools/assistive-validation-benchmark/ocr-productionization/corpus/calibration.json",
    "tools/assistive-validation-benchmark/ocr-productionization/corpus/holdout.json",
    "tools/assistive-validation-benchmark/ocr-iteration2-calibration/corpus/calibration.json",
    "tools/assistive-validation-benchmark/ocr-iteration2-fresh-holdout/corpus/holdout.json",
)

CALIBRATION_FREEZE_FILES = (
    "tools/assistive-validation-benchmark/ocr-iteration3-calibration/protocol.json",
    "tools/assistive-validation-benchmark/ocr-iteration3-calibration/corpus/calibration.json",
    "tools/assistive-validation-benchmark/src/assistive_validation_benchmark/ocr_iteration3/capture.py",
    "tools/assistive-validation-benchmark/src/assistive_validation_benchmark/ocr_iteration3/corpus.py",
    "tools/assistive-validation-benchmark/src/assistive_validation_benchmark/ocr_iteration3/reading_order.py",
    "tools/assistive-validation-benchmark/src/assistive_validation_benchmark/ocr_iteration3/renderer.py",
    "tools/assistive-validation-benchmark/src/assistive_validation_benchmark/ocr_iteration3/schema.py",
    "tools/assistive-validation-benchmark/src/assistive_validation_benchmark/ocr_iteration3/scoring.py",
    "tools/assistive-validation-benchmark/src/assistive_validation_benchmark/ocr_iteration3/title_selector.py",
)


def _historical_cases(value: dict[str, Any]) -> list[dict[str, Any]]:
    return list(value.get("ocr_cases") or value.get("cases") or [])


def _historical_title(case: dict[str, Any]) -> str:
    return str(case.get("title") or case.get("poster_title") or "")


def _historical_text(case: dict[str, Any]) -> str:
    parts = [_historical_title(case)]
    body = case.get("body")
    if isinstance(body, str):
        parts.append(body)
    sections = case.get("body_sections")
    if isinstance(sections, list):
        parts.extend(str(item) for item in sections)
    distractors = case.get("distractors")
    if isinstance(distractors, list):
        parts.extend(str(item.get("text") or "") for item in distractors if isinstance(item, dict))
    return "\n".join(parts)


def non_reuse_evidence(corpus: dict[str, Any], *, split: str, additional: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    root = repository_root()
    historical_titles: set[str] = set()
    historical_hashes: set[str] = set()
    historical_count = 0
    sources = []
    for relative in HISTORICAL_CORPORA:
        path = root / relative
        value = load_json(path)
        cases = _historical_cases(value)
        historical_count += len(cases)
        sources.append({"path": relative, "case_count": len(cases), "sha256": value_sha256(value)})
        for case in cases:
            title = _historical_title(case)
            text = _historical_text(case)
            if title:
                historical_titles.add(normalize_identity_text(title))
            if text.strip():
                historical_hashes.add(hashlib.sha256(normalize_identity_text(text).encode("utf-8")).hexdigest())
    for item in additional or []:
        historical_titles.add(item["normalized_title"])
        historical_hashes.add(item["semantic_hash"])
    cases = [case for case in corpus["ocr_cases"] if case["split"] == split]
    records = [
        {
            "case_id": case["id"],
            "normalized_title": normalize_identity_text(case["title"]),
            "semantic_hash": semantic_case_hash(case, reference_text(case)),
        }
        for case in cases
    ]
    title_reuse = sorted(record["case_id"] for record in records if record["normalized_title"] in historical_titles)
    semantic_reuse = sorted(record["case_id"] for record in records if record["semantic_hash"] in historical_hashes)
    duplicate_titles = len({record["normalized_title"] for record in records}) != len(records)
    duplicate_semantics = len({record["semantic_hash"] for record in records}) != len(records)
    return {
        "schema_version": "pp1-ocr-iteration3-non-reuse/v1",
        "role": split,
        "historical_case_count": historical_count,
        "historical_sources": sources,
        "additional_prior_case_count": len(additional or []),
        "current_case_count": len(records),
        "normalized_title_reuse_case_ids": title_reuse,
        "normalized_semantic_reuse_case_ids": semantic_reuse,
        "duplicate_current_titles": duplicate_titles,
        "duplicate_current_semantics": duplicate_semantics,
        "passed": not title_reuse and not semantic_reuse and not duplicate_titles and not duplicate_semantics,
        "records": records,
    }


def build_calibration_report(capture: dict[str, Any], corpus: dict[str, Any], protocol: dict[str, Any]) -> dict[str, Any]:
    result = score_capture(capture, corpus, protocol)
    non_reuse = non_reuse_evidence(corpus, split="calibration")
    if not non_reuse["passed"]:
        raise ValueError("Iteration 3 calibration corpus reuses exposed OCR content")
    return {
        "schema_version": "pp1-ocr-iteration3-calibration-evidence/v1",
        "protocol_sha256": value_sha256(protocol),
        "corpus_sha256": value_sha256(corpus),
        "capture_sha256": value_sha256(capture),
        "corpus_summary": corpus_summary(corpus, split="calibration"),
        "non_reuse": non_reuse,
        "iteration2_root_cause_diagnostic": exposed_iteration2_diagnostic(),
        "candidate_a": result,
        "candidate_b": {"executed": False, "reason": "Candidate A selection is decided before escalation."},
        "candidate_c": {"executed": False, "reason": "Candidate C is forbidden unless Candidates A and B are insufficient."},
        "selection": result["selection"],
    }


def validate_calibration_report(report: dict[str, Any], capture: dict[str, Any], corpus: dict[str, Any], protocol: dict[str, Any]) -> dict[str, Any]:
    recomputed = build_calibration_report(capture, corpus, protocol)
    if report != recomputed:
        raise ValueError("stored Iteration 3 calibration evidence differs from recomputation")
    return report


def build_candidate_b_report(
    capture: dict[str, Any], corpus: dict[str, Any], protocol: dict[str, Any]
) -> dict[str, Any]:
    non_reuse = non_reuse_evidence(corpus, split="calibration")
    if not non_reuse["passed"]:
        raise ValueError("Iteration 3 Candidate B corpus reuses exposed OCR content")
    return {
        "schema_version": "pp1-ocr-iteration3-candidate-b-evidence/v1",
        "protocol_sha256": value_sha256(protocol),
        "corpus_sha256": value_sha256(corpus),
        "capture_sha256": value_sha256(capture),
        "corpus_summary": corpus_summary(corpus, split="calibration"),
        "non_reuse": non_reuse,
        "candidate_b": score_candidate_b_capture(capture, corpus, protocol),
    }


def validate_candidate_b_report(
    report: dict[str, Any], capture: dict[str, Any], corpus: dict[str, Any], protocol: dict[str, Any]
) -> dict[str, Any]:
    recomputed = build_candidate_b_report(capture, corpus, protocol)
    if report != recomputed:
        raise ValueError("stored Candidate B calibration evidence differs from recomputation")
    return report


def build_calibration_decision(
    *,
    initial_capture: dict[str, Any],
    initial_report: dict[str, Any],
    repeat_capture: dict[str, Any],
    repeat_report: dict[str, Any],
    candidate_b_capture: dict[str, Any],
    candidate_b_report: dict[str, Any],
    corpus: dict[str, Any],
    protocol: dict[str, Any],
) -> dict[str, Any]:
    validate_calibration_report(initial_report, initial_capture, corpus, protocol)
    validate_calibration_report(repeat_report, repeat_capture, corpus, protocol)
    validate_candidate_b_report(candidate_b_report, candidate_b_capture, corpus, protocol)
    initial = initial_report["candidate_a"]
    repeat = repeat_report["candidate_a"]
    candidate_b = candidate_b_report["candidate_b"]
    if initial["candidate_a_sufficient"] or not repeat["candidate_a_sufficient"]:
        raise ValueError("Candidate A attempt chronology differs from the preserved calibration evidence")
    if candidate_b["candidate_b_sufficient"]:
        raise ValueError("Candidate B unexpectedly satisfies the frozen calibration gates")
    root = repository_root()
    manifest = [
        {"path": relative, "sha256": file_sha256(root / relative)}
        for relative in CALIBRATION_FREEZE_FILES
    ]
    return {
        "schema_version": "pp1-ocr-iteration3-calibration-decision/v1",
        "protocol_version": protocol["protocol_version"],
        "protocol_sha256": value_sha256(protocol),
        "corpus_sha256": value_sha256(corpus),
        "attempts": [
            {
                "candidate": "CANDIDATE_A",
                "role": "initial_current_measurement",
                "capture_sha256": value_sha256(initial_capture),
                "report_sha256": value_sha256(initial_report),
                "sufficient": False,
                "selection": initial["selection"],
            },
            {
                "candidate": "CANDIDATE_B",
                "role": "required_escalation_after_initial_candidate_a_miss",
                "capture_sha256": value_sha256(candidate_b_capture),
                "report_sha256": value_sha256(candidate_b_report),
                "sufficient": False,
                "selection": candidate_b["selection"],
            },
            {
                "candidate": "CANDIDATE_A",
                "role": "permitted_fresh_process_calibration_repeat",
                "capture_sha256": value_sha256(repeat_capture),
                "report_sha256": value_sha256(repeat_report),
                "sufficient": True,
                "selection": repeat["selection"],
            },
        ],
        "selected_candidate": "CANDIDATE_A",
        "selection_basis": (
            "The latest permitted fresh-process Candidate A calibration repeat passes every unchanged "
            "final gate and both calibration margins; the initial miss and Candidate B failure remain preserved."
        ),
        "candidate_c": {
            "executed": False,
            "reason": "Forbidden because Candidate A is sufficient after the permitted calibration repeat.",
        },
        "candidate_freeze": {
            "model": protocol["candidate"],
            "configuration": protocol["configuration"],
            "reading_order": protocol["reading_order"],
            "title_contract": protocol["title_contract"],
            "quality_gates": protocol["quality_gates"],
            "operational_gates": protocol["operational_gates"],
            "source_manifest": manifest,
        },
        "holdout_permitted": True,
        "holdout_generated": False,
        "production_integration_permitted": False,
    }


def validate_calibration_decision(
    decision: dict[str, Any],
    *,
    initial_capture: dict[str, Any],
    initial_report: dict[str, Any],
    repeat_capture: dict[str, Any],
    repeat_report: dict[str, Any],
    candidate_b_capture: dict[str, Any],
    candidate_b_report: dict[str, Any],
    corpus: dict[str, Any],
    protocol: dict[str, Any],
) -> dict[str, Any]:
    recomputed = build_calibration_decision(
        initial_capture=initial_capture,
        initial_report=initial_report,
        repeat_capture=repeat_capture,
        repeat_report=repeat_report,
        candidate_b_capture=candidate_b_capture,
        candidate_b_report=candidate_b_report,
        corpus=corpus,
        protocol=protocol,
    )
    if decision != recomputed:
        raise ValueError("stored Iteration 3 calibration decision differs from recomputation")
    return decision


def calibration_inputs() -> tuple[dict[str, Any], dict[str, Any]]:
    protocol = validate_protocol(load_json(calibration_data_root() / "protocol.json"))
    corpus = validate_corpus(
        load_json(calibration_data_root() / "corpus" / "calibration.json"),
        expected_split="calibration",
        expected_count=18,
    )
    return protocol, corpus
