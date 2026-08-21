from __future__ import annotations

from pathlib import Path
from typing import Any

POLICY_SCHEMA_VERSION = 2
ALLOWED_SOURCE_TYPES = ("repository", "calibration", "controlled_pp1")
CALIBRATION_SPLIT = "calibration"
_TERM_FIELDS = {"term", "sourceType", "source"}

# Repository provenance must come from authoritative pre-existing project material, never from
# generated Phase 6 corpus text, generated fixtures, or published benchmark evidence.
_EXCLUDED_REPOSITORY_PREFIXES = (
    "tools/assistive-validation-benchmark/phase6/",
    "tools/assistive-validation-benchmark/corpus/",
    "tools/assistive-validation-benchmark/artifacts/",
    "docs/assistive-validation/evidence/",
    "docs/assistive-validation/phase-6a-language-duplicate-benchmark.md",
)


def _case_index(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Index every manifest case identifier with its declared split and searchable text."""
    index: dict[str, dict[str, Any]] = {}
    for case in manifest["grammar_cases"]:
        index[case["id"]] = {
            "kind": "grammar_case",
            "split": case["split"],
            "texts": [case["source_text"]],
            "declared_terms": list(case.get("legitimate_technical_terms", [])),
        }
    for query in manifest["duplicate_queries"]:
        index[query["id"]] = {
            "kind": "duplicate_query",
            "split": query["split"],
            "texts": [query[field] for field in ("title", "summary", "background", "solution")],
            "declared_terms": [],
        }
    return index


def _check_calibration_term(term: str, source: str, cases: dict[str, dict[str, Any]]) -> None:
    case = cases.get(source)
    if case is None:
        raise ValueError(f"{term} claims calibration source {source}, which is not a corpus case")
    if case["split"] != CALIBRATION_SPLIT:
        raise ValueError(
            f"{term} claims source {source}, but that case is declared {case['split']}; "
            "holdout material may never justify a policy term"
        )
    if not any(term in text for text in case["texts"]):
        raise ValueError(f"{term} does not occur in calibration case {source}")
    if case["kind"] == "grammar_case" and term not in case["declared_terms"]:
        raise ValueError(
            f"{term} is not declared in the legitimate technical terms of calibration case {source}"
        )


def _check_repository_term(term: str, source: str, repository_root: Path) -> None:
    if source.startswith("/") or "\\" in source or ".." in Path(source).parts:
        raise ValueError(f"{term} repository source {source} must be a relative in-tree path")
    normalised = source.replace("\\", "/")
    if any(normalised.startswith(prefix) for prefix in _EXCLUDED_REPOSITORY_PREFIXES):
        raise ValueError(
            f"{term} repository source {source} is generated Phase 6 corpus or evidence material "
            "and cannot establish independent provenance"
        )
    path = repository_root / source
    if not path.is_file():
        raise ValueError(f"{term} repository source {source} does not exist in the repository")
    try:
        content = path.read_text(encoding="utf-8")
    except UnicodeDecodeError as error:
        raise ValueError(f"{term} repository source {source} is not readable UTF-8 text") from error
    if term not in content:
        raise ValueError(f"{term} does not occur in its claimed repository source {source}")


def validate_vocabulary_policy(
    policy: Any, manifest: dict[str, Any], repository_root: Path
) -> dict[str, Any]:
    """Prove every approved term against authoritative, non-holdout provenance."""
    if not isinstance(policy, dict) or policy.get("policy_version") != POLICY_SCHEMA_VERSION:
        raise ValueError("Phase 6 vocabulary policy_version must be 2")
    approved = policy.get("approved_terms")
    if not isinstance(approved, list) or not approved:
        raise ValueError("Phase 6 vocabulary policy requires a non-empty approved_terms list")

    cases = _case_index(manifest)
    counts = {source_type: 0 for source_type in ALLOWED_SOURCE_TYPES}
    seen: set[str] = set()
    for entry in approved:
        if not isinstance(entry, dict) or set(entry) != _TERM_FIELDS:
            raise ValueError(f"Each approved term needs exactly {sorted(_TERM_FIELDS)}; got {entry!r}")
        term, source_type, source = entry["term"], entry["sourceType"], entry["source"]
        if not isinstance(term, str) or not term or term in seen:
            raise ValueError(f"Approved terms must be unique non-empty strings; got {term!r}")
        seen.add(term)
        if source_type not in ALLOWED_SOURCE_TYPES:
            raise ValueError(f"{term} uses unsupported sourceType {source_type!r}")
        if not isinstance(source, str) or not source.strip():
            raise ValueError(f"{term} requires an explicit source")
        # A term may never be justified by holdout material, whatever source type it declares.
        referenced = cases.get(source)
        if referenced is not None and referenced["split"] != CALIBRATION_SPLIT:
            raise ValueError(f"{term} references {referenced['split']} case {source} as provenance")
        if source_type == CALIBRATION_SPLIT:
            _check_calibration_term(term, source, cases)
        elif source_type == "repository":
            _check_repository_term(term, source, repository_root)
        else:
            if referenced is not None:
                raise ValueError(
                    f"{term} declares controlled_pp1 provenance but points at corpus case {source}"
                )
        counts[source_type] += 1
    return {
        "policy_version": POLICY_SCHEMA_VERSION,
        "approved_term_count": len(approved),
        "source_type_counts": counts,
        "holdout_sourced_terms": 0,
    }


def approved_terms(policy: dict[str, Any]) -> set[str]:
    return {entry["term"] for entry in policy["approved_terms"]}
