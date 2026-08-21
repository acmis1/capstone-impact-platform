from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from pathlib import Path
from typing import Any


HEX_64 = re.compile(r"^[0-9a-f]{64}$")
CASE_ID = re.compile(r"^(?:ocr-(?:warmup|cal|hold)-[0-9]{3}|native-(?:cal|hold)-[0-9]{3})$")
ALLOWED_MEDIA = {"png", "jpeg", "scanned_pdf"}
ALLOWED_LAYOUTS = {"one_column", "two_column", "three_column"}


def tool_root() -> Path:
    return Path(__file__).resolve().parents[3]


def repository_root() -> Path:
    return tool_root().parents[1]


def data_root() -> Path:
    return tool_root() / "ocr-productionization"


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path.name} must contain one JSON object")
    return value


def canonical_json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n").encode("utf-8")


def value_sha256(value: Any) -> str:
    return hashlib.sha256(canonical_json_bytes(value)).hexdigest()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalized_content_hash(title: str, body: str) -> str:
    normalized = " ".join(unicodedata.normalize("NFKC", f"{title}\n{body}").casefold().split())
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def validate_protocol(value: dict[str, Any]) -> dict[str, Any]:
    if value.get("schema_version") != "pp1-ocr-productionization-protocol/v1":
        raise ValueError("unsupported OCR protocol schema")
    if value.get("benchmark_version") != "pp1-ocr-productionization-v1":
        raise ValueError("unexpected OCR benchmark version")
    gate = value.get("quality_gate", {})
    if gate.get("holdout_exact_title_recovery_minimum") != 0.95 or gate.get("holdout_mean_wer_maximum") != 0.12:
        raise ValueError("the complete OCR quality gate must remain 95% exact title and 12% WER")
    operational = value.get("operational_gate", {})
    for key in (
        "cold_start_ms_maximum",
        "holdout_p50_ms_maximum",
        "holdout_p95_ms_maximum",
        "peak_working_set_bytes_maximum",
        "artifact_footprint_bytes_maximum",
        "per_case_timeout_seconds",
    ):
        if not isinstance(operational.get(key), int) or operational[key] <= 0:
            raise ValueError(f"operational gate {key} must be a positive integer")
    if value.get("selection_contract", {}).get("production_integration_authorized") is not False:
        raise ValueError("benchmark protocol must not authorize production integration")
    return value


def validate_artifact_manifest(value: dict[str, Any], *, allow_unfrozen_trees: bool = False) -> dict[str, Any]:
    if value.get("schema_version") != "pp1-ocr-artifact-manifest/v1":
        raise ValueError("unsupported artifact manifest schema")
    runtime = value.get("runtime", {})
    if (
        runtime.get("paddleocr") != "3.7.0"
        or runtime.get("paddlepaddle_cpu") != "3.3.0"
        or runtime.get("paddlex_ocr_core") != "3.7.2"
    ):
        raise ValueError("Paddle runtime versions differ from the reviewed candidate")
    artifacts = value.get("artifacts")
    if not isinstance(artifacts, list) or len(artifacts) != 6:
        raise ValueError("artifact manifest must contain the six PP-OCRv6 det/rec archives")
    seen: set[str] = set()
    for artifact in artifacts:
        if not isinstance(artifact, dict) or set(artifact) != {
            "id", "model", "url", "archive_bytes", "archive_sha256", "tree_sha256", "layout"
        }:
            raise ValueError("artifact entries must use the closed v1 key set")
        artifact_id = artifact["id"]
        if artifact_id in seen or artifact["layout"] != artifact_id:
            raise ValueError("artifact IDs and layouts must be unique and identical")
        seen.add(artifact_id)
        if not str(artifact["url"]).startswith(
            "https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/"
        ):
            raise ValueError("model artifact is not from the frozen official Paddle source")
        if not isinstance(artifact["archive_bytes"], int) or artifact["archive_bytes"] <= 0:
            raise ValueError("artifact size is invalid")
        if not HEX_64.fullmatch(str(artifact["archive_sha256"])):
            raise ValueError("artifact archive hash is invalid")
        if artifact["tree_sha256"] == "TO_BE_FROZEN_AFTER_SAFE_EXTRACTION" and allow_unfrozen_trees:
            continue
        if not HEX_64.fullmatch(str(artifact["tree_sha256"])):
            raise ValueError("artifact extracted-tree hash is not frozen")
    return value


def validate_corpus_part(value: dict[str, Any], expected_part: str) -> dict[str, Any]:
    if value.get("schema_version") != "pp1-ocr-corpus-part/v1":
        raise ValueError("unsupported OCR corpus-part schema")
    if value.get("part") != expected_part or value.get("corpus_version") != "pp1-ocr-productionization-corpus-v1":
        raise ValueError("corpus part identity is invalid")
    if value.get("seed") != 2026082101:
        raise ValueError("corpus seed changed")
    cases = value.get("ocr_cases")
    controls = value.get("native_controls")
    security_controls = value.get("security_controls", [])
    if not isinstance(cases, list) or not isinstance(controls, list) or not isinstance(security_controls, list):
        raise ValueError("corpus part must contain OCR cases and native controls")
    ids: set[str] = set()
    for case in cases:
        required = {
            "id", "split", "asset", "media", "layout", "difficulty", "width", "height", "title",
            "metadata_title", "expected_agreement", "body", "title_style", "contrast", "noise",
            "jpeg_quality", "tags",
        }
        if not isinstance(case, dict) or set(case) != required:
            raise ValueError("OCR corpus case uses an unknown or missing field")
        case_id = case["id"]
        if not isinstance(case_id, str) or not CASE_ID.fullmatch(case_id) or case_id in ids:
            raise ValueError("OCR corpus case ID is invalid or duplicated")
        ids.add(case_id)
        expected_split = "calibration" if expected_part == "calibration" else "holdout"
        if case["split"] not in {expected_split, "warmup"} or (case["split"] == "warmup") != (case_id == "ocr-warmup-001"):
            raise ValueError("OCR corpus split is unstable")
        if case["media"] not in ALLOWED_MEDIA or case["layout"] not in ALLOWED_LAYOUTS:
            raise ValueError("OCR corpus media or layout is unsupported")
        suffix = {"png": ".png", "jpeg": ".jpg", "scanned_pdf": ".pdf"}[case["media"]]
        if case["asset"] != f"{case_id}{suffix}":
            raise ValueError("OCR case asset path is not deterministic")
        if case["difficulty"] not in {"clean", "challenging"}:
            raise ValueError("OCR case difficulty is invalid")
        if not 640 <= case["width"] <= 2400 or not 480 <= case["height"] <= 1800:
            raise ValueError("OCR case dimensions exceed the frozen corpus bounds")
        if not isinstance(case["expected_agreement"], bool):
            raise ValueError("title safety label must be boolean")
        if not 20 <= len(case["title"]) <= 120 or not 20 <= len(case["body"]) <= 1200:
            raise ValueError("OCR corpus text is outside its bounds")
        if not isinstance(case["tags"], list) or not all(isinstance(tag, str) for tag in case["tags"]):
            raise ValueError("OCR case tags are invalid")
    for control in controls:
        if not isinstance(control, dict) or set(control) != {"id", "split", "asset", "layout", "title", "body"}:
            raise ValueError("native control uses an unknown or missing field")
        if not CASE_ID.fullmatch(control["id"]) or control["id"] in ids or control["asset"] != f"{control['id']}.pdf":
            raise ValueError("native control identity is invalid")
        ids.add(control["id"])
    for control in security_controls:
        if not isinstance(control, dict) or set(control) != {"id", "split", "asset", "kind", "expected"}:
            raise ValueError("security control uses an unknown or missing field")
        if (
            not re.fullmatch(r"security-hold-[0-9]{3}", str(control["id"]))
            or control["id"] in ids
            or control["split"] != "security_control"
            or control["expected"] != "BOUNDED_REJECTION"
        ):
            raise ValueError("security control identity or expectation is invalid")
        suffix = {"malformed_pdf": ".pdf", "truncated_png": ".png"}.get(control["kind"])
        if suffix is None or control["asset"] != f"{control['id']}{suffix}":
            raise ValueError("security control kind or asset is invalid")
        ids.add(control["id"])
    return value


def corpus_manifest(calibration: dict[str, Any], holdout: dict[str, Any] | None) -> dict[str, Any]:
    return {
        "schema_version": "pp1-ocr-corpus-manifest/v1",
        "corpus_version": calibration["corpus_version"],
        "seed": calibration["seed"],
        "calibration": calibration,
        "holdout": holdout,
    }


def validate_combined_corpus(calibration: dict[str, Any], holdout: dict[str, Any] | None) -> dict[str, Any]:
    validate_corpus_part(calibration, "calibration")
    if holdout is None:
        return corpus_manifest(calibration, None)
    validate_corpus_part(holdout, "holdout")
    scored_calibration = [case for case in calibration["ocr_cases"] if case["split"] == "calibration"]
    scored_holdout = holdout["ocr_cases"]
    if len(scored_calibration) != 16 or len(scored_holdout) != 32:
        raise ValueError("frozen corpus must contain 16 calibration and 32 holdout OCR cases")
    cases = scored_calibration + scored_holdout
    if len({case["id"] for case in cases}) != len(cases):
        raise ValueError("calibration and holdout IDs overlap")
    for media in ALLOWED_MEDIA:
        if sum(case["media"] == media for case in scored_holdout) < 8:
            raise ValueError(f"holdout under-covers {media}")
    for layout in ALLOWED_LAYOUTS:
        if sum(case["layout"] == layout for case in scored_holdout) < 8:
            raise ValueError(f"holdout under-covers {layout}")
    if sum(case["difficulty"] == "challenging" for case in scored_holdout) < 16:
        raise ValueError("holdout must contain at least 16 challenging cases")
    if sum(not case["expected_agreement"] for case in scored_holdout) < 8:
        raise ValueError("holdout must contain at least eight material title negatives")
    security_controls = holdout.get("security_controls", [])
    if {control["kind"] for control in security_controls} != {"malformed_pdf", "truncated_png"}:
        raise ValueError("holdout must contain the two frozen malformed-file security controls")
    required_tags = {
        "low_resolution", "wrapped_title", "small_body_text", "contrast_variation", "compression",
        "mild_noise", "punctuation", "hyphen", "apostrophe", "numbers", "acronym",
        "australian_english", "technical_vocabulary", "near_character_confusion",
        "one_character_material_negative",
    }
    observed = {tag for case in cases for tag in case["tags"]}
    missing = required_tags - observed
    if missing:
        raise ValueError(f"combined corpus is missing coverage tags: {', '.join(sorted(missing))}")
    return corpus_manifest(calibration, holdout)


def prove_phase0_holdout_independence(new_manifest: dict[str, Any]) -> dict[str, int]:
    phase0 = load_json(tool_root() / "corpus" / "manifest.json")
    phase0_holdout = {
        normalized_content_hash(case.get("poster_title", ""), case.get("body", ""))
        for case in phase0.get("cases", [])
        if case.get("kind") == "document" and case.get("split") == "holdout"
    }
    new_cases = []
    for part in (new_manifest.get("calibration"), new_manifest.get("holdout")):
        if part:
            new_cases.extend(case for case in part["ocr_cases"] if case["split"] != "warmup")
    new_hashes = {normalized_content_hash(case["title"], case["body"]) for case in new_cases}
    overlap = phase0_holdout & new_hashes
    if overlap:
        raise ValueError("fresh OCR corpus reuses Phase 0 holdout title/body content")
    return {
        "phase0_holdout_cases_checked": len(phase0_holdout),
        "new_scored_cases_checked": len(new_hashes),
        "reused_cases": 0,
    }
