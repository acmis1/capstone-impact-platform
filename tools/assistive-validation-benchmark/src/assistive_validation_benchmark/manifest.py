from __future__ import annotations

import json
from pathlib import Path
from typing import Any

SUPPORTED_DOCUMENT_TYPES = {
    "born_digital_pdf",
    "scanned_pdf",
    "png",
    "jpeg",
    "corrupt_pdf",
    "unsupported",
}
SUPPORTED_KINDS = {"document", "grammar", "duplicate"}
SUPPORTED_SPLITS = {"calibration", "holdout"}
MAX_CASES = 100
MAX_TEXT_CHARS = 25_000


class ManifestError(ValueError):
    """Raised when a corpus manifest violates the bounded benchmark contract."""


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ManifestError(message)


def _bounded_text(value: Any, field: str, *, allow_empty: bool = True) -> str:
    _require(isinstance(value, str), f"{field} must be a string")
    _require(allow_empty or bool(value.strip()), f"{field} must not be empty")
    _require(len(value) <= MAX_TEXT_CHARS, f"{field} exceeds {MAX_TEXT_CHARS} characters")
    return value


def _validate_asset(asset: Any, case_id: str) -> None:
    text = _bounded_text(asset, f"{case_id}.asset", allow_empty=False)
    path = Path(text)
    _require(path.name == text, f"{case_id}.asset must be a plain filename")
    _require(not path.is_absolute(), f"{case_id}.asset must be relative")
    _require(".." not in path.parts, f"{case_id}.asset contains traversal")


def _validate_document(case: dict[str, Any], case_id: str) -> None:
    _validate_asset(case.get("asset"), case_id)
    _require(case.get("document_type") in SUPPORTED_DOCUMENT_TYPES, f"{case_id}.document_type is unsupported")
    _bounded_text(case.get("metadata_title"), f"{case_id}.metadata_title", allow_empty=False)
    _bounded_text(case.get("poster_title"), f"{case_id}.poster_title")
    _bounded_text(case.get("body"), f"{case_id}.body")
    _require(isinstance(case.get("expected_title_match"), bool), f"{case_id}.expected_title_match must be boolean")
    repeat_body = case.get("repeat_body", 1)
    _require(isinstance(repeat_body, int) and 1 <= repeat_body <= 200, f"{case_id}.repeat_body must be 1..200")
    aliases = case.get("approved_aliases", [])
    _require(isinstance(aliases, list) and len(aliases) <= 10, f"{case_id}.approved_aliases must be a short list")
    for index, alias in enumerate(aliases):
        _bounded_text(alias, f"{case_id}.approved_aliases[{index}]", allow_empty=False)


def _validate_grammar(case: dict[str, Any], case_id: str) -> None:
    text = _bounded_text(case.get("text"), f"{case_id}.text", allow_empty=False)
    issues = case.get("expected_issues")
    _require(isinstance(issues, list) and len(issues) <= 20, f"{case_id}.expected_issues must be a short list")
    cursor = 0
    for index, issue in enumerate(issues):
        _require(isinstance(issue, dict), f"{case_id}.expected_issues[{index}] must be an object")
        needle = _bounded_text(issue.get("text"), f"{case_id}.expected_issues[{index}].text", allow_empty=False)
        _require(issue.get("type") in {"grammar", "spelling"}, f"{case_id}.expected_issues[{index}].type is invalid")
        position = text.find(needle, cursor)
        _require(position >= 0, f"{case_id} expected issue text {needle!r} is absent or ambiguous")
        cursor = position + len(needle)


def _validate_duplicate(case: dict[str, Any], case_id: str) -> None:
    _bounded_text(case.get("query_title"), f"{case_id}.query_title", allow_empty=False)
    _bounded_text(case.get("query_text"), f"{case_id}.query_text", allow_empty=False)
    candidates = case.get("candidates")
    _require(isinstance(candidates, list) and 3 <= len(candidates) <= 20, f"{case_id}.candidates must contain 3..20 entries")
    candidate_ids: set[str] = set()
    relevant_count = 0
    for index, candidate in enumerate(candidates):
        _require(isinstance(candidate, dict), f"{case_id}.candidates[{index}] must be an object")
        candidate_id = _bounded_text(candidate.get("id"), f"{case_id}.candidates[{index}].id", allow_empty=False)
        _require(candidate_id not in candidate_ids, f"{case_id} has duplicate candidate id {candidate_id}")
        candidate_ids.add(candidate_id)
        _bounded_text(candidate.get("title"), f"{case_id}.{candidate_id}.title", allow_empty=False)
        _bounded_text(candidate.get("text"), f"{case_id}.{candidate_id}.text", allow_empty=False)
        _require(isinstance(candidate.get("relevant"), bool), f"{case_id}.{candidate_id}.relevant must be boolean")
        relevant_count += int(candidate["relevant"])
    _require(relevant_count >= 1, f"{case_id} needs at least one relevant candidate")


def validate_manifest(data: Any) -> dict[str, Any]:
    _require(isinstance(data, dict), "manifest root must be an object")
    _require(data.get("schema_version") == 1, "schema_version must be 1")
    _bounded_text(data.get("corpus_version"), "corpus_version", allow_empty=False)
    _require(isinstance(data.get("seed"), int), "seed must be an integer")
    cases = data.get("cases")
    _require(isinstance(cases, list) and 1 <= len(cases) <= MAX_CASES, f"cases must contain 1..{MAX_CASES} entries")
    seen: set[str] = set()
    for index, case in enumerate(cases):
        _require(isinstance(case, dict), f"cases[{index}] must be an object")
        case_id = _bounded_text(case.get("id"), f"cases[{index}].id", allow_empty=False)
        _require(case_id not in seen, f"duplicate case id {case_id}")
        _require(case_id.replace("-", "").isalnum(), f"{case_id} contains unsafe characters")
        seen.add(case_id)
        kind = case.get("kind")
        _require(kind in SUPPORTED_KINDS, f"{case_id}.kind is unsupported")
        _require(case.get("split") in SUPPORTED_SPLITS, f"{case_id}.split is unsupported")
        tags = case.get("tags", [])
        _require(isinstance(tags, list) and len(tags) <= 20 and all(isinstance(tag, str) for tag in tags), f"{case_id}.tags is invalid")
        if kind == "document":
            _validate_document(case, case_id)
        elif kind == "grammar":
            _validate_grammar(case, case_id)
        else:
            _validate_duplicate(case, case_id)
    return data


def load_manifest(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ManifestError(f"could not read manifest: {error}") from error
    return validate_manifest(data)


def cases_of_kind(manifest: dict[str, Any], kind: str) -> list[dict[str, Any]]:
    return [case for case in manifest["cases"] if case["kind"] == kind]
