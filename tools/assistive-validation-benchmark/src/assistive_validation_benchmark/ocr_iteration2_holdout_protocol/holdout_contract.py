"""The frozen shape of the future fresh holdout corpus, with no holdout content.

This module is the holdout schema and generator contract. It is frozen now, before any case
exists, so the future Iteration 2B3 branch can only *satisfy* the distribution — it cannot
negotiate one after seeing a result. Every identifier here is a pattern with zero instances.
"""

from __future__ import annotations

import re
from typing import Any

from ..core import levenshtein_distance
from ..ocr_iteration2_calibration.schema import normalized_content_hash
from ..ocr_iteration2_calibration.schema import load_json as _load_calibration_json
from ..ocr_productionization.title_safety import normalize_metric_title, normalize_production_title
from .schema import (
    HOLDOUT_CASE_ID,
    REQUIRED_DISTRACTOR_KINDS,
    REQUIRED_NEGATIVE_KINDS,
    _require,
    tool_root,
)


HOLDOUT_CORPUS_SCHEMA_VERSION = "pp1-ocr-iteration2-holdout-corpus-part/v2"
HOLDOUT_CORPUS_VERSION = "pp1-ocr-iteration2-holdout-corpus-v2"

# Identifier namespaces are frozen as patterns only. No instance exists in this branch.
WARMUP_ID = re.compile(r"^ocr2h-warmup-[0-9]{3}$")
NATIVE_CONTROL_ID = re.compile(r"^ocr2h-native-[0-9]{3}$")
SECURITY_CONTROL_ID = re.compile(r"^ocr2h-security-[0-9]{3}$")

ALLOWED_MEDIA = {"png", "jpeg", "scanned_pdf"}
ALLOWED_LAYOUTS = {"one_column", "two_column", "three_column"}
ALLOWED_DIFFICULTIES = {"clean", "challenging"}
ALLOWED_TITLE_STYLES = {"plain", "wrapped", "tracked", "shadow", "outlined"}
ALLOWED_CONTRASTS = {"high", "medium", "low"}
ALLOWED_NOISE = {"none", "mild"}
ALLOWED_DISTRACTOR_POSITIONS = {"above", "near"}
NON_MATERIAL_NEGATIVE_KIND = "punctuation_only_non_material"
ALLOWED_NEGATIVE_KINDS = REQUIRED_NEGATIVE_KINDS | {NON_MATERIAL_NEGATIVE_KIND}

CASE_FIELDS = {
    "id",
    "split",
    "asset",
    "media",
    "layout",
    "difficulty",
    "width",
    "height",
    "title",
    "metadata_title",
    "expected_agreement",
    "negative_kind",
    "negative_relation_evidence",
    "body_sections",
    "title_style",
    "tracking_px",
    "contrast",
    "noise",
    "jpeg_quality",
    "distractors",
    "tags",
}
DISTRACTOR_FIELDS = {"kind", "text", "position"}
RELATION_EVIDENCE_FIELDS = {"authority", "classified_before_ocr", "rationale"}
ASSET_SUFFIX = {"png": ".png", "jpeg": ".jpg", "scanned_pdf": ".pdf"}
SEMANTIC_RELATION_AUTHORITY = "human_ground_truth"
UNSAFE_RELATION_EVIDENCE = re.compile(
    r"(?:https?://|www\.|\b[a-z0-9-]+\.(?:com|net|org|io|ai|edu|gov)\b|[;&|`$<>]|\b(?:curl|wget|powershell|cmd(?:\.exe)?|bash)\b)",
    re.IGNORECASE,
)

CURLY_PUNCTUATION = set("‘’“”")
ACCENTED_LATIN = set("àáâäçèéêíñóôöúü")
SUBSCRIPTS = set("₀₁₂₃₄₅₆₇₈₉")
ASCII_PUNCTUATION = set(".,;:!?()")


def _case_body(case: dict[str, Any]) -> str:
    return " ".join(str(section) for section in case["body_sections"])


def _validate_distractor(distractor: Any) -> None:
    _require(isinstance(distractor, dict) and set(distractor) == DISTRACTOR_FIELDS, "distractor uses an unknown field set")
    _require(distractor["kind"] in REQUIRED_DISTRACTOR_KINDS, f"unsupported distractor kind: {distractor['kind']}")
    _require(distractor["position"] in ALLOWED_DISTRACTOR_POSITIONS, "distractor position must be above or near the title")
    text = distractor["text"]
    _require(isinstance(text, str) and 3 <= len(text) <= 90, "distractor text is outside its bounds")


def _title_tokens(value: str) -> list[str]:
    return normalize_metric_title(value).split()


def _number_or_version_tokens(tokens: list[str]) -> list[str]:
    return [token for token in tokens if any(character.isdecimal() for character in token)]


def _non_number_tokens(tokens: list[str]) -> list[str]:
    return [token for token in tokens if not any(character.isdecimal() for character in token)]


def _validate_semantic_relation_evidence(evidence: Any) -> None:
    _require(
        isinstance(evidence, dict) and set(evidence) == RELATION_EVIDENCE_FIELDS,
        "semantically related incorrect titles require the frozen human relation evidence",
    )
    _require(
        evidence["authority"] == SEMANTIC_RELATION_AUTHORITY,
        "semantic relation evidence must identify human ground truth as its authority",
    )
    _require(
        evidence["classified_before_ocr"] is True,
        "semantic relation evidence must be classified before OCR",
    )
    rationale = evidence["rationale"]
    _require(
        isinstance(rationale, str) and 20 <= len(rationale) <= 240 and rationale == rationale.strip(),
        "semantic relation rationale is missing or outside its plain-text bounds",
    )
    _require(
        rationale.isprintable() and "\n" not in rationale and "\r" not in rationale,
        "semantic relation rationale must be single-line printable text",
    )
    _require(
        UNSAFE_RELATION_EVIDENCE.search(rationale) is None,
        "semantic relation rationale may not contain a URL or command syntax",
    )


def _validate_title_relationship(case: dict[str, Any]) -> None:
    poster = case["title"]
    metadata = case["metadata_title"]
    negative = case["negative_kind"]
    evidence = case["negative_relation_evidence"]
    poster_metric = normalize_metric_title(poster)
    metadata_metric = normalize_metric_title(metadata)
    poster_production = normalize_production_title(poster)
    metadata_production = normalize_production_title(metadata)
    poster_tokens = _title_tokens(poster)
    metadata_tokens = _title_tokens(metadata)

    if negative is None:
        _require(evidence is None, "an ordinary agreement may not carry negative relation evidence")
        _require(
            poster_metric == metadata_metric and poster_production == metadata_production,
            "an unlabelled expected agreement must have normalized-equal titles",
        )
        return
    if negative == NON_MATERIAL_NEGATIVE_KIND:
        _require(evidence is None, "a punctuation-only control may not carry semantic relation evidence")
        _require(poster != metadata, "a punctuation-only control requires different raw title strings")
        _require(
            poster_metric == metadata_metric and poster_production == metadata_production,
            "a punctuation-only control may not change semantic words under frozen normalization",
        )
        return

    _require(
        poster_metric != metadata_metric and poster_production != metadata_production,
        "material negative normalized titles must be genuinely different",
    )
    if negative == "one_character_material":
        _require(evidence is None, "a one-character negative may not carry semantic relation evidence")
        _require(
            levenshtein_distance(poster_metric, metadata_metric) == 1
            and len(poster_tokens) == len(metadata_tokens)
            and levenshtein_distance(poster_tokens, metadata_tokens) == 1,
            "a one-character material negative must have exactly one normalized content-character edit",
        )
        _require(
            _number_or_version_tokens(poster_tokens) == _number_or_version_tokens(metadata_tokens),
            "a one-character material negative may not encode a number or version change",
        )
    elif negative == "one_word_material":
        _require(evidence is None, "a one-word negative may not carry semantic relation evidence")
        _require(
            levenshtein_distance(poster_tokens, metadata_tokens) == 1,
            "a one-word material negative must have exactly one normalized token edit",
        )
        _require(
            levenshtein_distance(poster_metric, metadata_metric) > 1,
            "a one-word material negative may not be a one-character category",
        )
        _require(
            _number_or_version_tokens(poster_tokens) == _number_or_version_tokens(metadata_tokens),
            "a one-word material negative may not encode a number or version change",
        )
    elif negative == "number_or_version":
        _require(evidence is None, "a number or version negative may not carry semantic relation evidence")
        poster_numbers = _number_or_version_tokens(poster_tokens)
        metadata_numbers = _number_or_version_tokens(metadata_tokens)
        _require(
            bool(poster_numbers or metadata_numbers) and poster_numbers != metadata_numbers,
            "a number or version negative requires an actual changed number or version token",
        )
        _require(
            _non_number_tokens(poster_tokens) == _non_number_tokens(metadata_tokens),
            "a number or version negative must keep every non-number token identical",
        )
    else:
        _validate_semantic_relation_evidence(evidence)


def _validate_case(case: Any, *, scored: bool) -> None:
    _require(isinstance(case, dict) and set(case) == CASE_FIELDS, "holdout case uses an unknown or missing field")
    case_id = str(case["id"])
    if scored:
        _require(bool(HOLDOUT_CASE_ID.fullmatch(case_id)), f"scored holdout case ID is invalid: {case_id}")
        _require(case["split"] == "holdout", "scored cases must declare the holdout split")
    else:
        _require(bool(WARMUP_ID.fullmatch(case_id)), f"warm-up case ID is invalid: {case_id}")
        _require(case["split"] == "warmup", "the warm-up case must declare the warmup split")
    _require(case["media"] in ALLOWED_MEDIA and case["layout"] in ALLOWED_LAYOUTS, "case media or layout is unsupported")
    _require(case["asset"] == f"{case_id}{ASSET_SUFFIX[case['media']]}", "case asset path is not deterministic")
    _require(case["difficulty"] in ALLOWED_DIFFICULTIES, "case difficulty is invalid")
    _require(case["title_style"] in ALLOWED_TITLE_STYLES, "case title style is invalid")
    _require(case["contrast"] in ALLOWED_CONTRASTS and case["noise"] in ALLOWED_NOISE, "case contrast or noise is invalid")
    _require(640 <= case["width"] <= 2200 and 480 <= case["height"] <= 1600, "case dimensions exceed the corpus bounds")
    _require(isinstance(case["title"], str) and 15 <= len(case["title"]) <= 90, "poster title is outside its bounds")
    _require("  " not in case["title"], "semantic title text may not encode visual tracking with repeated spaces")
    _require(isinstance(case["metadata_title"], str) and case["metadata_title"].strip(), "metadata title is missing")
    _require(isinstance(case["expected_agreement"], bool), "expected agreement must be a boolean label")
    sections = case["body_sections"]
    _require(isinstance(sections, list) and len(sections) == 3, "every poster must have three deterministic sections")
    _require(
        all(isinstance(item, str) and 20 <= len(item) <= 300 for item in sections),
        "poster body section text is outside its bounds",
    )
    if case["title_style"] == "tracked":
        _require(
            isinstance(case["tracking_px"], (int, float)) and 0 < case["tracking_px"] <= 4,
            "tracked titles require bounded visual pixel tracking",
        )
    else:
        _require(case["tracking_px"] == 0, "non-tracked title styles must not carry tracking")
    if case["media"] == "jpeg":
        _require(isinstance(case["jpeg_quality"], int) and 40 <= case["jpeg_quality"] <= 95, "JPEG quality is out of bounds")
    negative = case["negative_kind"]
    _require(negative is None or negative in ALLOWED_NEGATIVE_KINDS, f"unsupported negative kind: {negative}")
    if negative in REQUIRED_NEGATIVE_KINDS:
        _require(case["expected_agreement"] is False, "a material title negative may not be labelled as an agreement")
    if negative in (None, NON_MATERIAL_NEGATIVE_KIND):
        _require(case["expected_agreement"] is True, "only material negatives may be labelled as non-agreements")
    _validate_title_relationship(case)
    distractors = case["distractors"]
    _require(isinstance(distractors, list) and len(distractors) <= 6, "distractor count is outside its bounds")
    for distractor in distractors:
        _validate_distractor(distractor)
    _require(isinstance(case["tags"], list), "case tags must be a list")


def title_text_coverage(scored: list[dict[str, Any]]) -> dict[str, bool]:
    """Prove the frozen title text coverage from the case content itself, not from a claim."""
    titles = [case["title"] for case in scored]
    joined = "".join(titles)
    tags = {tag for case in scored for tag in case["tags"]}
    return {
        "single_line": any(case["title_style"] != "wrapped" for case in scored),
        "wrapped_multi_line": any(case["title_style"] == "wrapped" for case in scored),
        "punctuation": bool(ASCII_PUNCTUATION & set(joined)),
        "hyphen_and_dash_variants": all(character in joined for character in ("-", "–", "—")),
        "numbers_and_acronyms": any(character.isdigit() for character in joined)
        and any(re.search(r"[A-Z]{2,}", title) for title in titles),
        "australian_english": sum("australian_english" in case["tags"] for case in scored) >= 2,
        "technical_vocabulary": sum("technical_vocabulary" in case["tags"] for case in scored) >= 2,
        "accented_latin": bool(ACCENTED_LATIN & set(joined)),
        "curly_punctuation": bool(CURLY_PUNCTUATION & set(joined)),
        "subscripts": bool(SUBSCRIPTS & set(joined)) or "subscript" in " ".join(sorted(tags)),
    }


def _counts(scored: list[dict[str, Any]], key: str) -> dict[str, int]:
    return {value: sum(case[key] == value for case in scored) for value in sorted({case[key] for case in scored})}


def _cell_counts(scored: list[dict[str, Any]], key: str) -> dict[str, int]:
    cells: dict[str, int] = {}
    for case in scored:
        cells[f"{case[key]}/{case['difficulty']}"] = cells.get(f"{case[key]}/{case['difficulty']}", 0) + 1
    return cells


def distractor_summary(scored: list[dict[str, Any]]) -> dict[str, Any]:
    above = [case for case in scored if any(item["position"] == "above" for item in case["distractors"])]
    near = [case for case in scored if any(item["position"] == "near" for item in case["distractors"])]
    kinds = {kind: 0 for kind in sorted(REQUIRED_DISTRACTOR_KINDS)}
    for case in scored:
        for kind in {item["kind"] for item in case["distractors"]}:
            kinds[kind] += 1
    return {
        "cases_with_any_distractor": sum(bool(case["distractors"]) for case in scored),
        "cases_with_distractor_above_title": len(above),
        "cases_with_distractor_near_title": len(near),
        "cases_with_both_above_and_near": len({case["id"] for case in above} & {case["id"] for case in near}),
        "cases_with_title_as_topmost_region": len(scored) - len(above),
        "kinds": kinds,
    }


def validate_holdout_corpus(corpus: dict[str, Any], protocol: dict[str, Any]) -> dict[str, Any]:
    """Validate a future holdout corpus against the frozen distribution. Content-agnostic."""
    _require(corpus.get("schema_version") == HOLDOUT_CORPUS_SCHEMA_VERSION, "unsupported holdout corpus schema")
    _require(corpus.get("corpus_version") == HOLDOUT_CORPUS_VERSION, "holdout corpus identity changed")
    _require(corpus.get("part") == "holdout" and corpus.get("measurement_role") == "independent_holdout", "corpus role is wrong")
    _require(corpus.get("independent_holdout") is True, "the fresh holdout corpus must declare independence")
    _require(isinstance(corpus.get("seed"), int), "the holdout corpus must declare an integer seed")
    cases = corpus.get("ocr_cases")
    _require(isinstance(cases, list), "OCR cases must be a list")
    scored = [case for case in cases if isinstance(case, dict) and case.get("split") == "holdout"]
    warmups = [case for case in cases if isinstance(case, dict) and case.get("split") == "warmup"]
    _require(len(cases) == len(scored) + len(warmups), "the holdout corpus contains an unknown split")

    distribution = protocol["holdout_distribution"]
    controls_contract = protocol["controls"]
    _require(len(scored) == distribution["scored_case_count"], "scored holdout case count differs from the frozen protocol")
    _require(len(warmups) == controls_contract["unscored_warmup_count"], "warm-up count differs from the frozen protocol")
    identifiers = [str(case["id"]) for case in cases]
    _require(len(set(identifiers)) == len(identifiers), "holdout case IDs are duplicated")
    for case in scored:
        _validate_case(case, scored=True)
    for case in warmups:
        _validate_case(case, scored=False)

    _require(_counts(scored, "media") == distribution["media"], "holdout media distribution differs from the frozen targets")
    _require(_counts(scored, "layout") == distribution["layout"], "holdout layout distribution differs from the frozen targets")
    _require(_counts(scored, "difficulty") == distribution["difficulty"], "holdout difficulty split differs from the frozen targets")
    for key, floor_key in (("media", "minimum_cases_per_media_difficulty_cell"), ("layout", "minimum_cases_per_layout_difficulty_cell")):
        cells = _cell_counts(scored, key)
        _require(len(cells) == 6, f"holdout {key} and difficulty are not fully crossed")
        _require(min(cells.values()) >= distribution[floor_key], f"holdout {key}/difficulty balance is below the frozen floor")

    distractors = distractor_summary(scored)
    contract = protocol["upper_page_distractors"]
    _require(
        distractors["cases_with_any_distractor"] >= contract["cases_with_any_distractor_minimum"],
        "too few holdout cases carry an upper-page distractor",
    )
    _require(
        distractors["cases_with_distractor_above_title"] >= contract["cases_with_distractor_above_title_minimum"],
        "too few holdout cases place a distractor above the project title",
    )
    _require(
        distractors["cases_with_distractor_near_title"] >= contract["cases_with_distractor_near_title_minimum"],
        "too few holdout cases place a distractor near the project title",
    )
    _require(
        distractors["cases_with_both_above_and_near"] >= contract["cases_with_both_above_and_near_minimum"],
        "too few holdout cases combine an above and a near distractor",
    )
    _require(
        distractors["cases_with_title_as_topmost_region"] <= contract["cases_with_title_as_topmost_region_maximum"],
        "the project title is the topmost region on too many holdout cases",
    )
    for kind, floor in contract["required_kinds"].items():
        _require(distractors["kinds"][kind] >= floor, f"distractor kind is under-represented: {kind}")

    styles = _counts(scored, "title_style")
    style_contract = protocol["title_style_coverage"]
    for style, key in (("plain", "plain_minimum"), ("wrapped", "wrapped_minimum"), ("tracked", "tracked_minimum"), ("shadow", "shadow_minimum")):
        _require(styles.get(style, 0) >= style_contract[key], f"title style is under-represented: {style}")
    _require(styles.get("outlined", 0) <= style_contract["outlined_maximum"], "outlined titles exceed the minority allowance")

    coverage = title_text_coverage(scored)
    missing = sorted(key for key, present in coverage.items() if not present)
    _require(not missing, f"holdout title text coverage is incomplete: {missing}")

    degradation = protocol["degradation_coverage"]
    observed_degradation = {
        "low_resolution_minimum": sum("low_resolution" in case["tags"] for case in scored),
        "moderate_compression_minimum": sum(
            case["media"] == "jpeg" and 40 <= case["jpeg_quality"] <= 80 for case in scored
        ),
        "mild_noise_minimum": sum(case["noise"] == "mild" for case in scored),
        "medium_or_low_contrast_minimum": sum(case["contrast"] in {"medium", "low"} for case in scored),
        "small_body_text_minimum": sum("small_body_text" in case["tags"] for case in scored),
    }
    for key, floor in degradation.items():
        _require(observed_degradation[key] >= floor, f"holdout degradation coverage is below the frozen floor: {key}")

    negative_contract = protocol["material_title_negatives"]
    material = [case for case in scored if case["negative_kind"] in REQUIRED_NEGATIVE_KINDS]
    _require(
        len(material) >= negative_contract["minimum_scored_cases"],
        "the holdout carries too few material title negatives",
    )
    for kind, floor in negative_contract["required_kinds"].items():
        _require(
            sum(case["negative_kind"] == kind for case in scored) >= floor,
            f"material negative kind is under-represented: {kind}",
        )
    _require(
        sum(case["negative_kind"] == NON_MATERIAL_NEGATIVE_KIND for case in scored)
        >= negative_contract["punctuation_only_non_material_controls_minimum"],
        "the holdout carries too few punctuation-only non-material controls",
    )

    native = corpus.get("native_controls")
    security = corpus.get("security_controls")
    _require(isinstance(native, list) and len(native) >= controls_contract["native_pdf_control_minimum"], "native PDF controls are incomplete")
    _require(isinstance(security, list) and len(security) >= controls_contract["security_control_minimum"], "security controls are incomplete")
    for control in native:
        _require(bool(NATIVE_CONTROL_ID.fullmatch(str(control.get("id")))), "native control ID is invalid")
    for control in security:
        _require(bool(SECURITY_CONTROL_ID.fullmatch(str(control.get("id")))), "security control ID is invalid")

    return {
        "scored_case_count": len(scored),
        "media": _counts(scored, "media"),
        "layout": _counts(scored, "layout"),
        "difficulty": _counts(scored, "difficulty"),
        "title_style": styles,
        "distractors": distractors,
        "degradation": observed_degradation,
        "material_negative_count": len(material),
        "title_text_coverage": coverage,
        "native_control_count": len(native),
        "security_control_count": len(security),
        "controls_counted_toward_quality_rates": False,
    }


def holdout_non_reuse_evidence(corpus: dict[str, Any]) -> dict[str, Any]:
    """Prove the fresh holdout reuses no exact title+body from any exposed historical corpus."""
    scored = [case for case in corpus["ocr_cases"] if case["split"] == "holdout"]
    current = {case["id"]: normalized_content_hash(case["title"], _case_body(case)) for case in scored}
    historical: dict[str, str] = {}
    phase0 = _load_calibration_json(tool_root() / "corpus" / "manifest.json")
    for case in phase0["cases"]:
        if case.get("kind") == "document":
            historical[f"phase0:{case['id']}"] = normalized_content_hash(case["poster_title"], case["body"])
    v1_root = tool_root() / "ocr-productionization" / "corpus"
    for part_name in ("calibration", "holdout"):
        part = _load_calibration_json(v1_root / f"{part_name}.json")
        for case in part["ocr_cases"]:
            if case["split"] in {"calibration", "holdout"}:
                historical[f"v1:{case['id']}"] = normalized_content_hash(case["title"], case["body"])
    calibration = _load_calibration_json(tool_root() / "ocr-iteration2-calibration" / "corpus" / "calibration.json")
    for case in calibration["ocr_cases"]:
        if case["split"] == "calibration":
            historical[f"iteration2-calibration:{case['id']}"] = normalized_content_hash(case["title"], _case_body(case))
    reverse: dict[str, list[str]] = {}
    for identifier, digest in historical.items():
        reverse.setdefault(digest, []).append(identifier)
    reused = [
        {"case_id": case_id, "historical_ids": reverse[digest]}
        for case_id, digest in current.items()
        if digest in reverse
    ]
    return {
        "evidence_name": "fresh_holdout_non_reuse_independence_evidence",
        "scored_case_count": len(current),
        "historical_case_count": len(historical),
        "exact_title_body_reuse_count": len(reused),
        "reused_cases": reused,
        "real_participant_or_project_data": False,
    }
