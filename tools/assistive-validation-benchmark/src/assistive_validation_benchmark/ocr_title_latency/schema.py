from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any


CORPUS_SCHEMA = "pp1-ocr-title-latency-corpus/v1"
PROTOCOL_SCHEMA = "pp1-ocr-title-latency-protocol/v1"
CAPTURE_SCHEMA = "pp1-ocr-title-latency-capture/v1"
ASSET_SUFFIX = {"png": ".png", "jpeg": ".jpg", "scanned_pdf": ".pdf"}


def repository_root() -> Path:
    return Path(__file__).resolve().parents[5]


def tool_root() -> Path:
    return repository_root() / "tools" / "assistive-validation-benchmark"


def data_root() -> Path:
    return tool_root() / "ocr-title-latency-calibration"


def evidence_root() -> Path:
    return repository_root() / "docs" / "assistive-validation" / "evidence" / "ocr-title-latency-calibration"


def canonical_json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def value_sha256(value: Any) -> str:
    return hashlib.sha256(canonical_json_bytes(value)).hexdigest()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"expected a JSON object: {path}")
    return value


def validate_protocol(protocol: dict[str, Any]) -> dict[str, Any]:
    if protocol.get("schema_version") != PROTOCOL_SCHEMA:
        raise ValueError("unsupported title-latency protocol")
    if protocol.get("phase") != "CALIBRATION_ONLY":
        raise ValueError("title-latency protocol is not calibration-only")
    candidate = protocol.get("candidate") or {}
    if (
        candidate.get("engine") != "paddle-small"
        or candidate.get("detection_model") != "PP-OCRv6_small_det"
        or candidate.get("recognition_model") != "PP-OCRv6_small_rec"
        or candidate.get("runtime")
        != {"paddleocr": "3.7.0", "paddlepaddle": "3.3.0", "paddlex": "3.7.2"}
    ):
        raise ValueError("title-latency protocol changed the reviewed model/runtime identity")
    if protocol.get("quality_gates") != {
        "all_scored_cases_must_execute": True,
        "automatic_agreement_precision_target": 1.0,
        "exact_title_rate_minimum": 0.95,
        "inconsistency_precision_minimum": 0.98,
        "inconsistency_recall_minimum": 0.95,
        "material_false_automatic_agreements_maximum": 0,
    }:
        raise ValueError("final title quality gates changed")
    if protocol.get("calibration_margin") != {
        "automatic_agreement_precision_target": 1.0,
        "exact_title_rate_minimum": 1.0,
        "false_fast_path_acceptances_maximum": 0,
        "inconsistency_precision_minimum": 1.0,
        "inconsistency_recall_minimum": 1.0,
        "material_false_automatic_agreements_maximum": 0,
        "p50_ms_maximum": 7500,
        "p95_ms_maximum": 15000,
    }:
        raise ValueError("calibration margin changed")
    if protocol.get("operational_gates") != {
        "artifact_footprint_bytes_maximum": 1073741824,
        "cold_start_ms_maximum": 30000,
        "p50_ms_maximum": 10000,
        "p95_ms_maximum": 20000,
        "peak_working_set_bytes_maximum": 4294967296,
        "per_case_timeout_seconds": 90,
        "worker_concurrency_maximum": 1,
    }:
        raise ValueError("operational gates changed")
    options = protocol.get("bounded_options") or {}
    if options.get("cpu_threads") != [4, 8, 10, 12]:
        raise ValueError("CPU thread candidate set changed")
    if options.get("fast_region_ratios") != [0.3, 0.36]:
        raise ValueError("fast-region candidate set changed")
    if options.get("raster_dimensions") != [1920, 1600, 1440]:
        raise ValueError("raster candidate set changed")
    if protocol.get("fast_path_contract") != {
        "policy": "top-image-region-first-with-metadata-blind-credibility-and-full-page-fallback/v1",
        "minimum_candidate_prominence": 30.0,
        "minimum_recognition_confidence": 0.9,
        "crop_boundary_margin_pixels": 4,
        "ambiguity_prominence_ratio": 0.82,
        "minimum_tokens": 2,
        "maximum_tokens": 14,
        "reject_all_uppercase_candidate": True,
        "reject_any_prominent_uppercase_candidate": True,
        "fallback": "normal full-page PP-OCRv6 Small using the same model/runtime configuration",
    }:
        raise ValueError("fast-path credibility or fallback contract changed")
    return protocol


def validate_corpus(corpus: dict[str, Any]) -> dict[str, Any]:
    if corpus.get("schema_version") != CORPUS_SCHEMA or corpus.get("role") != "calibration":
        raise ValueError("unsupported title-latency corpus")
    cases = corpus.get("ocr_cases")
    if not isinstance(cases, list):
        raise ValueError("title-latency cases must be an array")
    scored = [case for case in cases if case.get("split") == "calibration"]
    warmups = [case for case in cases if case.get("split") == "warmup"]
    if len(scored) != 36 or len(warmups) != 1:
        raise ValueError("title-latency corpus requires 36 scored cases and one warmup")
    if len({case.get("id") for case in cases}) != len(cases):
        raise ValueError("title-latency case IDs are not unique")
    if any(case.get("media") not in ASSET_SUFFIX for case in cases):
        raise ValueError("title-latency corpus contains unsupported media")
    if sum(case.get("expected_consistency") == "INCONSISTENT" for case in scored) < 12:
        raise ValueError("title-latency corpus has fewer than one-third inconsistent cases")
    cells = {(media, layout): 0 for media in ASSET_SUFFIX for layout in ("one_column", "two_column", "three_column")}
    for case in scored:
        cells[(case["media"], case["layout"])] += 1
        if case.get("expected_visible_title") is not None and case.get("expected_visible_title") != case.get("poster_title"):
            raise ValueError("visible title truth differs from rendered poster title")
    if set(cells.values()) != {4}:
        raise ValueError("media and layout cells are not balanced")
    required_tags = {
        "title_unusually_low", "title_beside_logo", "administrative_heading", "title_starts_outside_crop",
        "multiline_title", "crop_distractor", "title_absent", "ambiguous_title", "low_contrast",
        "wrapped_title", "stylized_title", "small_title", "punctuation_variant", "acronym_mismatch",
    }
    observed_tags = {tag for case in scored for tag in case.get("tags", [])}
    if not required_tags <= observed_tags:
        raise ValueError("title-latency corpus lacks required fast-path fallback coverage")
    return corpus
