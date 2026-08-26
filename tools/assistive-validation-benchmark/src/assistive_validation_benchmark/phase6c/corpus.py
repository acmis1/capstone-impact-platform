from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ..phase6.corpus import load_phase6_manifest, manifest_sha256

CALIBRATION_SCHEMA_VERSION = 1
HOLDOUT_SCHEMA_VERSION = 1
CALIBRATION_CORPUS_VERSION = "pp1-assistive-phase6c-calibration-v1"
HOLDOUT_CORPUS_VERSION = "pp1-assistive-phase6c-holdout-v1"
FIELDS = {"title", "summary", "background", "solution"}
REQUIRED_ERROR_CATEGORIES = {
    "SPELLING_ORDINARY",
    "SPELLING_REPEATED_CHARACTER",
    "SPELLING_DROPPED_CHARACTER",
    "SPELLING_REAL_WORD",
    "SPELLING_TECHNICAL_NEAR_MISS",
    "GRAMMAR_SUBJECT_VERB_AGREEMENT",
    "GRAMMAR_SINGULAR_PLURAL",
    "GRAMMAR_ARTICLE",
    "GRAMMAR_PRONOUN_AGREEMENT",
    "GRAMMAR_VERB_FORM",
    "GRAMMAR_SENTENCE_FRAGMENT",
    "GRAMMAR_DUPLICATED_WORD",
    "GRAMMAR_CAPITALIZATION",
    "GRAMMAR_POSSESSIVE",
    "PUNCTUATION_INTRODUCTORY_COMMA",
    "PUNCTUATION_COMMA_SPLICE",
}
_CASE_KEYS = {
    "id",
    "split",
    "field",
    "source_text",
    "intentionally_clean",
    "legitimate_technical_terms",
    "issues",
}
_ISSUE_KEYS = {"start", "end", "source", "category", "accepted_corrections"}


def _issue_case(
    case_id: str,
    field: str,
    text: str,
    needle: str,
    category: str,
    corrections: list[str],
    *,
    legitimate_terms: list[str] | None = None,
) -> dict[str, Any]:
    start = text.find(needle)
    if start < 0 or text.find(needle, start + 1) >= 0:
        raise ValueError(f"{case_id} issue span must occur exactly once")
    return {
        "id": case_id,
        "split": "calibration",
        "field": field,
        "source_text": text,
        "intentionally_clean": False,
        "legitimate_technical_terms": legitimate_terms or [],
        "issues": [{
            "start": start,
            "end": start + len(needle),
            "source": needle,
            "category": category,
            "accepted_corrections": corrections,
        }],
    }


def _clean_case(
    case_id: str,
    field: str,
    text: str,
    legitimate_terms: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "id": case_id,
        "split": "calibration",
        "field": field,
        "source_text": text,
        "intentionally_clean": True,
        "legitimate_technical_terms": legitimate_terms or [],
        "issues": [],
    }


def _new_calibration_cases() -> list[dict[str, Any]]:
    errors = [
        _issue_case("g6c-c001", "title", "Assistive Valdiation Dashboard", "Valdiation", "SPELLING_ORDINARY", ["Validation"]),
        _issue_case("g6c-c002", "summary", "The detecctor records one bounded event.", "detecctor", "SPELLING_REPEATED_CHARACTER", ["detector"]),
        _issue_case("g6c-c003", "background", "The calbration note explains the selected threshold.", "calbration", "SPELLING_DROPPED_CHARACTER", ["calibration"]),
        _issue_case("g6c-c004", "solution", "The worker validates the record than stores the checksum.", "than", "SPELLING_REAL_WORD", ["then"]),
        _issue_case("g6c-c005", "summary", "The Supabse adapter keeps project metadata local.", "Supabse", "SPELLING_TECHNICAL_NEAR_MISS", ["Supabase"]),
        _issue_case("g6c-c006", "summary", "The reviewer inspect every assistive finding.", "inspect", "GRAMMAR_SUBJECT_VERB_AGREEMENT", ["inspects"]),
        _issue_case("g6c-c007", "background", "The validation findings contains no private data.", "contains", "GRAMMAR_SUBJECT_VERB_AGREEMENT", ["contain"]),
        _issue_case("g6c-c008", "solution", "Four project share the synthetic fixture.", "project", "GRAMMAR_SINGULAR_PLURAL", ["projects"]),
        _issue_case("g6c-c009", "summary", "The reviewer opened an bounded report.", "an", "GRAMMAR_ARTICLE", ["a"]),
        _issue_case("g6c-c010", "background", "The database stores their checksum beside the record.", "their", "GRAMMAR_PRONOUN_AGREEMENT", ["its"]),
        _issue_case("g6c-c011", "solution", "The coordinator has chose the local candidate.", "chose", "GRAMMAR_VERB_FORM", ["chosen"]),
        _issue_case("g6c-c012", "summary", "The report lists each each excluded rule.", "each each", "GRAMMAR_DUPLICATED_WORD", ["each"]),
        _issue_case("g6c-c013", "background", "The reviewers note identifies the false positive.", "reviewers", "GRAMMAR_POSSESSIVE", ["reviewer's"]),
        _issue_case("g6c-c014", "solution", "each decision remains subject to staff review.", "each", "GRAMMAR_CAPITALIZATION", ["Each"]),
        _issue_case("g6c-c015", "background", "Before the final run the policy hash is verified.", "Before the final run", "PUNCTUATION_INTRODUCTORY_COMMA", ["Before the final run,"]),
        _issue_case("g6c-c016", "solution", "The local check failed, the operator reviewed the evidence.", "failed, the", "PUNCTUATION_COMMA_SPLICE", ["failed, and the", "failed; the", "failed. The"]),
        _issue_case("g6c-c017", "summary", "Because the policy bundle changed after calibration.", "Because the policy bundle changed after calibration.", "GRAMMAR_SENTENCE_FRAGMENT", ["The policy bundle changed after calibration.", "Because the policy bundle changed after calibration, the run was refused."]),
        _issue_case("g6c-c018", "solution", "The worker did not returned a grammar decision.", "returned", "GRAMMAR_VERB_FORM", ["return"]),
        _issue_case("g6c-c019", "background", "Neither engine report an authoritative verdict.", "report", "GRAMMAR_SUBJECT_VERB_AGREEMENT", ["reports"]),
        _issue_case("g6c-c020", "summary", "Two reviewer independently label each synthetic issue.", "reviewer", "GRAMMAR_SINGULAR_PLURAL", ["reviewers"]),
    ]
    clean = [
        _clean_case("g6c-c021", "summary", "The Supabase adapter serialises approved records as JSON.", ["Supabase", "JSON"]),
        _clean_case("g6c-c022", "background", "PostgREST exposes an OpenAPI document to the bounded readiness check.", ["PostgREST", "OpenAPI"]),
        _clean_case("g6c-c023", "solution", "Vitest exercises the TypeScript parser before the Next.js build.", ["Vitest", "TypeScript", "Next.js"]),
        _clean_case("g6c-c024", "summary", "The Node.js worker accepts one UUID from a local JSON payload.", ["Node.js", "UUID", "JSON"]),
        _clean_case("g6c-c025", "background", "The PKCE callback uses a local API route during verification.", ["PKCE", "API"]),
        _clean_case("g6c-c026", "title", "Admin CMS Review Workspace"),
        _clean_case("g6c-c027", "solution", "The final decision was recorded after each metric was recomputed."),
        _clean_case("g6c-c028", "title", "Project Evidence Review"),
        _clean_case("g6c-c029", "summary", "The organisation standardises colour-coded labels for local review."),
        _clean_case("g6c-c030", "solution", "Run `npm run test:benchmark` before preserving the evidence.", ["npm"]),
        _clean_case("g6c-c031", "background", "Read https://example.invalid/policy or contact audit@example.invalid."),
        _clean_case("g6c-c032", "summary", "Trace 6f9619ff-8b86-4d11-842d-00cf4fc964ff is stored in report.final.json."),
        _clean_case("g6c-c033", "solution", "The identifier `assistive_validation_findings` remains inert."),
        _clean_case("g6c-c034", "background", "PostgreSQL retains the synthetic benchmark record locally.", ["PostgreSQL"]),
        _clean_case("g6c-c035", "summary", "The PDF text may require OCR before language checking.", ["PDF", "OCR"]),
        _clean_case("g6c-c036", "solution", "A reviewer can dismiss the suggestion, and the workflow remains unchanged."),
        _clean_case("g6c-c037", "background", "The policy is narrow; nevertheless, it covers grammar and spelling."),
        _clean_case("g6c-c038", "summary", "The evidence records three values: precision, recall, and F1."),
        _clean_case("g6c-c039", "solution", "An hourly summary is generated after the bounded local run."),
        _clean_case("g6c-c040", "background", "Neither reviewer has opened the final synthetic report."),
    ]
    return sorted(errors + clean, key=lambda case: case["id"])


def _validate_case(case: Any, expected_split: str) -> dict[str, Any]:
    if not isinstance(case, dict) or set(case) != _CASE_KEYS:
        raise ValueError("Phase 6C case schema is closed")
    case_id = case.get("id")
    text = case.get("source_text")
    if not isinstance(case_id, str) or not case_id or not case_id.replace("-", "").isalnum():
        raise ValueError("Phase 6C case IDs must be bounded strings")
    if case.get("split") != expected_split or case.get("field") not in FIELDS:
        raise ValueError(f"{case_id} split or field is invalid")
    if not isinstance(text, str) or not text or len(text) > 1000:
        raise ValueError(f"{case_id} source text must be non-empty and bounded")
    terms = case.get("legitimate_technical_terms")
    if not isinstance(terms, list) or not all(isinstance(term, str) and term and term in text for term in terms):
        raise ValueError(f"{case_id} legitimate terms must occur literally in source text")
    issues = case.get("issues")
    if not isinstance(issues, list) or bool(issues) == bool(case.get("intentionally_clean")):
        raise ValueError(f"{case_id} clean/error declaration is inconsistent")
    for issue in issues:
        if not isinstance(issue, dict) or set(issue) != _ISSUE_KEYS:
            raise ValueError(f"{case_id} issue schema is closed")
        start, end = issue.get("start"), issue.get("end")
        if not isinstance(start, int) or not isinstance(end, int) or not 0 <= start < end <= len(text):
            raise ValueError(f"{case_id} issue span is invalid")
        if text[start:end] != issue.get("source") or issue.get("category") not in REQUIRED_ERROR_CATEGORIES:
            raise ValueError(f"{case_id} issue source or category is invalid")
        corrections = issue.get("accepted_corrections")
        if not isinstance(corrections, list) or not corrections or not all(isinstance(item, str) and item for item in corrections):
            raise ValueError(f"{case_id} requires accepted corrections")
    return case


def build_calibration_manifest(tool_root: Path) -> dict[str, Any]:
    base_path = tool_root / "phase6" / "corpus" / "manifest.json"
    base = load_phase6_manifest(base_path)
    return validate_calibration_manifest({
        "schema_version": CALIBRATION_SCHEMA_VERSION,
        "corpus_version": CALIBRATION_CORPUS_VERSION,
        "content_policy": "entirely_synthetic_no_participant_or_production_data",
        "base_calibration": {
            "path": "tools/assistive-validation-benchmark/phase6/corpus/manifest.json",
            "corpus_version": base["corpus_version"],
            "manifest_sha256": manifest_sha256(base),
            "case_count": sum(case["split"] == "calibration" for case in base["grammar_cases"]),
        },
        "cases": _new_calibration_cases(),
    })


def validate_calibration_manifest(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {
        "schema_version", "corpus_version", "content_policy", "base_calibration", "cases"
    }:
        raise ValueError("Phase 6C calibration manifest schema is closed")
    if value.get("schema_version") != CALIBRATION_SCHEMA_VERSION or value.get("corpus_version") != CALIBRATION_CORPUS_VERSION:
        raise ValueError("Phase 6C calibration identity is invalid")
    if value.get("content_policy") != "entirely_synthetic_no_participant_or_production_data":
        raise ValueError("Phase 6C calibration must remain synthetic")
    base = value.get("base_calibration")
    if not isinstance(base, dict) or set(base) != {"path", "corpus_version", "manifest_sha256", "case_count"}:
        raise ValueError("Phase 6C base calibration binding is invalid")
    cases = value.get("cases")
    if not isinstance(cases, list) or len(cases) != 40:
        raise ValueError("Phase 6C adds exactly 40 calibration cases")
    for case in cases:
        _validate_case(case, "calibration")
    ids = [case["id"] for case in cases]
    if len(ids) != len(set(ids)) or sum(case["intentionally_clean"] for case in cases) != 20:
        raise ValueError("Phase 6C calibration needs unique IDs and 20 clean cases")
    categories = {issue["category"] for case in cases for issue in case["issues"]}
    if categories != REQUIRED_ERROR_CATEGORIES:
        raise ValueError("Phase 6C calibration must cover every required error category")
    return value


def load_calibration_manifest(path: Path) -> dict[str, Any]:
    return validate_calibration_manifest(json.loads(path.read_text(encoding="utf-8")))


def combined_calibration_cases(tool_root: Path, calibration: dict[str, Any]) -> list[dict[str, Any]]:
    base_path = tool_root.parents[1] / calibration["base_calibration"]["path"]
    base = load_phase6_manifest(base_path)
    expected = calibration["base_calibration"]
    actual = {
        "path": expected["path"],
        "corpus_version": base["corpus_version"],
        "manifest_sha256": manifest_sha256(base),
        "case_count": sum(case["split"] == "calibration" for case in base["grammar_cases"]),
    }
    if actual != expected:
        raise ValueError("Phase 6A calibration binding changed after Phase 6C calibration was authored")
    cases = [case for case in base["grammar_cases"] if case["split"] == "calibration"] + calibration["cases"]
    ids = [case["id"] for case in cases]
    if len(ids) != len(set(ids)) or len(cases) != 80:
        raise ValueError("Combined Phase 6C calibration must contain 80 unique cases")
    return cases


def validate_holdout_manifest(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {
        "schema_version", "corpus_version", "content_policy", "cases"
    }:
        raise ValueError("Phase 6C holdout manifest schema is closed")
    if value.get("schema_version") != HOLDOUT_SCHEMA_VERSION or value.get("corpus_version") != HOLDOUT_CORPUS_VERSION:
        raise ValueError("Phase 6C holdout identity is invalid")
    if value.get("content_policy") != "entirely_synthetic_no_participant_or_production_data":
        raise ValueError("Phase 6C holdout must remain synthetic")
    cases = value.get("cases")
    if not isinstance(cases, list) or len(cases) != 40:
        raise ValueError("Phase 6C holdout must contain exactly 40 cases")
    for case in cases:
        _validate_case(case, "holdout")
    ids = [case["id"] for case in cases]
    if len(ids) != len(set(ids)) or sum(case["intentionally_clean"] for case in cases) != 20:
        raise ValueError("Phase 6C holdout needs unique IDs and 20 clean cases")
    categories = {issue["category"] for case in cases for issue in case["issues"]}
    if categories != REQUIRED_ERROR_CATEGORIES:
        raise ValueError("Phase 6C holdout must cover every required error category")
    return value


def load_holdout_manifest(path: Path) -> dict[str, Any]:
    return validate_holdout_manifest(json.loads(path.read_text(encoding="utf-8")))
