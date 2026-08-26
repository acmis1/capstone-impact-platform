from __future__ import annotations

import hashlib
import json
import unicodedata
from pathlib import Path
from typing import Any


CORPUS_SCHEMA = "pp1-ocr-title-consistency-corpus/v1"
PROTOCOL_SCHEMA = "pp1-ocr-title-consistency-protocol/v1"
ASSET_SUFFIX = {"png": ".png", "jpeg": ".jpg", "scanned_pdf": ".pdf"}


def repository_root() -> Path:
    return Path(__file__).resolve().parents[5]


def tool_root() -> Path:
    return repository_root() / "tools" / "assistive-validation-benchmark"


def calibration_data_root() -> Path:
    return tool_root() / "ocr-title-consistency-calibration"


def calibration_evidence_root() -> Path:
    return repository_root() / "docs" / "assistive-validation" / "evidence" / "ocr-title-consistency-calibration"


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
        raise ValueError(f"expected a JSON object: {path.name}")
    return value


def normalize_identity_text(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def validate_protocol(protocol: dict[str, Any]) -> dict[str, Any]:
    if protocol.get("schema_version") != PROTOCOL_SCHEMA:
        raise ValueError("unsupported title-consistency protocol")
    if protocol.get("phase") != "FROZEN_TITLE_CANDIDATE":
        raise ValueError("title-consistency candidate is not frozen")
    candidate = protocol.get("candidate") or {}
    if (
        candidate.get("engine") != "paddle-small"
        or candidate.get("detection_model") != "PP-OCRv6_small_det"
        or candidate.get("recognition_model") != "PP-OCRv6_small_rec"
        or candidate.get("runtime")
        != {"paddleocr": "3.7.0", "paddlepaddle": "3.3.0", "paddlex": "3.7.2"}
    ):
        raise ValueError("title protocol changed the reviewed PP-OCRv6 Small identity")
    configuration = protocol.get("configuration") or {}
    if configuration != {
        "device": "cpu",
        "raster_dpi": 180,
        "max_input_dimension": 1920,
        "enable_mkldnn": False,
        "use_doc_orientation_classify": False,
        "use_doc_unwarping": False,
        "use_textline_orientation": False,
        "worker_concurrency": 1,
    }:
        raise ValueError("title protocol changed the reviewed runtime configuration")
    gates = protocol.get("quality_gates") or {}
    required_gates = {
        "exact_title_rate_minimum": 0.95,
        "inconsistency_precision_minimum": 0.98,
        "inconsistency_recall_minimum": 0.95,
        "material_false_automatic_agreements_maximum": 0,
        "automatic_agreement_precision_target": 1.0,
        "all_scored_cases_must_execute": True,
    }
    if gates != required_gates:
        raise ValueError("title-specific quality gates differ from the prospective contract")
    margin = protocol.get("calibration_margin") or {}
    if margin != {
        "exact_title_rate_minimum": 1.0,
        "inconsistency_precision_minimum": 1.0,
        "inconsistency_recall_minimum": 1.0,
        "material_false_automatic_agreements_maximum": 0,
    }:
        raise ValueError("calibration margin differs from the prospective contract")
    operational = protocol.get("operational_gates") or {}
    if operational != {
        "worker_concurrency_maximum": 1,
        "cold_start_ms_maximum": 30000,
        "p50_ms_maximum": 10000,
        "p95_ms_maximum": 20000,
        "peak_working_set_bytes_maximum": 4294967296,
        "artifact_footprint_bytes_maximum": 1073741824,
        "per_case_timeout_seconds": 90,
    }:
        raise ValueError("operational gates differ from the prospective contract")
    if protocol.get("scope", {}).get("body_wer_role") != "DIAGNOSTIC_NON_GATING":
        raise ValueError("body WER must remain diagnostic only")
    return protocol


def validate_corpus(corpus: dict[str, Any], *, expected_split: str, expected_count: int) -> dict[str, Any]:
    if corpus.get("schema_version") != CORPUS_SCHEMA or corpus.get("role") != expected_split:
        raise ValueError("unsupported title-consistency corpus")
    cases = corpus.get("ocr_cases")
    if not isinstance(cases, list):
        raise ValueError("title corpus cases must be an array")
    scored = [case for case in cases if case.get("split") == expected_split]
    warmups = [case for case in cases if case.get("split") == "warmup"]
    if len(scored) != expected_count or len(warmups) != 1:
        raise ValueError("title corpus has the wrong scored or warmup count")
    if len({case.get("id") for case in cases}) != len(cases):
        raise ValueError("title corpus case identities are not unique")
    if any(case.get("media") not in ASSET_SUFFIX for case in cases):
        raise ValueError("title corpus contains unsupported media")
    if any(case.get("expected_consistency") not in {"CONSISTENT", "INCONSISTENT"} for case in scored):
        raise ValueError("title corpus has an invalid consistency label")
    if sum(case["expected_consistency"] == "INCONSISTENT" for case in scored) < expected_count // 3:
        raise ValueError("title corpus has insufficient inconsistent-title coverage")
    for case in scored:
        expected = case.get("expected_visible_title")
        poster = case.get("poster_title")
        if expected is not None and expected != poster:
            raise ValueError("visible-title truth must equal the labelled poster title")
        if case.get("title_render_mode") == "absent" and poster is not None:
            raise ValueError("title-absent case unexpectedly contains a poster title")
    return corpus
