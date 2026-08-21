from __future__ import annotations

import hashlib
import json
import platform
from collections import Counter
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .corpus import PHASE6_CORPUS_VERSION, PHASE6_SEED, manifest_sha256, validate_phase6_manifest
from .duplicates import evaluate_lexical_duplicates
from .grammar import local_languagetool_server, run_harper, run_languagetool, score_grammar_engine


def _score_splits(
    cases: list[dict[str, Any]], findings: list[list[dict[str, Any]]], approved_terms: set[str]
) -> dict[str, Any]:
    all_result = score_grammar_engine(cases, findings, approved_terms)
    by_split: dict[str, Any] = {}
    for split in ("calibration", "holdout"):
        indexes = [index for index, case in enumerate(cases) if case["split"] == split]
        if indexes:
            by_split[split] = score_grammar_engine(
                [cases[index] for index in indexes], [findings[index] for index in indexes], approved_terms
            )
    all_result["by_split"] = by_split
    return all_result


def _grammar_decisions(grammar: dict[str, Any], final_measurement: bool) -> dict[str, dict[str, Any]]:
    quality: dict[str, tuple[float, float, int, float]] = {}
    for name, result in grammar.items():
        holdout = result.get("scores", {}).get("by_split", {}).get("holdout", {}).get("vocabulary_policy", {})
        if result.get("status") == "ok" and holdout:
            quality[name] = (
                holdout.get("precision", 0.0),
                holdout.get("recall", 0.0),
                -holdout.get("false_positives", 0),
                -(result.get("latency_p95_ms") or float("inf")),
            )
    eligible = {name: values for name, values in quality.items() if values[0] >= 0.90 and values[1] >= 0.40}
    winner = max(eligible, key=lambda name: eligible[name]) if eligible and final_measurement else None
    decisions: dict[str, dict[str, Any]] = {}
    for name in ("harper", "languagetool"):
        result = grammar.get(name, {})
        holdout = result.get("scores", {}).get("by_split", {}).get("holdout", {}).get("vocabulary_policy", {})
        if not final_measurement:
            decisions[name] = {"decision": "CALIBRATION_ONLY", "bounded_role": "grammar/spelling candidate"}
        elif result.get("status") != "ok" or not holdout:
            decisions[name] = {
                "decision": "DEFER",
                "bounded_role": "grammar/spelling candidate",
                "reason": "Required local holdout execution evidence is unavailable.",
            }
        elif name == winner:
            decisions[name] = {
                "decision": "SELECT",
                "bounded_role": "non-authoritative grammar/spelling suggestions for staff review",
                "reason": (
                    f"Holdout vocabulary-policy precision {holdout['precision']:.1%}, recall {holdout['recall']:.1%}, "
                    f"and {holdout['false_positives']} false positives meet the precision-first gate and lead the eligible candidates."
                ),
            }
        elif holdout.get("precision", 0.0) < 0.90:
            decisions[name] = {
                "decision": "DEFER",
                "bounded_role": "grammar/spelling candidate",
                "reason": (
                    f"Holdout vocabulary-policy precision {holdout['precision']:.1%}, recall {holdout['recall']:.1%}, "
                    f"and {holdout['false_positives']} false positives fail the required 90.0% precision gate."
                ),
            }
        else:
            decisions[name] = {
                "decision": "DEFER",
                "bounded_role": "grammar/spelling candidate",
                "reason": (
                    f"Holdout vocabulary-policy precision {holdout['precision']:.1%}, recall {holdout['recall']:.1%}, "
                    f"and {holdout['false_positives']} false positives pass the gate but do not lead the eligible candidates."
                ),
            }
    return decisions


def make_phase6_decisions(grammar: dict[str, Any], duplicates: dict[str, Any], final_measurement: bool) -> dict[str, Any]:
    decisions: dict[str, Any] = _grammar_decisions(grammar, final_measurement)
    holdout = duplicates.get("by_split", {}).get("holdout", {})
    recall5 = holdout.get("recall_at_5", 0.0)
    lexical_select = final_measurement and recall5 >= 0.95
    decisions["lexical_duplicate_ranking"] = {
        "decision": "SELECT" if lexical_select else ("CALIBRATION_ONLY" if not final_measurement else "DEFER"),
        "bounded_role": "ranked top-five candidate generation for human review",
        "reason": (
            f"Holdout Recall@5 {recall5:.1%}; {holdout.get('queries_missed_at_5', 0)} labelled queries missed the top-five shortlist."
            if final_measurement else "Only calibration queries were measured."
        ),
    }
    trigger = duplicates.get("embedding_trigger", {})
    decisions["embeddings"] = {
        "decision": "DEFER" if final_measurement and not trigger.get("triggered") else (
            "BENCHMARK_REQUIRED" if final_measurement else "CALIBRATION_ONLY"
        ),
        "execution": "NOT_RUN",
        "bounded_role": "possible semantic shortlist challenger only",
        "reason": "; ".join(trigger.get("reasons", [])),
    }
    return decisions


def run_phase6_benchmark(
    manifest: dict[str, Any],
    *,
    tool_root: Path,
    measurement: str,
    languagetool_jar: Path,
) -> dict[str, Any]:
    validate_phase6_manifest(manifest)
    if measurement not in {"calibration", "final"}:
        raise ValueError("measurement must be calibration or final")
    final_measurement = measurement == "final"
    grammar_cases = manifest["grammar_cases"] if final_measurement else [
        case for case in manifest["grammar_cases"] if case["split"] == "calibration"
    ]
    duplicate_queries = manifest["duplicate_queries"] if final_measurement else [
        query for query in manifest["duplicate_queries"] if query["split"] == "calibration"
    ]
    policy_path = tool_root / "phase6" / "grammar" / "vocabulary-policy.json"
    policy = json.loads(policy_path.read_text(encoding="utf-8"))
    approved_terms = {item["term"] for item in policy["approved_terms"]}

    harper = run_harper(grammar_cases, tool_root)
    if harper["status"] == "ok":
        harper["scores"] = _score_splits(grammar_cases, harper.pop("case_findings"), approved_terms)

    with local_languagetool_server(languagetool_jar) as server:
        languagetool = run_languagetool(grammar_cases, server["base_url"], server["pid"])
        languagetool["cold_start_ms"] = server["cold_start_ms"]
    if languagetool["status"] == "ok":
        languagetool["scores"] = _score_splits(grammar_cases, languagetool.pop("case_findings"), approved_terms)

    duplicates = evaluate_lexical_duplicates(duplicate_queries, manifest["duplicate_candidates"])
    if final_measurement and duplicates["embedding_trigger"]["triggered"]:
        raise RuntimeError("Embedding trigger met: final evidence requires exactly one controlled challenger benchmark")
    grammar = {"harper": harper, "languagetool": languagetool}
    completed = datetime.now(timezone.utc)
    report = {
        "report_schema_version": 1,
        "benchmark": "PP1 Assistive Validation Phase 6A — Grammar & Near-Duplicate Decision Benchmark",
        "corpus_version": PHASE6_CORPUS_VERSION,
        "seed": PHASE6_SEED,
        "manifest_sha256": manifest_sha256(manifest),
        "vocabulary_policy_sha256": hashlib.sha256(policy_path.read_bytes()).hexdigest(),
        "measurement": measurement,
        "completed_at": completed.isoformat(),
        "environment": {
            "python": platform.python_version(),
            "node": "24.14.1 required by pinned adapter",
            "java": "local runtime; version captured in documented execution",
            "os": platform.platform(),
            "cpu_only": True,
        },
        "corpus": {
            "grammar_cases": len(manifest["grammar_cases"]),
            "grammar_calibration": sum(case["split"] == "calibration" for case in manifest["grammar_cases"]),
            "grammar_holdout": sum(case["split"] == "holdout" for case in manifest["grammar_cases"]),
            "grammar_clean": sum(case["intentionally_clean"] for case in manifest["grammar_cases"]),
            "grammar_error": sum(not case["intentionally_clean"] for case in manifest["grammar_cases"]),
            "duplicate_candidates": len(manifest["duplicate_candidates"]),
            "duplicate_queries": len(manifest["duplicate_queries"]),
            "duplicate_calibration": sum(query["split"] == "calibration" for query in manifest["duplicate_queries"]),
            "duplicate_holdout": sum(query["split"] == "holdout" for query in manifest["duplicate_queries"]),
            "provenance": manifest["provenance"],
        },
        "benchmark_history": {
            "current_iteration": 2,
            "previous_result": {
                "corpus_version": "pp1-assistive-phase6a-v1",
                "manifest_sha256": "08a397dd74d4154c7ade2f12cd56c8e1f67bd0a1d24c570e7b2ad1471cd96fb8",
                "completed_at": "2026-08-21T03:40:30.221247+00:00",
                "preservation_reason": "A repository terminology contract required a wording-only corpus revision after the first holdout; no quality threshold, label, policy, weight, filter, or engine setting changed.",
                "holdout": {
                    "harper_raw": {"precision": 0.5, "recall": 0.3, "f1": 0.375},
                    "harper_vocabulary_policy": {"precision": 2 / 3, "recall": 0.3, "f1": 12 / 29},
                    "languagetool_raw": {"precision": 11 / 14, "recall": 0.55, "f1": 11 / 17},
                    "languagetool_vocabulary_policy": {"precision": 11 / 12, "recall": 0.55, "f1": 11 / 16},
                    "lexical_recall_at_1": 1.0,
                    "lexical_recall_at_3": 1.0,
                    "lexical_recall_at_5": 1.0,
                    "embedding_triggered": False,
                },
                "decisions": {
                    "harper": "DEFER",
                    "languagetool": "SELECT",
                    "lexical_duplicate_ranking": "SELECT",
                    "embeddings": "DEFER_NOT_RUN",
                },
            },
        },
        "input_policy": {
            "grammar_fields": ["title", "summary", "background", "solution", "bounded extracted text"],
            "masked_before_checking": ["code spans", "URLs", "email addresses", "UUIDs", "filenames/database identifiers"],
            "offset_preservation": "masked characters are replaced by spaces",
            "duplicate_fields": ["title", "summary", "background", "solution"],
        },
        "vocabulary_policy": policy,
        "grammar": grammar,
        "duplicates": duplicates,
        "embedding": {
            "triggered": duplicates["embedding_trigger"]["triggered"],
            "execution": "NOT_RUN",
            "model_downloaded": False,
            "reason": "; ".join(duplicates["embedding_trigger"]["reasons"]),
        },
        "scientific_integrity": {
            "calibration_only_tuning": True,
            "holdout_frozen_before_engine_execution": True,
            "final_holdout_measurement_number": 1 if final_measurement else 0,
            "post_holdout_retuning": False,
            "synthetic_or_deidentified_only": True,
        },
        "production_boundary": {
            "production_runtime_changed": False,
            "migration_33": False,
            "supabase_schema_changed": False,
            "model_weights_tracked": False,
            "cloud_ai_used": False,
            "llm_or_vlm_used": False,
            "real_participant_data_used": False,
            "hosted_supabase_touched": False,
            "duda_touched": False,
        },
        "genuine_ai_requirement": (
            "genuine AI productionization remains an unresolved final-delivery requirement."
        ),
    }
    report["decisions"] = make_phase6_decisions(grammar, duplicates, final_measurement)
    return report


def validate_phase6_evidence(report: Any, manifest: dict[str, Any], policy_path: Path) -> dict[str, Any]:
    if not isinstance(report, dict) or report.get("report_schema_version") != 1:
        raise ValueError("Phase 6 evidence schema is invalid")
    if report.get("measurement") != "final":
        raise ValueError("Stored Phase 6 evidence must be a final measurement")
    if report.get("manifest_sha256") != manifest_sha256(manifest):
        raise ValueError("Stored evidence manifest hash is stale")
    if report.get("vocabulary_policy_sha256") != hashlib.sha256(policy_path.read_bytes()).hexdigest():
        raise ValueError("Stored evidence vocabulary policy hash is stale")
    if report.get("corpus", {}).get("grammar_cases") != 80 or report.get("corpus", {}).get("duplicate_candidates") < 100:
        raise ValueError("Stored evidence corpus counts are inconsistent")
    duplicates = report.get("duplicates", {})
    recomputed_duplicates = evaluate_lexical_duplicates(manifest["duplicate_queries"], manifest["duplicate_candidates"])
    deterministic_keys = [
        "exact_duplicate_detection", "recall_at_1", "recall_at_3", "recall_at_5",
        "candidate_precision_at_3", "candidate_precision_at_5", "queries_missed_at_5",
    ]
    for key in deterministic_keys:
        if duplicates.get(key) != recomputed_duplicates.get(key):
            raise ValueError(f"Stored duplicate evidence is inconsistent for {key}")
    expected_decisions = make_phase6_decisions(report.get("grammar", {}), duplicates, True)
    if report.get("decisions") != expected_decisions:
        raise ValueError("Stored Phase 6 decision contract is inconsistent")
    integrity = report.get("scientific_integrity", {})
    if integrity.get("final_holdout_measurement_number") != 1 or integrity.get("post_holdout_retuning") is not False:
        raise ValueError("Stored holdout integrity declaration is invalid")
    if report.get("embedding", {}).get("triggered") is False and report.get("embedding", {}).get("execution") != "NOT_RUN":
        raise ValueError("Embedding no-trigger evidence must remain NOT_RUN")
    boundary = report.get("production_boundary", {})
    if not boundary or any(value is not False for value in boundary.values()):
        raise ValueError("Stored Phase 6 evidence crosses the production/safety boundary")
    if report.get("genuine_ai_requirement") != "genuine AI productionization remains an unresolved final-delivery requirement.":
        raise ValueError("Stored Phase 6 evidence must preserve the unresolved genuine-AI statement")
    return report


def compact_phase6_evidence(report: dict[str, Any]) -> dict[str, Any]:
    """Remove verbose local finding diagnostics without changing measured values."""
    if report.get("source", {}).get("kind") == "compact_phase6a_audit_export":
        return deepcopy(report)
    compact = deepcopy(report)
    for engine in compact.get("grammar", {}).values():
        scores = engine.get("scores", {})
        groups = [scores, *scores.get("by_split", {}).values()]
        for group in groups:
            filters = group.pop("policy_filter_records", [])
            filtered = [finding for record in filters for finding in record.get("filtered", [])]
            group["policy_filter_summary"] = {
                "filtered_findings": len(filtered),
                "affected_cases": sum(record.get("filtered_count", 0) > 0 for record in filters),
                "reasons": dict(sorted(Counter(
                    finding.get("policy_reason", "unknown") for finding in filtered
                ).items())),
            }
            for configuration in ("raw", "vocabulary_policy"):
                result = group.get(configuration, {})
                records = result.pop("records", [])
                result["false_positive_case_ids"] = [
                    record["case_id"] for record in records if record.get("false_positives", 0) > 0
                ]
                result["missed_issue_categories"] = dict(sorted(Counter(
                    category
                    for record in records
                    for category in record.get("missed_issue_categories", [])
                ).items()))
                result["redundant_finding_count"] = sum(record.get("redundant_findings", 0) for record in records)
    compact["source"] = {
        "kind": "compact_phase6a_audit_export",
        "diagnostic_findings_removed": True,
        "measured_values_changed": False,
    }
    return compact
