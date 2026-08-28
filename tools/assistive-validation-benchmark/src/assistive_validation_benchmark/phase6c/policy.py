from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from ..phase6.grammar import _is_spelling, grammar_mask_contract, grammar_matcher_contract

POLICY_SCHEMA_VERSION = 1
PROVENANCE_TYPES = {"REPOSITORY", "CALIBRATION"}
_POLICY_KEYS = {
    "schema_version",
    "policy_id",
    "content_constraints",
    "vocabulary",
    "masking",
    "fields",
    "finding_policy",
    "matcher",
    "scoring",
    "engines",
    "evidence",
}
_VOCABULARY_KEYS = {"matching", "provenance_types", "approved_terms"}
_TERM_KEYS = {"term", "provenance", "source"}
_ENGINE_FILTER_KEYS = {"excluded_kinds", "excluded_rules", "excluded_categories"}
_EXCLUSION_KEYS = {
    "id", "reason", "calibration_case_ids", "observed_false_positives", "observed_true_positives"
}

EXPECTED_CONTENT_CONSTRAINTS = {
    "policy_development_sources": ["trusted_repository_content", "calibration_cases"],
    "forbidden_sources": ["holdout", "production_data", "participant_data", "general_llm"],
    "local_only": True,
    "human_authoritative": True,
}
EXPECTED_FIELDS = {
    "title": "spelling_only",
    "summary": "spelling_grammar_punctuation_capitalisation",
    "background": "spelling_grammar_punctuation_capitalisation",
    "solution": "spelling_grammar_punctuation_capitalisation",
}
EXPECTED_SCORING = {
    "precision_gate": 0.90,
    "recall_gate": 0.40,
    "selection_order": ["precision", "recall", "fewer_false_positives", "lower_p95_latency"],
    "maximum_selected_candidates": 1,
    "clean_case_silence_reported": True,
    "counts_reported": ["true_positives", "false_positives", "missed_issues"],
}
EXPECTED_ENGINES = {
    "harper": {
        "version": "2.7.0",
        "configuration": {"dialect": "Australian", "language": "plaintext"},
        "runtime_contract": {"node_major": 24, "package": "harper.js", "local_only": True},
    },
    "languagetool": {
        "version": "6.6",
        "configuration": {"language": "en-AU", "max_text_length": 25000, "max_check_time_ms": 10000},
        "runtime_contract": {
            "java_minimum_major": 17,
            "loopback_only": True,
            "archive_name": "LanguageTool-stable.zip",
            "archive_sha256": "53600506b399bb5ffe1e4c8dec794fd378212f14aaf38ccef9b6f89314d11631",
            "server_member": "LanguageTool-6.6/languagetool-server.jar",
        },
    },
}
EXPECTED_EVIDENCE = {
    "schema": "pp1_assistive_language_recovery_evidence_v1",
    "unexpected_keys": "reject",
    "metrics_recomputed_from_counts": True,
    "decision_recomputed_from_frozen_rule": True,
    "required_engines": ["harper", "languagetool"],
}
_EXCLUDED_REPOSITORY_PREFIXES = (
    "tools/assistive-validation-benchmark/",
    "docs/assistive-validation/",
    "Prototype/",
)


def canonical_json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n").encode("utf-8")


def value_sha256(value: Any) -> str:
    return hashlib.sha256(canonical_json_bytes(value)).hexdigest()


def load_policy(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _case_index(calibration_cases: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {case["id"]: case for case in calibration_cases}


def _validate_repository_term(term: str, source: str, repository_root: Path) -> None:
    normalised = source.replace("\\", "/")
    if source.startswith(("/", "\\")) or ".." in Path(source).parts:
        raise ValueError(f"{term} repository source must be a relative in-tree path")
    if any(normalised.startswith(prefix) for prefix in _EXCLUDED_REPOSITORY_PREFIXES):
        raise ValueError(f"{term} cannot bootstrap vocabulary from benchmark, evidence, or Prototype material")
    path = repository_root / source
    if not path.is_file():
        raise ValueError(f"{term} repository source {source} does not exist")
    try:
        content = path.read_text(encoding="utf-8")
    except UnicodeDecodeError as error:
        raise ValueError(f"{term} repository source {source} is not UTF-8 text") from error
    if term not in content:
        raise ValueError(f"{term} does not occur literally in repository source {source}")


def _validate_exclusions(
    engine: str,
    filters: Any,
    calibration_index: dict[str, dict[str, Any]],
) -> None:
    if not isinstance(filters, dict) or set(filters) != _ENGINE_FILTER_KEYS:
        raise ValueError(f"{engine} finding policy schema is closed")
    seen: set[tuple[str, str]] = set()
    for dimension in sorted(_ENGINE_FILTER_KEYS):
        entries = filters[dimension]
        if not isinstance(entries, list):
            raise ValueError(f"{engine} {dimension} must be a list")
        for entry in entries:
            if not isinstance(entry, dict) or set(entry) != _EXCLUSION_KEYS:
                raise ValueError(f"{engine} exclusion decision schema is closed")
            identifier = entry.get("id")
            if not isinstance(identifier, str) or not identifier or (dimension, identifier) in seen:
                raise ValueError(f"{engine} exclusions must have unique non-empty IDs")
            seen.add((dimension, identifier))
            if not isinstance(entry.get("reason"), str) or not entry["reason"].strip():
                raise ValueError(f"{engine} exclusion {identifier} needs a calibration-grounded reason")
            case_ids = entry.get("calibration_case_ids")
            if not isinstance(case_ids, list) or not case_ids:
                raise ValueError(f"{engine} exclusion {identifier} needs calibration cases")
            if any(case_id not in calibration_index for case_id in case_ids):
                raise ValueError(f"{engine} exclusion {identifier} references non-calibration material")
            for count_key in ("observed_false_positives", "observed_true_positives"):
                if not isinstance(entry.get(count_key), int) or entry[count_key] < 0:
                    raise ValueError(f"{engine} exclusion {identifier} has an invalid observed count")
            if entry["observed_false_positives"] < 1 or entry["observed_true_positives"] != 0:
                raise ValueError(
                    f"{engine} exclusion {identifier} must remove calibration false positives without suppressing truth"
                )


def validate_policy(
    policy: Any,
    calibration_cases: list[dict[str, Any]],
    repository_root: Path,
) -> dict[str, Any]:
    if not isinstance(policy, dict) or set(policy) != _POLICY_KEYS:
        raise ValueError("Phase 6C policy schema is closed")
    if policy.get("schema_version") != POLICY_SCHEMA_VERSION:
        raise ValueError("Phase 6C policy schema_version must be 1")
    if not isinstance(policy.get("policy_id"), str) or not policy["policy_id"]:
        raise ValueError("Phase 6C policy needs a stable ID")
    if policy.get("content_constraints") != EXPECTED_CONTENT_CONSTRAINTS:
        raise ValueError("Phase 6C calibration-only content constraints changed")
    if policy.get("masking") != grammar_mask_contract():
        raise ValueError("Phase 6C masking policy differs from the executed offset-preserving masker")
    if policy.get("matcher") != grammar_matcher_contract():
        raise ValueError("Phase 6C matcher policy differs from the executed issue matcher")
    if policy.get("fields") != EXPECTED_FIELDS:
        raise ValueError("Phase 6C field policy changed")
    if policy.get("scoring") != EXPECTED_SCORING:
        raise ValueError("Phase 6C scoring and selection contract changed")
    if policy.get("engines") != EXPECTED_ENGINES:
        raise ValueError("Phase 6C engine identity or candidate configuration changed")
    if policy.get("evidence") != EXPECTED_EVIDENCE:
        raise ValueError("Phase 6C evidence contract changed")

    vocabulary = policy.get("vocabulary")
    if not isinstance(vocabulary, dict) or set(vocabulary) != _VOCABULARY_KEYS:
        raise ValueError("Phase 6C vocabulary schema is closed")
    if vocabulary.get("matching") != "case_sensitive_exact_source_span_spelling_findings_only":
        raise ValueError("Phase 6C vocabulary matching contract changed")
    if vocabulary.get("provenance_types") != ["REPOSITORY", "CALIBRATION"]:
        raise ValueError("Phase 6C vocabulary provenance must be exactly REPOSITORY or CALIBRATION")
    approved = vocabulary.get("approved_terms")
    if not isinstance(approved, list) or not approved:
        raise ValueError("Phase 6C vocabulary must be non-empty")
    calibration_index = _case_index(calibration_cases)
    seen: set[str] = set()
    provenance_counts = {name: 0 for name in sorted(PROVENANCE_TYPES)}
    for entry in approved:
        if not isinstance(entry, dict) or set(entry) != _TERM_KEYS:
            raise ValueError("Phase 6C vocabulary term schema is closed")
        term, provenance, source = entry["term"], entry["provenance"], entry["source"]
        if not isinstance(term, str) or not term or term in seen:
            raise ValueError("Phase 6C vocabulary terms must be unique non-empty strings")
        seen.add(term)
        if provenance not in PROVENANCE_TYPES:
            raise ValueError(f"{term} uses forbidden provenance {provenance!r}")
        if not isinstance(source, str) or not source:
            raise ValueError(f"{term} needs an explicit provenance source")
        if source in calibration_index and provenance != "CALIBRATION":
            raise ValueError(f"{term} points at a calibration case but declares {provenance}")
        if provenance == "REPOSITORY":
            _validate_repository_term(term, source, repository_root)
        else:
            case = calibration_index.get(source)
            if case is None or case.get("split") != "calibration":
                raise ValueError(f"{term} calibration provenance does not resolve to calibration")
            if term not in case["source_text"] or term not in case["legitimate_technical_terms"]:
                raise ValueError(f"{term} is not contained and declared in calibration case {source}")
        provenance_counts[provenance] += 1

    finding_policy = policy.get("finding_policy")
    if not isinstance(finding_policy, dict) or set(finding_policy) != {"harper", "languagetool"}:
        raise ValueError("Phase 6C finding policy must cover exactly both candidates")
    for engine, filters in finding_policy.items():
        _validate_exclusions(engine, filters, calibration_index)
    return {
        "policy_id": policy["policy_id"],
        "policy_sha256": value_sha256(policy),
        "approved_term_count": len(approved),
        "provenance_counts": provenance_counts,
        "holdout_sourced_terms": 0,
        "excluded_findings": {
            engine: sum(len(entries) for entries in filters.values())
            for engine, filters in finding_policy.items()
        },
    }


def approved_terms(policy: dict[str, Any]) -> set[str]:
    return {entry["term"] for entry in policy["vocabulary"]["approved_terms"]}


def _exclusion_ids(policy: dict[str, Any], engine: str, dimension: str) -> set[str]:
    return {entry["id"] for entry in policy["finding_policy"][engine][dimension]}


def apply_finding_policy(
    case: dict[str, Any],
    findings: list[dict[str, Any]],
    policy: dict[str, Any],
    engine: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    terms = approved_terms(policy)
    excluded_kinds = _exclusion_ids(policy, engine, "excluded_kinds")
    excluded_rules = _exclusion_ids(policy, engine, "excluded_rules")
    excluded_categories = _exclusion_ids(policy, engine, "excluded_categories")
    retained: list[dict[str, Any]] = []
    filtered: list[dict[str, Any]] = []
    text = case["source_text"]
    for finding in findings:
        token = text[int(finding["start"]):int(finding["end"])]
        reason: str | None = None
        if case["field"] == "title" and not _is_spelling(finding):
            reason = "title_spelling_only"
        elif _is_spelling(finding) and token in terms:
            reason = "approved_exact_term"
        elif str(finding.get("kind", "")) in excluded_kinds:
            reason = f"excluded_kind:{finding.get('kind', '')}"
        elif str(finding.get("rule", "")) in excluded_rules:
            reason = f"excluded_rule:{finding.get('rule', '')}"
        elif str(finding.get("category", "")) in excluded_categories:
            reason = f"excluded_category:{finding.get('category', '')}"
        if reason is None:
            retained.append(finding)
        else:
            filtered.append({**finding, "policy_reason": reason})
    return retained, filtered
