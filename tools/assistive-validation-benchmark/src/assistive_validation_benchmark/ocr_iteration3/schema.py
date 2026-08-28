from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from pathlib import Path
from typing import Any


CORPUS_SCHEMA = "pp1-ocr-iteration3-corpus/v1"
PROTOCOL_SCHEMA = "pp1-ocr-iteration3-protocol/v1"
CASE_ID = re.compile(r"^ocr3-(?:cal|hold)-[0-9]{3}$")
ALLOWED_MEDIA = {"png", "jpeg", "scanned_pdf"}
ALLOWED_LAYOUTS = {"one_column", "two_column", "three_column"}
ALLOWED_DIFFICULTIES = {"clean", "challenging"}
ALLOWED_FEATURES = {"none", "table", "diagram"}
ALLOWED_STYLES = {"plain", "wrapped", "multiline", "shadow"}
ASSET_SUFFIX = {"png": ".png", "jpeg": ".jpg", "scanned_pdf": ".pdf"}


def tool_root() -> Path:
    return Path(__file__).resolve().parents[3]


def repository_root() -> Path:
    return tool_root().parents[1]


def calibration_data_root() -> Path:
    return tool_root() / "ocr-iteration3-calibration"


def holdout_data_root() -> Path:
    return tool_root() / "ocr-iteration3-fresh-holdout"


def evidence_root() -> Path:
    return repository_root() / "docs" / "assistive-validation" / "evidence" / "ocr-iteration3"


def canonical_json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"JSON root must be an object: {path}")
    return value


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def value_sha256(value: Any) -> str:
    return hashlib.sha256(canonical_json_bytes(value)).hexdigest()


def normalize_identity_text(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def semantic_case_hash(case: dict[str, Any], reference_text: str) -> str:
    del case
    payload = normalize_identity_text(reference_text)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _require_exact_keys(value: dict[str, Any], expected: set[str], label: str) -> None:
    if set(value) != expected:
        raise ValueError(f"{label} fields differ: {sorted(set(value) ^ expected)}")


def validate_protocol(value: dict[str, Any]) -> dict[str, Any]:
    required = {
        "schema_version", "protocol_version", "candidate", "configuration", "reading_order",
        "title_contract", "metrics", "quality_gates", "calibration_selection", "operational_gates",
        "security", "holdout_contract", "decision_contract",
    }
    _require_exact_keys(value, required, "protocol")
    if value["schema_version"] != PROTOCOL_SCHEMA:
        raise ValueError("unsupported Iteration 3 protocol schema")
    candidate = value["candidate"]
    if candidate.get("engine") != "paddle-small" or candidate.get("model_family") != "PP-OCRv6 Small":
        raise ValueError("Candidate A must remain frozen to PP-OCRv6 Small")
    configuration = value["configuration"]
    if configuration != {
        "device": "cpu",
        "raster_dpi": 180,
        "max_input_dimension": 1920,
        "enable_mkldnn": False,
        "use_doc_orientation_classify": False,
        "use_doc_unwarping": False,
        "use_textline_orientation": False,
    }:
        raise ValueError("Iteration 3 raster/runtime configuration changed")
    gates = value["quality_gates"]
    if gates != {
        "exact_title_rate_minimum": 0.95,
        "primary_wer_maximum": 0.12,
        "material_false_automatic_agreements_maximum": 0,
        "all_scored_cases_must_execute": True,
    }:
        raise ValueError("Iteration 3 quality gates changed")
    operational = value["operational_gates"]
    expected_operational = {
        "cold_start_ms_maximum": 30000,
        "p50_ms_maximum": 10000,
        "p95_ms_maximum": 20000,
        "peak_working_set_bytes_maximum": 4294967296,
        "artifact_footprint_bytes_maximum": 1073741824,
        "per_case_timeout_seconds": 90,
    }
    if operational != expected_operational:
        raise ValueError("Iteration 3 operational ceilings changed")
    holdout = value["holdout_contract"]
    if holdout.get("scored_case_count") != 45 or holdout.get("cases_per_media_layout_cell") != 5:
        raise ValueError("fresh holdout allocation changed")
    if value["decision_contract"].get("allowed") != [
        "READY_FOR_OCR_PROVIDER_INTEGRATION",
        "OCR_PROVIDER_DEFERRED",
        "HOLDOUT_INVALID_PROTOCOL_BUG",
    ]:
        raise ValueError("decision vocabulary changed")
    return value


def _case_text_values(case: dict[str, Any]) -> list[str]:
    values = [*case["top_controls"], case["title"], *(item["text"] for item in case["distractors"])]
    for column in case["column_sections"]:
        for section in column:
            values.extend([section["heading"], section["body"]])
    if case["feature"] != "none":
        values.extend([case["feature_heading"], *case["feature_items"], case["feature_caption"]])
    for section in case["closing_sections"]:
        values.extend([section["heading"], section["body"]])
    return values


def validate_corpus(value: dict[str, Any], *, expected_split: str, expected_count: int) -> dict[str, Any]:
    _require_exact_keys(
        value,
        {"schema_version", "corpus_version", "role", "seed", "ocr_cases", "native_controls", "security_controls"},
        "corpus",
    )
    if value["schema_version"] != CORPUS_SCHEMA or value["role"] != expected_split:
        raise ValueError("corpus schema or role changed")
    scored = [case for case in value["ocr_cases"] if case["split"] == expected_split]
    warmups = [case for case in value["ocr_cases"] if case["split"] == "warmup"]
    if len(scored) != expected_count or len(warmups) != 1:
        raise ValueError("corpus scored/warmup count changed")
    ids: set[str] = set()
    expected_columns = {"one_column": 1, "two_column": 2, "three_column": 3}
    for case in value["ocr_cases"]:
        required = {
            "id", "split", "media", "layout", "difficulty", "title", "metadata_title",
            "expected_agreement", "title_style", "tracking_px", "contrast", "noise", "jpeg_quality",
            "width", "height", "asset", "top_controls", "distractors", "column_sections", "feature",
            "feature_heading", "feature_items", "feature_caption", "closing_sections", "tags",
        }
        _require_exact_keys(case, required, f"case {case.get('id')}")
        if case["split"] not in {"warmup", expected_split}:
            raise ValueError("case split differs from the corpus role")
        expected_prefix = "ocr3-cal-" if expected_split == "calibration" else "ocr3-hold-"
        if case["id"] in ids or (
            case["split"] != "warmup"
            and (not CASE_ID.fullmatch(case["id"]) or not case["id"].startswith(expected_prefix))
        ):
            raise ValueError("case identity is invalid or duplicated")
        ids.add(case["id"])
        if case["media"] not in ALLOWED_MEDIA or case["layout"] not in ALLOWED_LAYOUTS:
            raise ValueError("case media/layout is invalid")
        if case["difficulty"] not in ALLOWED_DIFFICULTIES or case["feature"] not in ALLOWED_FEATURES:
            raise ValueError("case difficulty/feature is invalid")
        if case["title_style"] not in ALLOWED_STYLES:
            raise ValueError("case title style is invalid")
        if not case["asset"].endswith(ASSET_SUFFIX[case["media"]]):
            raise ValueError("case asset suffix differs from media")
        columns = expected_columns[case["layout"]]
        if len(case["column_sections"]) != columns or len(case["closing_sections"]) != columns:
            raise ValueError("case column allocation differs from layout")
        if case["feature"] == "none" and any((case["feature_heading"], case["feature_items"], case["feature_caption"])):
            raise ValueError("feature-free case carries feature text")
        if case["feature"] != "none" and not all((case["feature_heading"], case["feature_items"], case["feature_caption"])):
            raise ValueError("feature case lacks bounded semantic text")
        if any(not isinstance(text, str) or not text.strip() for text in _case_text_values(case)):
            raise ValueError("case contains empty or non-text semantic content")
    if expected_split in {"calibration", "holdout"}:
        cells = {(media, layout): 0 for media in ALLOWED_MEDIA for layout in ALLOWED_LAYOUTS}
        for case in scored:
            cells[(case["media"], case["layout"])] += 1
        if len(set(cells.values())) != 1 or min(cells.values()) < 2:
            raise ValueError("media and layout are not independently crossed with meaningful representation")
        if {case["difficulty"] for case in scored} != ALLOWED_DIFFICULTIES:
            raise ValueError("corpus must contain clean and challenging cases")
        required_tags = {
            "wrapped_or_multiline_title", "distractor_heading", "table", "diagram_caption", "top_page_control",
            "low_contrast", "compression", "mild_noise", "small_body_text", "semantic_negative",
            "punctuation_only_variation", "number_version_negative",
        }
        observed_tags = {tag for case in scored for tag in case["tags"]}
        if not required_tags <= observed_tags:
            raise ValueError(f"corpus feature coverage is incomplete: {sorted(required_tags - observed_tags)}")
    return value


def corpus_summary(corpus: dict[str, Any], *, split: str) -> dict[str, Any]:
    cases = [case for case in corpus["ocr_cases"] if case["split"] == split]
    def counts(key: str) -> dict[str, int]:
        return {value: sum(case[key] == value for case in cases) for value in sorted({case[key] for case in cases})}
    cells = {
        f"{media}/{layout}": sum(case["media"] == media and case["layout"] == layout for case in cases)
        for media in sorted(ALLOWED_MEDIA)
        for layout in sorted(ALLOWED_LAYOUTS)
    }
    return {
        "case_count": len(cases),
        "media": counts("media"),
        "layout": counts("layout"),
        "difficulty": counts("difficulty"),
        "feature": counts("feature"),
        "media_layout_cells": cells,
        "tag_coverage": sorted({tag for case in cases for tag in case["tags"]}),
    }
