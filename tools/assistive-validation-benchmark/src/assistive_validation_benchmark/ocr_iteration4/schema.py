from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from pathlib import Path
from typing import Any


CORPUS_SCHEMA = "pp1-ocr-iteration4-corpus/v1"
PROTOCOL_SCHEMA = "pp1-ocr-iteration4-protocol/v1"
CASE_ID = re.compile(r"^ocr4-(?:cal|hold)-[0-9]{3}$")
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
    return tool_root() / "ocr-iteration4-calibration"


def holdout_data_root() -> Path:
    return tool_root() / "ocr-iteration4-fresh-holdout"


def calibration_evidence_root() -> Path:
    return repository_root() / "docs" / "assistive-validation" / "evidence" / "ocr-iteration4"


def holdout_evidence_root() -> Path:
    return repository_root() / "docs" / "assistive-validation" / "evidence" / "ocr-iteration4-fresh-holdout"


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


def normalized_source_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest()


def normalize_identity_text(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def canonical_tree(path: Path) -> tuple[str, int, list[dict[str, Any]]]:
    if not path.is_dir():
        raise ValueError(f"artifact directory is missing: {path}")
    records = []
    digest = hashlib.sha256()
    for item in sorted(candidate for candidate in path.rglob("*") if candidate.is_file()):
        relative = item.relative_to(path).as_posix()
        if relative == ".cache" or relative.startswith(".cache/"):
            continue
        record = {"path": relative, "bytes": item.stat().st_size, "sha256": file_sha256(item)}
        records.append(record)
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(record["bytes"]).encode("ascii"))
        digest.update(b"\0")
        digest.update(bytes.fromhex(record["sha256"]))
        digest.update(b"\0")
    if not records:
        raise ValueError(f"artifact directory is empty: {path}")
    return digest.hexdigest(), sum(record["bytes"] for record in records), records


def _require_exact_keys(value: dict[str, Any], expected: set[str], label: str) -> None:
    if set(value) != expected:
        raise ValueError(f"{label} fields differ: {sorted(set(value) ^ expected)}")


def validate_protocol(value: dict[str, Any]) -> dict[str, Any]:
    _require_exact_keys(
        value,
        {
            "schema_version", "protocol_version", "authority", "candidate", "runtime", "configuration",
            "rendering", "output_extraction", "title_contract", "metrics", "quality_gates",
            "calibration_selection", "operational_gates", "operational_budget_justification", "security",
            "holdout_contract", "decision_contract",
        },
        "protocol",
    )
    if value["schema_version"] != PROTOCOL_SCHEMA:
        raise ValueError("unsupported Iteration 4 protocol schema")
    if value["candidate"] != {
        "pipeline": "PaddleOCR-VL-1.6",
        "vl_model": "PaddleOCR-VL-1.6-0.9B",
        "vl_repository": "PaddlePaddle/PaddleOCR-VL-1.6",
        "vl_revision": "c5630abae1d940eafe0697512a0325494b02ab42",
        "layout_model": "PP-DocLayoutV3",
        "layout_repository": "PaddlePaddle/PP-DocLayoutV3",
        "layout_revision": "7b48a7566925fa464281f930c58eee04fe2c862a",
        "license": "Apache-2.0",
        "model_manifest": "model-manifest.json",
    }:
        raise ValueError("Iteration 4 candidate identity changed")
    if value["runtime"] != {"paddleocr": "3.7.0", "paddlepaddle": "3.3.1", "paddlex": "3.7.2"}:
        raise ValueError("Iteration 4 runtime identity changed")
    if value["configuration"] != {
        "pipeline_version": "v1.6",
        "backend": "native",
        "device": "cpu",
        "worker_concurrency": 1,
        "cpu_threads": 10,
        "enable_mkldnn": True,
        "use_queues": False,
        "use_layout_detection": True,
        "layout_threshold": 0.3,
        "use_doc_orientation_classify": False,
        "use_doc_unwarping": False,
        "use_chart_recognition": False,
        "use_seal_recognition": False,
        "use_ocr_for_image_block": False,
        "format_block_content": False,
        "merge_layout_blocks": True,
    }:
        raise ValueError("Iteration 4 inference configuration changed")
    if value["quality_gates"] != {
        "exact_title_rate_minimum": 0.95,
        "primary_wer_maximum": 0.12,
        "material_false_automatic_agreements_maximum": 0,
        "all_scored_cases_must_execute": True,
    }:
        raise ValueError("Iteration 4 quality gates changed")
    if value["calibration_selection"] != {
        "exact_title_rate_minimum": 1.0,
        "primary_wer_maximum": 0.09,
        "all_final_gate_families_must_pass": True,
    }:
        raise ValueError("Iteration 4 calibration margin changed")
    if value["operational_gates"] != {
        "worker_concurrency_maximum": 1,
        "artifact_footprint_bytes_maximum": 3221225472,
        "peak_working_set_bytes_maximum": 10737418240,
        "cold_start_ms_maximum": 180000,
        "p50_ms_maximum": 120000,
        "p95_ms_maximum": 180000,
        "per_case_timeout_seconds": 180,
        "whole_run_timeout_seconds": 300,
    }:
        raise ValueError("Iteration 4 operational ceilings changed")
    holdout = value["holdout_contract"]
    if holdout.get("scored_case_count") != 45 or holdout.get("cases_per_media_layout_cell") != 5:
        raise ValueError("Iteration 4 holdout allocation changed")
    if value["decision_contract"].get("allowed") != [
        "READY_FOR_OCR_PROVIDER_INTEGRATION",
        "OCR_PROVIDER_DEFERRED",
        "HOLDOUT_INVALID_PROTOCOL_BUG",
    ]:
        raise ValueError("Iteration 4 decision vocabulary changed")
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
        raise ValueError("Iteration 4 corpus schema or role changed")
    scored = [case for case in value["ocr_cases"] if case["split"] == expected_split]
    warmups = [case for case in value["ocr_cases"] if case["split"] == "warmup"]
    if len(scored) != expected_count or len(warmups) != 1:
        raise ValueError("Iteration 4 corpus scored/warmup count changed")
    ids: set[str] = set()
    expected_columns = {"one_column": 1, "two_column": 2, "three_column": 3}
    for case in value["ocr_cases"]:
        _require_exact_keys(
            case,
            {
                "id", "split", "media", "layout", "difficulty", "title", "metadata_title",
                "expected_agreement", "title_style", "tracking_px", "contrast", "noise", "jpeg_quality",
                "width", "height", "asset", "top_controls", "distractors", "column_sections", "feature",
                "feature_heading", "feature_items", "feature_caption", "closing_sections", "tags",
            },
            f"case {case.get('id')}",
        )
        if case["split"] not in {"warmup", expected_split}:
            raise ValueError("case split differs from the corpus role")
        prefix = "ocr4-cal-" if expected_split == "calibration" else "ocr4-hold-"
        if case["id"] in ids or (
            case["split"] != "warmup" and (not CASE_ID.fullmatch(case["id"]) or not case["id"].startswith(prefix))
        ):
            raise ValueError("Iteration 4 case identity is invalid or duplicated")
        ids.add(case["id"])
        if case["media"] not in ALLOWED_MEDIA or case["layout"] not in ALLOWED_LAYOUTS:
            raise ValueError("case media/layout is invalid")
        if case["difficulty"] not in ALLOWED_DIFFICULTIES or case["feature"] not in ALLOWED_FEATURES:
            raise ValueError("case difficulty/feature is invalid")
        if case["title_style"] not in ALLOWED_STYLES or not case["asset"].endswith(ASSET_SUFFIX[case["media"]]):
            raise ValueError("case title style or asset suffix is invalid")
        columns = expected_columns[case["layout"]]
        if len(case["column_sections"]) != columns or len(case["closing_sections"]) != columns:
            raise ValueError("case column allocation differs from layout")
        if case["feature"] == "none" and any((case["feature_heading"], case["feature_items"], case["feature_caption"])):
            raise ValueError("feature-free case carries feature text")
        if case["feature"] != "none" and not all((case["feature_heading"], case["feature_items"], case["feature_caption"])):
            raise ValueError("feature case lacks bounded visible text")
        if any(not isinstance(text, str) or not text.strip() for text in _case_text_values(case)):
            raise ValueError("case contains empty or non-text semantic content")
    cells = {(media, layout): 0 for media in ALLOWED_MEDIA for layout in ALLOWED_LAYOUTS}
    for case in scored:
        cells[(case["media"], case["layout"])] += 1
    expected_per_cell = 3 if expected_split == "calibration" else 5
    if set(cells.values()) != {expected_per_cell}:
        raise ValueError("media and layout are not independently crossed")
    required_tags = {
        "wrapped_or_multiline_title", "distractor_heading", "table", "diagram_caption", "top_page_control",
        "low_contrast", "compression", "mild_noise", "small_body_text", "semantic_negative",
        "punctuation_only_variation", "number_version_negative", "full_width_spanning_section",
        "asymmetric_two_column", "hostile_prompt_text",
    }
    observed_tags = {tag for case in scored for tag in case["tags"]}
    if not required_tags <= observed_tags:
        raise ValueError(f"Iteration 4 feature coverage is incomplete: {sorted(required_tags - observed_tags)}")
    return value


def corpus_summary(corpus: dict[str, Any], *, split: str) -> dict[str, Any]:
    cases = [case for case in corpus["ocr_cases"] if case["split"] == split]

    def counts(key: str) -> dict[str, int]:
        return {value: sum(case[key] == value for case in cases) for value in sorted({case[key] for case in cases})}

    return {
        "case_count": len(cases),
        "media": counts("media"),
        "layout": counts("layout"),
        "difficulty": counts("difficulty"),
        "feature": counts("feature"),
        "media_layout_cells": {
            f"{media}/{layout}": sum(case["media"] == media and case["layout"] == layout for case in cases)
            for media in sorted(ALLOWED_MEDIA)
            for layout in sorted(ALLOWED_LAYOUTS)
        },
        "tag_coverage": sorted({tag for case in cases for tag in case["tags"]}),
    }
