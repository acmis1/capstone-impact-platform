from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ..phase6.metrics import METRIC_TOLERANCE, check_metric_group, recompute_metrics
from .corpus import REQUIRED_ERROR_CATEGORIES
from .evaluation import FINDING_KEYS
from .freeze import load_freeze_manifest, verify_freeze_commit
from .history import check_calibration_non_reuse, check_fresh_holdout_non_reuse
from .policy import EXPECTED_ENGINES, validate_policy, value_sha256
from .runner import EVIDENCE_SCHEMA_VERSION, PRODUCTION_BOUNDARY, derive_decisions

_BASE_KEYS = {
    "evidence_schema_version",
    "evidence_schema",
    "benchmark",
    "measurement",
    "completed_at",
    "policy_id",
    "policy_sha256",
    "policy_summary",
    "corpus",
    "runtime",
    "candidate_artifacts",
    "engines",
    "production_boundary",
    "scientific_integrity",
}
_FINAL_EXTRA_KEYS = {"protocol_freeze", "holdout_non_reuse", "decisions"}
_CALIBRATION_EXTRA_KEYS = {"calibration_non_reuse"}
_ENGINE_KEYS = {
    "engine",
    "status",
    "version",
    "dependency_source",
    "license",
    "backend",
    "configuration",
    "cold_start_ms",
    "process_runtime_ms",
    "latency_p50_ms",
    "latency_p95_ms",
    "peak_memory_bytes",
    "excluded_non_prose_finding_count",
    "evaluation",
}
_EVALUATION_KEYS = {"raw", "policy", "breakdowns", "policy_filter_summary", "rule_observations"}
_METRIC_KEYS = {
    "issue_count",
    "true_positives",
    "false_positives",
    "missed_issues",
    "precision",
    "recall",
    "f1",
    "false_positive_rate",
    "vocabulary_false_positives",
    "non_vocabulary_false_positives",
    "clean_case_count",
    "clean_cases_fully_silent",
    "clean_case_silence_rate",
    "records",
}
_RECORD_KEYS = {
    "case_id",
    "split",
    "intentionally_clean",
    "true_positives",
    "false_positives",
    "missed_issues",
    "vocabulary_false_positives",
    "false_positive_findings",
    "missed_issue_categories",
    "redundant_findings",
}
_OBSERVATION_KEYS = {"dimension", "id", "true_positives", "false_positives", "redundant_findings"}
_CATEGORY_METRIC_KEYS = {"category", "issue_count", "true_positives", "missed_issues", "recall"}


def _require_exact_keys(value: Any, expected: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != expected:
        actual = sorted(value) if isinstance(value, dict) else type(value).__name__
        raise ValueError(f"{label} evidence schema is closed; got keys {actual}")
    return value


def _float_equal(left: float, right: float) -> bool:
    return abs(float(left) - float(right)) <= METRIC_TOLERANCE


def _validate_metric_group(label: str, value: Any, cases: list[dict[str, Any]]) -> dict[str, Any]:
    group = _require_exact_keys(value, _METRIC_KEYS, label)
    check_metric_group(label, group)
    records = group["records"]
    if not isinstance(records, list) or [record.get("case_id") for record in records] != [case["id"] for case in cases]:
        raise ValueError(f"{label} records do not bind every corpus case in order")
    for record, case in zip(records, cases, strict=True):
        _require_exact_keys(record, _RECORD_KEYS, f"{label}/{case['id']}")
        if record["split"] != case["split"] or record["intentionally_clean"] is not case["intentionally_clean"]:
            raise ValueError(f"{label}/{case['id']} case identity changed")
        for count_key in (
            "true_positives", "false_positives", "missed_issues", "vocabulary_false_positives", "redundant_findings"
        ):
            if not isinstance(record[count_key], int) or record[count_key] < 0:
                raise ValueError(f"{label}/{case['id']} has an invalid {count_key}")
        findings = record["false_positive_findings"]
        if not isinstance(findings, list) or len(findings) != record["false_positives"]:
            raise ValueError(f"{label}/{case['id']} false-positive detail count is inconsistent")
        for finding in findings:
            _require_exact_keys(finding, FINDING_KEYS, f"{label}/{case['id']}/finding")
        missed = record["missed_issue_categories"]
        if not isinstance(missed, list) or len(missed) != record["missed_issues"]:
            raise ValueError(f"{label}/{case['id']} missed-category count is inconsistent")
        if any(category not in REQUIRED_ERROR_CATEGORIES for category in missed):
            raise ValueError(f"{label}/{case['id']} contains an unknown missed category")

    tp = sum(record["true_positives"] for record in records)
    fp = sum(record["false_positives"] for record in records)
    fn = sum(record["missed_issues"] for record in records)
    vocabulary_fp = sum(record["vocabulary_false_positives"] for record in records)
    clean = [record for record in records if record["intentionally_clean"]]
    expected = recompute_metrics(tp, fp, fn)
    checks = {
        "issue_count": tp + fn,
        "true_positives": tp,
        "false_positives": fp,
        "missed_issues": fn,
        "vocabulary_false_positives": vocabulary_fp,
        "non_vocabulary_false_positives": fp - vocabulary_fp,
        "clean_case_count": len(clean),
        "clean_cases_fully_silent": sum(record["false_positives"] == 0 for record in clean),
    }
    for key, expected_value in checks.items():
        if group[key] != expected_value:
            raise ValueError(f"{label} stored {key} disagrees with per-case records")
    predicted = tp + fp
    expected_fp_rate = fp / predicted if predicted else 0.0
    expected_silence = checks["clean_cases_fully_silent"] / len(clean) if clean else 0.0
    for key, expected_value in {
        **expected,
        "false_positive_rate": expected_fp_rate,
        "clean_case_silence_rate": expected_silence,
    }.items():
        if not _float_equal(group[key], expected_value):
            raise ValueError(f"{label} stored {key} disagrees with recomputed records")
    return group


def _validate_engine(name: str, value: Any, cases: list[dict[str, Any]], policy: dict[str, Any]) -> dict[str, Any]:
    engine = _require_exact_keys(value, _ENGINE_KEYS, f"{name} engine")
    expected = policy["engines"][name]
    if engine["engine"] != name or engine["status"] != "ok" or engine["version"] != expected["version"]:
        raise ValueError(f"Stored evidence requires executed frozen {name} {expected['version']}")
    if engine["configuration"] != expected["configuration"]:
        raise ValueError(f"Stored {name} candidate configuration differs from the freeze")
    for key in ("cold_start_ms", "latency_p50_ms", "latency_p95_ms"):
        if not isinstance(engine[key], (int, float)) or engine[key] < 0:
            raise ValueError(f"Stored {name} {key} is invalid")
    evaluation = _require_exact_keys(engine["evaluation"], _EVALUATION_KEYS, f"{name} evaluation")
    _validate_metric_group(f"{name}/raw", evaluation["raw"], cases)
    policy_metrics = _validate_metric_group(f"{name}/policy", evaluation["policy"], cases)
    breakdowns = _require_exact_keys(
        evaluation["breakdowns"], {"partitions", "fields", "truth_categories"}, f"{name} breakdowns"
    )
    for dimension in ("partitions", "fields"):
        groups = breakdowns[dimension]
        case_key = "partition" if dimension == "partitions" else "field"
        expected_names = sorted({case[case_key] for case in cases})
        if not isinstance(groups, dict) or sorted(groups) != expected_names:
            raise ValueError(f"Stored {name} {dimension} do not cover the corpus exactly")
        for group_name in expected_names:
            group_cases = [case for case in cases if case[case_key] == group_name]
            _validate_metric_group(f"{name}/{dimension}/{group_name}", groups[group_name], group_cases)
    categories = breakdowns["truth_categories"]
    expected_issue_counts: dict[str, int] = {}
    for case in cases:
        for issue in case["issues"]:
            category = issue["category"]
            expected_issue_counts[category] = expected_issue_counts.get(category, 0) + 1
    missed_counts: dict[str, int] = {}
    for record in policy_metrics["records"]:
        for category in record["missed_issue_categories"]:
            missed_counts[category] = missed_counts.get(category, 0) + 1
    if not isinstance(categories, list) or [item.get("category") for item in categories] != sorted(expected_issue_counts):
        raise ValueError(f"Stored {name} truth categories do not cover the corpus exactly")
    for item in categories:
        _require_exact_keys(item, _CATEGORY_METRIC_KEYS, f"{name}/{item.get('category')}")
        category = item["category"]
        issue_count = expected_issue_counts[category]
        missed = missed_counts.get(category, 0)
        expected = {
            "category": category,
            "issue_count": issue_count,
            "true_positives": issue_count - missed,
            "missed_issues": missed,
            "recall": (issue_count - missed) / issue_count,
        }
        if item != expected:
            raise ValueError(f"Stored {name}/{category} truth metrics disagree with corpus records")
    summary = _require_exact_keys(
        evaluation["policy_filter_summary"], {"filtered_findings", "affected_cases", "reasons"}, f"{name} filter summary"
    )
    if not isinstance(summary["reasons"], dict) or sum(summary["reasons"].values()) != summary["filtered_findings"]:
        raise ValueError(f"Stored {name} filter summary is inconsistent")
    observations = evaluation["rule_observations"]
    if not isinstance(observations, list):
        raise ValueError(f"Stored {name} rule observations must be a list")
    for observation in observations:
        _require_exact_keys(observation, _OBSERVATION_KEYS, f"{name} rule observation")
        if observation["dimension"] not in {"excluded_kinds", "excluded_rules", "excluded_categories"}:
            raise ValueError(f"Stored {name} rule observation dimension is invalid")
        for key in ("true_positives", "false_positives", "redundant_findings"):
            if not isinstance(observation[key], int) or observation[key] < 0:
                raise ValueError(f"Stored {name} rule observation count is invalid")
    return engine


def _validate_artifacts(value: Any, policy: dict[str, Any]) -> dict[str, Any]:
    artifacts = _require_exact_keys(value, {"harper", "languagetool"}, "candidate artifacts")
    harper = _require_exact_keys(artifacts["harper"], {"package", "version", "package_lock_sha256"}, "Harper artifact")
    if harper["package"] != "harper.js" or harper["version"] != policy["engines"]["harper"]["version"]:
        raise ValueError("Stored Harper artifact identity changed")
    lt = _require_exact_keys(
        artifacts["languagetool"],
        {"archive_name", "archive_sha256", "server_member", "server_jar_sha256"},
        "LanguageTool artifact",
    )
    contract = policy["engines"]["languagetool"]["runtime_contract"]
    for key in ("archive_name", "archive_sha256", "server_member"):
        if lt[key] != contract[key]:
            raise ValueError(f"Stored LanguageTool artifact {key} changed")
    return artifacts


def _validate_corpus_summary(value: Any, cases: list[dict[str, Any]], corpus_version: str) -> dict[str, Any]:
    summary = _require_exact_keys(
        value,
        {"corpus_version", "case_count", "clean_case_count", "error_case_count", "issue_count", "fields", "error_categories"},
        "corpus summary",
    )
    expected = {
        "corpus_version": corpus_version,
        "case_count": len(cases),
        "clean_case_count": sum(case["intentionally_clean"] for case in cases),
        "error_case_count": sum(not case["intentionally_clean"] for case in cases),
        "issue_count": sum(len(case["issues"]) for case in cases),
        "fields": sorted({case["field"] for case in cases}),
        "error_categories": sorted({issue["category"] for case in cases for issue in case["issues"]}),
    }
    if summary != expected:
        raise ValueError("Stored Phase 7 corpus summary is inconsistent")
    return summary


def _validate_common(
    report: Any,
    expected_keys: set[str],
    measurement: str,
    cases: list[dict[str, Any]],
    corpus_version: str,
    policy: dict[str, Any],
    policy_summary: dict[str, Any],
) -> dict[str, Any]:
    value = _require_exact_keys(report, expected_keys, f"Phase 7 {measurement}")
    if value["evidence_schema_version"] != EVIDENCE_SCHEMA_VERSION:
        raise ValueError("Stored Phase 7 evidence version changed")
    if value["evidence_schema"] != "pp1_assistive_final_language_evidence_v1":
        raise ValueError("Stored Phase 7 evidence identity changed")
    if value["measurement"] != measurement or value["policy_id"] != policy["policy_id"]:
        raise ValueError("Stored Phase 7 measurement or policy identity changed")
    if value["policy_sha256"] != value_sha256(policy) or value["policy_summary"] != policy_summary:
        raise ValueError("Stored Phase 7 policy hash or provenance summary is stale")
    if not isinstance(value["completed_at"], str) or not value["completed_at"]:
        raise ValueError("Stored Phase 7 completion time is missing")
    _validate_corpus_summary(value["corpus"], cases, corpus_version)
    runtime = _require_exact_keys(value["runtime"], {"python", "node", "java", "platform", "cpu_only"}, "runtime")
    if any(not runtime.get(key) for key in ("python", "node", "java", "platform")) or runtime["cpu_only"] is not True:
        raise ValueError("Stored Phase 7 runtime identity is incomplete")
    _validate_artifacts(value["candidate_artifacts"], policy)
    engines = _require_exact_keys(value["engines"], {"harper", "languagetool"}, "engines")
    for name in ("harper", "languagetool"):
        _validate_engine(name, engines[name], cases, policy)
    if value["production_boundary"] != PRODUCTION_BOUNDARY:
        raise ValueError("Stored Phase 7 evidence crosses the production boundary")
    return value


def _validate_exclusion_basis(report: dict[str, Any], policy: dict[str, Any]) -> None:
    for engine_name, filters in policy["finding_policy"].items():
        observations = {
            (item["dimension"], item["id"]): item
            for item in report["engines"][engine_name]["evaluation"]["rule_observations"]
        }
        for dimension, decisions in filters.items():
            for decision in decisions:
                observed = observations.get((dimension, decision["id"]))
                if observed is None:
                    raise ValueError(f"Frozen {engine_name} exclusion {decision['id']} has no calibration observation")
                if observed["false_positives"] != decision["observed_false_positives"]:
                    raise ValueError(f"Frozen {engine_name} exclusion {decision['id']} false-positive evidence changed")
                if observed["true_positives"] != decision["observed_true_positives"]:
                    raise ValueError(f"Frozen {engine_name} exclusion {decision['id']} truth coverage evidence changed")


def validate_calibration_evidence(
    report: Any,
    cases: list[dict[str, Any]],
    corpus_version: str,
    policy: dict[str, Any],
    repository_root: Path,
) -> dict[str, Any]:
    policy_summary = validate_policy(policy, cases, repository_root)
    value = _validate_common(
        report, _BASE_KEYS | _CALIBRATION_EXTRA_KEYS, "calibration", cases, corpus_version, policy, policy_summary
    )
    expected_non_reuse = check_calibration_non_reuse(repository_root / "tools" / "assistive-validation-benchmark", cases)
    if value["calibration_non_reuse"] != expected_non_reuse:
        raise ValueError("Stored Phase 7 calibration non-reuse evidence is inconsistent")
    if value["scientific_integrity"] != {
        "calibration_only": True,
        "fresh_holdout_exists": False,
        "holdout_informed_policy": False,
        "synthetic_only": True,
    }:
        raise ValueError("Stored Phase 7 calibration integrity declaration changed")
    _validate_exclusion_basis(value, policy)
    gates = policy["calibration_gates"]
    evaluation = value["engines"][gates["candidate"]]["evaluation"]
    overall = evaluation["policy"]
    if overall["precision"] < gates["overall_precision"] or overall["recall"] < gates["overall_recall"]:
        raise ValueError("Selected candidate does not meet the frozen overall calibration margin")
    for partition, metrics in evaluation["breakdowns"]["partitions"].items():
        if metrics["precision"] < gates["partition_precision"] or metrics["recall"] < gates["partition_recall"]:
            raise ValueError(f"Selected candidate does not meet the frozen calibration margin in {partition}")
    return value


def validate_final_evidence(
    report: Any,
    holdout_cases: list[dict[str, Any]],
    holdout_corpus_version: str,
    calibration_cases: list[dict[str, Any]],
    calibration_report: dict[str, Any],
    *,
    tool_root: Path,
    repository_root: Path,
    policy: dict[str, Any],
) -> dict[str, Any]:
    policy_summary = validate_policy(policy, calibration_cases, repository_root)
    validate_calibration_evidence(
        calibration_report,
        calibration_cases,
        calibration_report["corpus"]["corpus_version"],
        policy,
        repository_root,
    )
    value = _validate_common(
        report,
        _BASE_KEYS | _FINAL_EXTRA_KEYS,
        "final",
        holdout_cases,
        holdout_corpus_version,
        policy,
        policy_summary,
    )
    if value["candidate_artifacts"] != calibration_report["candidate_artifacts"]:
        raise ValueError("Candidate artifacts differ between calibration freeze and final measurement")
    for name in ("harper", "languagetool"):
        if value["engines"][name]["configuration"] != calibration_report["engines"][name]["configuration"]:
            raise ValueError(f"{name} configuration differs between calibration freeze and final measurement")
    freeze_manifest = load_freeze_manifest(tool_root / "phase7" / "freeze-manifest.json", tool_root)
    freeze_sha = value["protocol_freeze"].get("policy_freeze_commit_sha")
    expected_freeze = verify_freeze_commit(tool_root, freeze_sha, freeze_manifest)
    if value["protocol_freeze"] != expected_freeze:
        raise ValueError("Stored Phase 7 protocol freeze evidence is inconsistent")
    expected_non_reuse = check_fresh_holdout_non_reuse(tool_root, calibration_cases, holdout_cases)
    if value["holdout_non_reuse"] != expected_non_reuse:
        raise ValueError("Stored Phase 7 holdout non-reuse evidence is inconsistent")
    expected_decisions = derive_decisions(value["engines"], policy)
    if value["decisions"] != expected_decisions:
        raise ValueError("Stored Phase 7 decisions disagree with the frozen selection rule")
    if value["scientific_integrity"] != {
        "calibration_only_policy_development": True,
        "policy_frozen_before_fresh_holdout": True,
        "final_measurement_number": 1,
        "post_holdout_retuning": False,
        "synthetic_only": True,
    }:
        raise ValueError("Stored Phase 7 final integrity declaration changed")
    return value


def load_evidence(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))
