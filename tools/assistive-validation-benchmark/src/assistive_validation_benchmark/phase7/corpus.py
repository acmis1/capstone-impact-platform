from __future__ import annotations

import hashlib
import json
import random
import re
from pathlib import Path
from typing import Any

CALIBRATION_SCHEMA_VERSION = 1
HOLDOUT_SCHEMA_VERSION = 1
CALIBRATION_CORPUS_VERSION = "pp1-assistive-final-language-calibration-v1"
HOLDOUT_CORPUS_VERSION = "pp1-assistive-final-language-holdout-v1"
FIELDS = {"title", "summary", "background", "solution"}
CALIBRATION_PARTITIONS = {"partition-a", "partition-b", "partition-c"}
HOLDOUT_PARTITIONS = {"holdout-a", "holdout-b", "holdout-c"}
REQUIRED_ERROR_CATEGORIES = {
    "SPELLING_SIMPLE", "SPELLING_REPEATED_CHARACTER", "SPELLING_DROPPED_CHARACTER",
    "SPELLING_TRANSPOSITION", "SPELLING_REAL_WORD", "SPELLING_TECHNICAL_NEAR_MISS",
    "GRAMMAR_SUBJECT_VERB_AGREEMENT", "GRAMMAR_SINGULAR_PLURAL", "GRAMMAR_ARTICLE",
    "GRAMMAR_PRONOUN_AGREEMENT", "GRAMMAR_VERB_FORM", "GRAMMAR_SENTENCE_FRAGMENT",
    "GRAMMAR_DUPLICATED_WORD", "GRAMMAR_CAPITALIZATION", "GRAMMAR_POSSESSIVE",
    "PUNCTUATION_INTRODUCTORY_COMMA", "PUNCTUATION_COMMA_SPLICE", "PUNCTUATION_TERMINAL",
}
_CASE_KEYS = {
    "id", "split", "partition", "field", "source_text", "intentionally_clean",
    "legitimate_technical_terms", "issues",
}
_ISSUE_KEYS = {"start", "end", "source", "category", "accepted_corrections"}

IssueSpec = tuple[str, str, list[str]]
CaseSpec = tuple[str, str, list[IssueSpec], list[str]]


def _case(
    case_id: str,
    split: str,
    partition: str,
    field: str,
    text: str,
    issues: list[IssueSpec],
    legitimate_terms: list[str] | None = None,
) -> dict[str, Any]:
    built: list[dict[str, Any]] = []
    for needle, category, corrections in issues:
        start = text.find(needle)
        if start < 0 or text.find(needle, start + 1) >= 0:
            raise ValueError(f"{case_id} issue span {needle!r} must occur exactly once")
        built.append({
            "start": start, "end": start + len(needle), "source": needle,
            "category": category, "accepted_corrections": corrections,
        })
    return {
        "id": case_id, "split": split, "partition": partition, "field": field,
        "source_text": text, "intentionally_clean": not issues,
        "legitimate_technical_terms": legitimate_terms or [], "issues": built,
    }


def _error_specs() -> dict[str, list[CaseSpec]]:
    return {
        "partition-a": [
            ("title", "Community Flood Moniter", [("Moniter", "SPELLING_SIMPLE", ["Monitor"])], []),
            ("summary", "A detecctor logs the bounded flood alert for review.", [("detecctor", "SPELLING_REPEATED_CHARACTER", ["detector"])], []),
            ("background", "The calbration note explains the threshold.", [("calbration", "SPELLING_DROPPED_CHARACTER", ["calibration"])], []),
            ("solution", "The gateway will recieve each signed record.", [("recieve", "SPELLING_TRANSPOSITION", ["receive"])], []),
            ("title", "Supabse Review Console", [("Supabse", "SPELLING_TECHNICAL_NEAR_MISS", ["Supabase"])], []),
            ("summary", "For each queued project, the reviewer inspect every assistive note.", [("inspect", "GRAMMAR_SUBJECT_VERB_AGREEMENT", ["inspects"])], []),
            ("background", "The queued validation findings contains only synthetic measurements.", [("contains", "GRAMMAR_SUBJECT_VERB_AGREEMENT", ["contain"])], []),
            ("solution", "Four project share a deidentified coastal-monitor fixture.", [("project", "GRAMMAR_SINGULAR_PLURAL", ["projects"])], []),
            ("summary", "The worker emits an bounded report.", [("an", "GRAMMAR_ARTICLE", ["a"])], []),
            ("background", "After comparing both reports, the coordinator has chose the offline candidate.", [("chose", "GRAMMAR_VERB_FORM", ["chosen"])], []),
            ("solution", "The audit table lists each each prospectively excluded rule family.", [("each each", "GRAMMAR_DUPLICATED_WORD", ["each"])], []),
            ("summary", "A reviewers note distinguishes the observed false positive from a miss.", [("reviewers", "GRAMMAR_POSSESSIVE", ["reviewer's"])], []),
            ("background", "each recorded decision remains advisory until a staff member reviews it.", [("each", "GRAMMAR_CAPITALIZATION", ["Each"])], []),
            ("solution", "Before the sealed measurement begins the verifier checks the frozen policy hash.", [("Before the sealed measurement begins", "PUNCTUATION_INTRODUCTORY_COMMA", ["Before the sealed measurement begins,"])], []),
            ("summary", "The offline check stopped, the operator preserved its diagnostic evidence.", [("stopped, the", "PUNCTUATION_COMMA_SPLICE", ["stopped, and the", "stopped; the", "stopped. The"])], []),
            ("background", "The worker validates a claimed record than persists its checksum.", [("than", "SPELLING_REAL_WORD", ["then"])], []),
            ("solution", "Each queue stores their checksum beside the record.", [("their", "GRAMMAR_PRONOUN_AGREEMENT", ["its"])], []),
            ("summary", "Because a frozen policy component changed before the sealed run.", [("Because a frozen policy component changed before the sealed run.", "GRAMMAR_SENTENCE_FRAGMENT", ["A frozen policy component changed before the sealed run.", "Because a frozen policy component changed before the sealed run, the verifier refused it."])], []),
            ("background", "The bounded report is ready for staff review", [("review", "PUNCTUATION_TERMINAL", ["review."])], []),
            ("solution", "The detecctor checks each each record.", [("detecctor", "SPELLING_REPEATED_CHARACTER", ["detector"]), ("each each", "GRAMMAR_DUPLICATED_WORD", ["each"])], []),
        ],
        "partition-b": [
            ("title", "Coastal Sensor Dashbord", [("Dashbord", "SPELLING_SIMPLE", ["Dashboard"])], []),
            ("summary", "The proccessor rejects oversized output.", [("proccessor", "SPELLING_REPEATED_CHARACTER", ["processor"])], []),
            ("background", "A deterministic manfest records every case.", [("manfest", "SPELLING_DROPPED_CHARACTER", ["manifest"])], []),
            ("solution", "Staff can udpate the in-browser draft.", [("udpate", "SPELLING_TRANSPOSITION", ["update"])], []),
            ("title", "PostgREST Migraiton Inspector", [("Migraiton", "SPELLING_TECHNICAL_NEAR_MISS", ["Migration"])], ["PostgREST"]),
            ("summary", "The service return one bounded suggestion.", [("return", "GRAMMAR_SUBJECT_VERB_AGREEMENT", ["returns"])], []),
            ("background", "These local adapter preserves source offsets.", [("preserves", "GRAMMAR_SUBJECT_VERB_AGREEMENT", ["preserve"])], []),
            ("solution", "Two reviewer compare the evidence independently.", [("reviewer", "GRAMMAR_SINGULAR_PLURAL", ["reviewers"])], []),
            ("summary", "The report describes a unusual token.", [("a unusual", "GRAMMAR_ARTICLE", ["an", "an unusual"])], []),
            ("background", "The verifier did not accepted malformed output.", [("accepted", "GRAMMAR_VERB_FORM", ["accept"])], []),
            ("solution", "The staff member can can ignore a suggestion.", [("can can", "GRAMMAR_DUPLICATED_WORD", ["can"])], []),
            ("summary", "The projects title remains authoritative.", [("projects", "GRAMMAR_POSSESSIVE", ["project's"])], []),
            ("background", "language findings never approve a project.", [("language", "GRAMMAR_CAPITALIZATION", ["Language"])], []),
            ("solution", "After metadata changes the old run becomes stale.", [("After metadata changes", "PUNCTUATION_INTRODUCTORY_COMMA", ["After metadata changes,"])], []),
            ("summary", "The result is advisory, staff make the final decision.", [("advisory, staff", "PUNCTUATION_COMMA_SPLICE", ["advisory, and staff", "advisory; staff", "advisory. Staff"])], []),
            ("background", "The operator checks whether the run is current then applies the edit.", [("then", "SPELLING_REAL_WORD", ["before"])], []),
            ("solution", "Every project keeps their own input hash.", [("their", "GRAMMAR_PRONOUN_AGREEMENT", ["its"])], []),
            ("summary", "While the local provider remains unavailable.", [("While the local provider remains unavailable.", "GRAMMAR_SENTENCE_FRAGMENT", ["The local provider remains unavailable.", "While the local provider remains unavailable, the run stays degraded."])], []),
            ("background", "The evidence remains bounded and plain text", [("text", "PUNCTUATION_TERMINAL", ["text."])], []),
            ("solution", "The proccessor records the the offset.", [("proccessor", "SPELLING_REPEATED_CHARACTER", ["processor"]), ("the the", "GRAMMAR_DUPLICATED_WORD", ["the"])], []),
        ],
        "partition-c": [
            ("title", "Urban Heat Analtyics", [("Analtyics", "SPELLING_SIMPLE", ["Analytics"])], []),
            ("summary", "The sugggestion is always non-blocking.", [("sugggestion", "SPELLING_REPEATED_CHARACTER", ["suggestion"])], []),
            ("background", "The persitence contract rejects extra keys.", [("persitence", "SPELLING_DROPPED_CHARACTER", ["persistence"])], []),
            ("solution", "The reviewer can sleect one safe replacement.", [("sleect", "SPELLING_TRANSPOSITION", ["select"])], []),
            ("title", "TypeScritp Evidence Viewer", [("TypeScritp", "SPELLING_TECHNICAL_NEAR_MISS", ["TypeScript"])], []),
            ("summary", "One finding identify a single source span.", [("identify", "GRAMMAR_SUBJECT_VERB_AGREEMENT", ["identifies"])], []),
            ("background", "The current rules excludes subjective style advice.", [("excludes", "GRAMMAR_SUBJECT_VERB_AGREEMENT", ["exclude"])], []),
            ("solution", "Three suggestion appear under the affected field.", [("suggestion", "GRAMMAR_SINGULAR_PLURAL", ["suggestions"])], []),
            ("summary", "The worker starts a offline language process.", [("a offline", "GRAMMAR_ARTICLE", ["an", "an offline"])], []),
            ("background", "The subprocess has wrote one bounded response.", [("wrote", "GRAMMAR_VERB_FORM", ["written"])], []),
            ("solution", "No finding may may mutate project metadata.", [("may may", "GRAMMAR_DUPLICATED_WORD", ["may"])], []),
            ("summary", "The providers version is pinned prospectively.", [("providers", "GRAMMAR_POSSESSIVE", ["provider's"])], []),
            ("background", "staff review every proposed correction.", [("staff", "GRAMMAR_CAPITALIZATION", ["Staff"])], []),
            ("solution", "When the claim is lost the child process stops.", [("When the claim is lost", "PUNCTUATION_INTRODUCTORY_COMMA", ["When the claim is lost,"])], []),
            ("summary", "The text is untrusted, the provider treats it as data.", [("untrusted, the", "PUNCTUATION_COMMA_SPLICE", ["untrusted, and the", "untrusted; the", "untrusted. The"])], []),
            ("background", "The worker checks the field form beginning to end.", [("form", "SPELLING_REAL_WORD", ["from"])], []),
            ("solution", "Neither candidate may change their policy after freeze.", [("their", "GRAMMAR_PRONOUN_AGREEMENT", ["its"])], []),
            ("summary", "Although every metric was recomputed exactly.", [("Although every metric was recomputed exactly.", "GRAMMAR_SENTENCE_FRAGMENT", ["Every metric was recomputed exactly.", "Although every metric was recomputed exactly, the evidence was still reviewed."])], []),
            ("background", "The source excerpt maps to the authoritative field", [("field", "PUNCTUATION_TERMINAL", ["field."])], []),
            ("solution", "The sugggestion preserves one one source span.", [("sugggestion", "SPELLING_REPEATED_CHARACTER", ["suggestion"]), ("one one", "GRAMMAR_DUPLICATED_WORD", ["one"])], []),
        ],
    }


def _clean_specs() -> dict[str, list[tuple[str, str, list[str]]]]:
    return {
        "partition-a": [
            ("title", "Civic Water Quality Dashboard", []), ("title", "RabbitMQ Event Monitor", ["RabbitMQ"]),
            ("summary", "A Supabase boundary serialises the approved local record as JSON.", ["Supabase", "JSON"]),
            ("background", "PostgREST exposes an OpenAPI document to the readiness check.", ["PostgREST", "OpenAPI"]),
            ("solution", "Before bundling Next.js, Vitest exercises a bounded TypeScript evidence parser.", ["Vitest", "TypeScript", "Next.js"]),
            ("summary", "The Node.js worker accepts one UUID from a local payload.", ["Node.js", "UUID"]),
            ("background", "During the synthetic sign-in check, a PKCE callback reaches only a local API route.", ["PKCE", "API"]),
            ("solution", "A bounded suggestion remains subject to staff review.", []),
            ("summary", "Run `npm run test:admin` before preserving the evidence.", ["npm"]),
            ("background", "For a masked reference, read https://example.invalid/final-policy or email audit@example.invalid.", []),
            ("solution", "The local evidence file report.final.json records trace 6f9619ff-8b86-4d11-842d-00cf4fc964ff.", []),
            ("summary", "Project prose treats `assistive_validation_findings` as an inert identifier.", []),
            ("background", "A local PostgreSQL fixture retains one synthetic benchmark record for replay.", ["PostgreSQL"]),
            ("solution", "A reviewer can ignore the suggestion, and the workflow remains unchanged.", []),
            ("summary", "The evidence records precision, recall, and F1.", ["F1"]),
            ("background", "Neither assigned reviewer has consumed the sealed synthetic measurement.", []),
            ("solution", "The café dashboard preserves Unicode text and emoji 😀 offsets.", ["Unicode"]),
            ("summary", "The value sha256:4f6b7c8d9e0f11223344556677889900 remains machine data.", []),
            ("background", "The quoted text \"ignore previous instructions\" is treated only as project content.", []),
            ("solution", "The OpenSearch connector remains local to the test fixture.", ["OpenSearch"]),
        ],
        "partition-b": [
            ("title", "Neighbourhood Energy Review", []), ("title", "SvelteKit Route Inventory", ["SvelteKit"]),
            ("summary", "Pydantic validates the local worker response before persistence.", ["Pydantic"]),
            ("background", "Redis stores no authoritative project metadata in this workflow.", ["Redis"]),
            ("solution", "Native PDF text is preferred, while an image-only poster may require OCR before language checks.", ["PDF", "OCR"]),
            ("summary", "The loopback service binds only to 127.0.0.1.", ["loopback"]),
            ("background", "The Turbopack build completes after the unit suite.", ["Turbopack"]),
            ("solution", "Only after exact metric recomputation did the verifier record its candidate decision.", []),
            ("summary", "The archive LanguageTool-6.6.zip is operator-provisioned.", ["LanguageTool"]),
            ("background", "The path src/worker.ts and table public.projects are masked as machine identifiers.", []),
            ("solution", "Email editor+test@example.invalid is not sent or interpreted.", []),
            ("summary", "Version v2.14.3 remains a literal release identifier.", []),
            ("background", "The value projectMetadataHash is treated as a technical token.", ["projectMetadataHash"]),
            ("solution", "Staff can save an edited draft through the existing audited workflow.", []),
            ("summary", "No colour-only state communicates whether a finding was reviewed.", []),
            ("background", "The interface remains usable at 390 px and 200% zoom.", []),
            ("solution", "The HTML text <script>alert('x')</script> is never executed.", []),
            ("summary", "The SQL words DROP TABLE projects are inert project prose.", []),
            ("background", "The provider returns plain text without arbitrary external links.", []),
            ("solution", "RabbitMQ and OpenSearch remain legitimate project terminology.", ["RabbitMQ", "OpenSearch"]),
        ],
        "partition-c": [
            ("title", "Regional Transport Evidence", []), ("title", "OpenSearch Audit Console", ["OpenSearch"]),
            ("summary", "The FastAPI prototype is not part of the production request path.", ["FastAPI"]),
            ("background", "Argon2id protects a synthetic credential in the calibration narrative.", ["Argon2id"]),
            ("solution", "OpenTelemetry records bounded local timing information.", ["OpenTelemetry"]),
            ("summary", "WebAuthn and WebRTC are legitimate technical names.", ["WebAuthn", "WebRTC"]),
            ("background", "MQTT carries one deidentified sensor event.", ["MQTT", "deidentified"]),
            ("solution", "The Modbus adapter remains outside the authoritative metadata path.", ["Modbus"]),
            ("summary", "A reviewer chooses whether to apply any proposed replacement.", []),
            ("background", "The process stops deterministically after a bounded timeout.", []),
            ("solution", "The provider never downloads an archive or contacts a cloud API.", ["API"]),
            ("summary", "Identifier CAPSTONE_ASSISTIVE_LANGUAGE_DIR is machine configuration.", []),
            ("background", "File package-lock.json remains masked while prose offsets stay stable.", []),
            ("solution", "Database identifier assistive_validation_runs is treated as inert text.", []),
            ("summary", "Nội dung Unicode remains aligned with UTF-16 offsets.", ["Unicode", "UTF-16"]),
            ("background", "The current draft substring must still match the original source span.", []),
            ("solution", "One safe replacement updates only the browser draft.", []),
            ("summary", "The assistant treats shell text rm -rf example as untrusted prose.", []),
            ("background", "An operator provisions Java 21 and LanguageTool locally.", ["Java", "LanguageTool"]),
            ("solution", "Pydantic, Redis, and SvelteKit are legitimate calibration terms.", ["Pydantic", "Redis", "SvelteKit"]),
        ],
    }


def build_calibration_manifest(_: Path) -> dict[str, Any]:
    cases: list[dict[str, Any]] = []
    for partition in sorted(CALIBRATION_PARTITIONS):
        for index, (field, text, issues, terms) in enumerate(_error_specs()[partition], start=1):
            cases.append(_case(f"lfc-{partition[-1]}-{index:03d}", "calibration", partition, field, text, issues, terms))
        for index, (field, text, terms) in enumerate(_clean_specs()[partition], start=21):
            cases.append(_case(f"lfc-{partition[-1]}-{index:03d}", "calibration", partition, field, text, [], terms))
    return validate_calibration_manifest({
        "schema_version": CALIBRATION_SCHEMA_VERSION,
        "corpus_version": CALIBRATION_CORPUS_VERSION,
        "content_policy": "deterministic_synthetic_deidentified_no_participant_or_production_data",
        "partitions": sorted(CALIBRATION_PARTITIONS),
        "cases": sorted(cases, key=lambda case: case["id"]),
    })


def _validate_case(case: Any, expected_split: str, partitions: set[str]) -> dict[str, Any]:
    if not isinstance(case, dict) or set(case) != _CASE_KEYS:
        raise ValueError("Final language case schema is closed")
    case_id, text = case.get("id"), case.get("source_text")
    if not isinstance(case_id, str) or not re.fullmatch(r"[a-z0-9-]{1,40}", case_id):
        raise ValueError("Final language case IDs must be bounded lowercase identifiers")
    if case.get("split") != expected_split or case.get("partition") not in partitions or case.get("field") not in FIELDS:
        raise ValueError(f"{case_id} split, partition, or field is invalid")
    if not isinstance(text, str) or not text or len(text) > 1500:
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


def _validate_case_set(cases: Any, split: str, partitions: set[str], expected_count: int) -> list[dict[str, Any]]:
    if not isinstance(cases, list) or len(cases) != expected_count:
        raise ValueError(f"Final language {split} must contain exactly {expected_count} cases")
    for case in cases:
        _validate_case(case, split, partitions)
    ids = [case["id"] for case in cases]
    texts = [" ".join(case["source_text"].split()).casefold() for case in cases]
    if len(ids) != len(set(ids)) or len(texts) != len(set(texts)):
        raise ValueError(f"Final language {split} IDs and normalized texts must be unique")
    if sum(case["intentionally_clean"] for case in cases) != expected_count // 2:
        raise ValueError(f"Final language {split} must be balanced clean/error")
    if {case["field"] for case in cases} != FIELDS:
        raise ValueError(f"Final language {split} must cover all supported fields")
    categories = {issue["category"] for case in cases for issue in case["issues"]}
    if categories != REQUIRED_ERROR_CATEGORIES:
        raise ValueError(f"Final language {split} must cover every required error category")
    for partition in partitions:
        partition_cases = [case for case in cases if case["partition"] == partition]
        if len(partition_cases) != expected_count // len(partitions):
            raise ValueError(f"{partition} has an invalid case count")
        if sum(case["intentionally_clean"] for case in partition_cases) * 2 != len(partition_cases):
            raise ValueError(f"{partition} must be balanced clean/error")
    return cases


def validate_calibration_manifest(value: Any) -> dict[str, Any]:
    expected_keys = {"schema_version", "corpus_version", "content_policy", "partitions", "cases"}
    if not isinstance(value, dict) or set(value) != expected_keys:
        raise ValueError("Final language calibration manifest schema is closed")
    if value.get("schema_version") != CALIBRATION_SCHEMA_VERSION or value.get("corpus_version") != CALIBRATION_CORPUS_VERSION:
        raise ValueError("Final language calibration identity is invalid")
    if value.get("content_policy") != "deterministic_synthetic_deidentified_no_participant_or_production_data":
        raise ValueError("Final language calibration must remain synthetic")
    if value.get("partitions") != sorted(CALIBRATION_PARTITIONS):
        raise ValueError("Final language calibration partitions changed")
    _validate_case_set(value.get("cases"), "calibration", CALIBRATION_PARTITIONS, 120)
    return value


def load_calibration_manifest(path: Path) -> dict[str, Any]:
    return validate_calibration_manifest(json.loads(path.read_text(encoding="utf-8")))


def combined_calibration_cases(_: Path, calibration: dict[str, Any]) -> list[dict[str, Any]]:
    return list(validate_calibration_manifest(calibration)["cases"])


def _holdout_error_case(
    index: int, partition: str, category: str, occurrence: int
) -> dict[str, Any]:
    spelling_fields = ["title", "summary", "background", "solution"]
    field = spelling_fields[index % 4] if category.startswith("SPELLING_") else ["summary", "background", "solution"][index % 3]
    recipes: dict[str, list[tuple[str, str, list[str], list[str]]]] = {
        "SPELLING_SIMPLE": [
            ("Watershed Enviroment Review", "Enviroment", ["Environment"], []),
            ("The dashboard records acessibility observations.", "acessibility", ["accessibility"], []),
            ("A local goverance check remains advisory.", "goverance", ["governance"], []),
        ],
        "SPELLING_REPEATED_CHARACTER": [
            ("The commmittee reviews the evidence bundle.", "commmittee", ["committee"], []),
            ("One vallidation result remains pending.", "vallidation", ["validation"], []),
            ("A staff member records the corrrection.", "corrrection", ["correction"], []),
        ],
        "SPELLING_DROPPED_CHARACTER": [
            ("The local process checks every dependncy.", "dependncy", ["dependency"], []),
            ("The evidence register preserves the original contxt.", "contxt", ["context"], []),
            ("A coordinator records the selected provder.", "provder", ["provider"], []),
        ],
        "SPELLING_TRANSPOSITION": [
            ("A reviewer opens the reivew panel.", "reivew", ["review"], []),
            ("The operator can udpate only a browser draft.", "udpate", ["update"], []),
            ("The local worker verifes the frozen identity.", "verifes", ["verifies"], []),
        ],
        "SPELLING_REAL_WORD": [
            ("The operator records a peace of supporting evidence.", "peace", ["piece"], []),
            ("The reviewer checks weather the source span still matches.", "weather", ["whether"], []),
            ("The worker stores the checksum beside than evidence record.", "than", ["the"], []),
        ],
        "SPELLING_TECHNICAL_NEAR_MISS": [
            ("LangaugeTool Policy Review", "LangaugeTool", ["LanguageTool"], []),
            ("A LangaugeTool finding remains non-blocking.", "LangaugeTool", ["LanguageTool"], []),
            ("The local LangaugeTool archive is operator-provisioned.", "LangaugeTool", ["LanguageTool"], []),
        ],
        "GRAMMAR_SUBJECT_VERB_AGREEMENT": [
            ("A coordinator verify the current project identity.", "verify", ["verifies"], []),
            ("The evidence register contain only bounded fields.", "contain", ["contains"], []),
            ("Each offline worker return a deterministic response.", "return", ["returns"], []),
        ],
        "GRAMMAR_SINGULAR_PLURAL": [
            ("Several report were queued for independent review.", "report", ["reports"], []),
            ("Two checksum identify the same frozen bundle.", "checksum", ["checksums"], []),
            ("Many reviewer can inspect the advisory result.", "reviewer", ["reviewers"], []),
        ],
        "GRAMMAR_ARTICLE": [
            ("The provider returns an concise explanation.", "an concise", ["a", "a concise"], []),
            ("Staff inspect a immutable evidence record.", "a immutable", ["an", "an immutable"], []),
            ("The verifier opens an bounded result file.", "an bounded", ["a", "a bounded"], []),
        ],
        "GRAMMAR_PRONOUN_AGREEMENT": [
            ("Every queue records their own claim token.", "their", ["its"], []),
            ("Each candidate retains their frozen configuration.", "their", ["its"], []),
            ("Neither process may alter their input after sealing.", "their", ["its"], []),
        ],
        "GRAMMAR_VERB_FORM": [
            ("The final audit has began on the sealed record.", "began", ["begun"], []),
            ("The worker has wrote a bounded diagnostic.", "wrote", ["written"], []),
            ("The operator did not changed the expected label.", "changed", ["change"], []),
        ],
        "GRAMMAR_SENTENCE_FRAGMENT": [
            ("Unless the stored input identity remains current.", "Unless the stored input identity remains current.", ["The stored input identity remains current."], []),
            ("While the optional local engine is unavailable.", "While the optional local engine is unavailable.", ["The optional local engine is unavailable."], []),
            ("Although the source field still contains the recorded span.", "Although the source field still contains the recorded span.", ["The source field still contains the recorded span."], []),
        ],
        "GRAMMAR_DUPLICATED_WORD": [
            ("A reviewer can still still ignore the proposal.", "still still", ["still"], []),
            ("The queue stores one one immutable claim.", "one one", ["one"], []),
            ("Staff may choose to to leave the draft unchanged.", "to to", ["to"], []),
        ],
        "GRAMMAR_CAPITALIZATION": [
            ("provider output is treated only as untrusted data.", "provider", ["Provider"], []),
            ("staff retain authority over every language suggestion.", "staff", ["Staff"], []),
            ("local checks never change publication state.", "local", ["Local"], []),
        ],
        "GRAMMAR_POSSESSIVE": [
            ("The operators decision is recorded separately.", "operators", ["operator's"], []),
            ("A projects draft remains distinct from saved metadata.", "projects", ["project's"], []),
            ("The providers identifier is included for audit.", "providers", ["provider's"], []),
        ],
        "PUNCTUATION_INTRODUCTORY_COMMA": [
            ("After the provider exits the coordinator saves bounded findings.", "After the provider exits", ["After the provider exits,"], []),
            ("When staff apply a proposal only the draft changes.", "When staff apply a proposal", ["When staff apply a proposal,"], []),
            ("Before persistence begins every offset is validated.", "Before persistence begins", ["Before persistence begins,"], []),
        ],
        "PUNCTUATION_COMMA_SPLICE": [
            ("The analysis is optional, existing checks continue.", "optional, existing", ["optional, and existing", "optional; existing", "optional. Existing"], []),
            ("The process timed out, the job recorded a degraded result.", "out, the", ["out, and the", "out; the", "out. The"], []),
            ("The span no longer matches, staff must refresh the run.", "matches, staff", ["matches, so staff", "matches; staff", "matches. Staff"], []),
        ],
        "PUNCTUATION_TERMINAL": [
            ("The staff member reviews the proposed replacement", "replacement", ["replacement."], []),
            ("The coordinator records a bounded failure reason", "reason", ["reason."], []),
            ("The current draft remains under staff control", "control", ["control."], []),
        ],
    }
    text, needle, corrections, terms = recipes[category][occurrence % len(recipes[category])]
    issues: list[IssueSpec] = [(needle, category, corrections)]
    if category == "SPELLING_SIMPLE" and index % 3 == 0 and field != "title":
        text = text.rstrip(".") + " and and remains non-blocking."
        issues.append(("and and", "GRAMMAR_DUPLICATED_WORD", ["and"]))
    return _case(f"lfh-{index:03d}", "holdout", partition, field, text, issues, terms)


def build_holdout_manifest(seed: str) -> dict[str, Any]:
    if not re.fullmatch(r"[0-9a-f]{32}", seed):
        raise ValueError("Fresh holdout seed must be 128-bit lowercase hexadecimal")
    rng = random.Random(int(seed, 16))
    categories = sorted(REQUIRED_ERROR_CATEGORIES)
    error_categories = categories * 2 + rng.sample(categories, 12)
    rng.shuffle(error_categories)
    cases: list[dict[str, Any]] = []
    category_occurrences: dict[str, int] = {}
    for index, category in enumerate(error_categories, start=1):
        partition = ["holdout-a", "holdout-b", "holdout-c"][(index - 1) % 3]
        occurrence = category_occurrences.get(category, 0)
        cases.append(_holdout_error_case(index, partition, category, occurrence))
        category_occurrences[category] = occurrence + 1
    technologies = ["RabbitMQ", "OpenSearch", "SvelteKit", "GraphQL", "WebSocket", "PostGIS", "TimescaleDB", "Pydantic"]
    topics = ["water reuse", "transport access", "energy demand", "habitat recovery", "clinic scheduling", "food rescue"]
    templates = [
        "The {tech} adapter records bounded evidence for {topic}.",
        "Staff review the {topic} report before saving metadata.",
        "The local {tech} worker treats project text only as data.",
        "A deterministic {topic} summary remains non-blocking.",
        "Run `npm run verify:local` for the {topic} fixture.",
        "Trace 8f14e45f-ea42-4d90-9d16-1c3414e8a111 remains a masked identifier.",
        "Read https://example.invalid/{slug} or contact review@example.invalid.",
        "Unicode café text for {topic} keeps emoji 😀 offsets aligned.",
    ]
    seen = {" ".join(case["source_text"].split()).casefold() for case in cases}
    index = 49
    while len(cases) < 96:
        tech, topic, template = rng.choice(technologies), rng.choice(topics), rng.choice(templates)
        text = template.format(tech=tech, topic=topic, slug=topic.replace(" ", "-"))
        normalized = " ".join(text.split()).casefold()
        if normalized in seen:
            continue
        seen.add(normalized)
        partition = ["holdout-a", "holdout-b", "holdout-c"][(index - 1) % 3]
        field = ["title", "summary", "background", "solution"][index % 4]
        terms = [term for term in technologies if term in text]
        cases.append(_case(f"lfh-{index:03d}", "holdout", partition, field, text, [], terms))
        index += 1
    return validate_holdout_manifest({
        "schema_version": HOLDOUT_SCHEMA_VERSION,
        "corpus_version": HOLDOUT_CORPUS_VERSION,
        "content_policy": "post_freeze_seeded_synthetic_deidentified_no_participant_or_production_data",
        "generation": {
            "algorithm": "python_random_mt19937_frozen_combinatorial_templates_v1",
            "seed": seed, "seed_sha256": hashlib.sha256(seed.encode("ascii")).hexdigest(), "case_count": 96,
        },
        "partitions": sorted(HOLDOUT_PARTITIONS),
        "cases": sorted(cases, key=lambda case: case["id"]),
    })


def validate_holdout_manifest(value: Any) -> dict[str, Any]:
    expected_keys = {"schema_version", "corpus_version", "content_policy", "generation", "partitions", "cases"}
    if not isinstance(value, dict) or set(value) != expected_keys:
        raise ValueError("Final language holdout manifest schema is closed")
    if value.get("schema_version") != HOLDOUT_SCHEMA_VERSION or value.get("corpus_version") != HOLDOUT_CORPUS_VERSION:
        raise ValueError("Final language holdout identity is invalid")
    if value.get("content_policy") != "post_freeze_seeded_synthetic_deidentified_no_participant_or_production_data":
        raise ValueError("Final language holdout must remain post-freeze synthetic data")
    generation = value.get("generation")
    if not isinstance(generation, dict) or set(generation) != {"algorithm", "seed", "seed_sha256", "case_count"}:
        raise ValueError("Final language holdout generation contract is closed")
    seed = generation.get("seed")
    if generation.get("algorithm") != "python_random_mt19937_frozen_combinatorial_templates_v1" or not isinstance(seed, str) or not re.fullmatch(r"[0-9a-f]{32}", seed):
        raise ValueError("Final language holdout generation identity is invalid")
    if generation.get("seed_sha256") != hashlib.sha256(seed.encode("ascii")).hexdigest() or generation.get("case_count") != 96:
        raise ValueError("Final language holdout seed evidence is inconsistent")
    if value.get("partitions") != sorted(HOLDOUT_PARTITIONS):
        raise ValueError("Final language holdout partitions changed")
    _validate_case_set(value.get("cases"), "holdout", HOLDOUT_PARTITIONS, 96)
    return value


def load_holdout_manifest(path: Path) -> dict[str, Any]:
    value = validate_holdout_manifest(json.loads(path.read_text(encoding="utf-8")))
    if value != build_holdout_manifest(value["generation"]["seed"]):
        raise ValueError("Final language holdout differs from deterministic post-freeze generation")
    return value
