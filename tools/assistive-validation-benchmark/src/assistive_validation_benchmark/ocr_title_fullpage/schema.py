from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any


CORPUS_SCHEMA = "pp1-ocr-title-fullpage-corpus/v1"
PROTOCOL_SCHEMA = "pp1-ocr-title-fullpage-protocol/v1"
CAPTURE_SCHEMA = "pp1-ocr-title-fullpage-capture/v1"
ASSET_SUFFIX = {"png": ".png", "jpeg": ".jpg", "scanned_pdf": ".pdf"}
LAYOUTS = ("one_column", "two_column", "three_column")
REQUIRED_CALIBRATION_TAGS = frozenset(
    {
        "administrative_heading_above",
        "administrative_line_adjacent",
        "status_line_below",
        "subtitle_below",
        "ambiguous_headings",
        "branding_above",
        "multiline_title",
        "short_second_line",
        "repeated_title_in_body",
        "one_token_mismatch",
        "number_version_mismatch",
        "acronym_mismatch",
        "punctuation_variant",
        "case_variant",
        "hyphen_variant",
        "low_contrast",
        "jpeg_compression",
        "mild_noise",
        "small_title",
        "title_absent",
    }
)


def repository_root() -> Path:
    return Path(__file__).resolve().parents[5]


def tool_root() -> Path:
    return repository_root() / "tools" / "assistive-validation-benchmark"


def data_root() -> Path:
    return tool_root() / "ocr-title-fullpage-calibration"


def evidence_root() -> Path:
    return repository_root() / "docs" / "assistive-validation" / "evidence" / "ocr-title-fullpage-calibration"


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
    """Recompute every prospectively frozen contract term this iteration depends on."""
    if protocol.get("schema_version") != PROTOCOL_SCHEMA:
        raise ValueError("unsupported title-fullpage protocol")
    if protocol.get("phase") != "CALIBRATION_ONLY":
        raise ValueError("title-fullpage protocol is not calibration-only")
    candidate = protocol.get("candidate") or {}
    if (
        candidate.get("engine") != "paddle-small"
        or candidate.get("detection_model") != "PP-OCRv6_small_det"
        or candidate.get("recognition_model") != "PP-OCRv6_small_rec"
        or candidate.get("runtime")
        != {"paddleocr": "3.7.0", "paddlepaddle": "3.3.0", "paddlex": "3.7.2"}
    ):
        raise ValueError("title-fullpage protocol changed the reviewed model/runtime identity")
    fixed = protocol.get("fixed_configuration") or {}
    if fixed.get("page_scope") != "FULL_PAGE" or fixed.get("fast_region_ratio") is not None:
        raise ValueError("title-fullpage protocol must OCR the full page with no crop fast path")
    if (
        fixed.get("device") != "cpu"
        or fixed.get("raster_dpi") != 180
        or fixed.get("max_input_dimension") != 1920
        or fixed.get("enable_mkldnn") is not False
        or fixed.get("enable_hpi") is not False
        or fixed.get("worker_concurrency") != 1
    ):
        raise ValueError("title-fullpage fixed configuration changed")
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
        "cold_start_ms_maximum": 30000,
        "exact_title_rate_minimum": 1.0,
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
    if options.get("cpu_threads") != [None, 4, 8, 10]:
        raise ValueError("CPU thread candidate set changed")
    if options.get("page_scopes") != ["FULL_PAGE"]:
        raise ValueError("page scope candidate set changed")
    repeatability = protocol.get("repeatability") or {}
    if (
        repeatability.get("required_independent_repeats") != 3
        or repeatability.get("fresh_worker_process_per_repeat") is not True
        or repeatability.get("identical_corpus_across_repeats") is not True
        or repeatability.get("every_repeat_must_satisfy_calibration_margin") is not True
    ):
        raise ValueError("calibration repeatability contract changed")
    host_load = repeatability.get("host_load_control") or {}
    if (
        host_load.get("maximum_external_cpu_percent") != 25.0
        or host_load.get("sampling_interval_seconds") != 1.0
        or host_load.get("precondition_sample_seconds") != 5.0
        or host_load.get("precondition_maximum_wait_seconds") != 900.0
    ):
        raise ValueError("host load control changed")
    selection = protocol.get("selection_rule") or {}
    if selection.get("eligibility") != (
        "a candidate is eligible if and only if it satisfies every quality, safety, operational, "
        "security and provisioning requirement and the stronger calibration margin on every "
        "required repeat; eligibility never depends on whether a candidate contains an "
        "optimization feature"
    ):
        raise ValueError("candidate eligibility rule changed")
    if selection.get("preference") != [
        "lowest architectural complexity rank",
        "lowest worst-repeat p95",
        "lowest worst-repeat p50",
        "fewest effective CPU threads",
        "candidate identifier",
    ]:
        raise ValueError("candidate preference order changed")
    if selection.get("complexity_ranks") != {
        "backend_specific_acceleration": 3,
        "cropped_region_fast_path": 1,
        "full_page_single_pass": 0,
        "high_performance_inference_or_document_vlm": 4,
        "multi_pass_ocr": 2,
    }:
        raise ValueError("architectural complexity ranking changed")
    selector_policy = protocol.get("selector_policy") or {}
    if selector_policy.get("baseline_selector_id") != "top-band-group-prominence-v3@geometry":
        raise ValueError("selector policy baseline changed")
    if selector_policy.get("permitted_selector_ids") != [
        "top-band-group-prominence-v3@geometry",
        "top-band-typography-consistent-group-prominence-v4@geometry",
    ]:
        raise ValueError("permitted selector set changed")
    if selector_policy.get("decision_rule") != (
        "keep the merged baseline selector unless the new calibration corpus demonstrates a "
        "generalizable defect; otherwise adopt the smallest permitted alternative that removes it"
    ):
        raise ValueError("selector decision rule changed")
    if selector_policy.get("improvement_constraints") != [
        "geometry and typography evidence only",
        "metadata-blind during candidate extraction and ranking",
        "deterministic and explainable",
        "no case identifier, consumed holdout wording, project title or learned coordinate",
    ]:
        raise ValueError("selector improvement constraints changed")
    title = protocol.get("title_contract") or {}
    if title.get("metadata_blind_candidate_extraction") is not True or title.get("semantic_similarity_may_agree") is not False:
        raise ValueError("title contract changed")
    if title.get("outcomes") != ["AGREES", "REVIEW", "MISMATCH"]:
        raise ValueError("title outcome contract changed")
    return protocol


def validate_corpus(corpus: dict[str, Any]) -> dict[str, Any]:
    if corpus.get("schema_version") != CORPUS_SCHEMA or corpus.get("role") != "calibration":
        raise ValueError("unsupported title-fullpage corpus")
    cases = corpus.get("ocr_cases")
    if not isinstance(cases, list):
        raise ValueError("title-fullpage cases must be an array")
    scored = [case for case in cases if case.get("split") == "calibration"]
    warmups = [case for case in cases if case.get("split") == "warmup"]
    if len(scored) != 45 or len(warmups) != 1:
        raise ValueError("title-fullpage corpus requires 45 scored cases and one warmup")
    if len({case.get("id") for case in cases}) != len(cases):
        raise ValueError("title-fullpage case IDs are not unique")
    if any(case.get("media") not in ASSET_SUFFIX for case in cases):
        raise ValueError("title-fullpage corpus contains unsupported media")
    if sum(case.get("expected_consistency") == "INCONSISTENT" for case in scored) < 15:
        raise ValueError("title-fullpage corpus has fewer than fifteen inconsistent cases")
    cells = {(media, layout): 0 for media in ASSET_SUFFIX for layout in LAYOUTS}
    for case in scored:
        cells[(case["media"], case["layout"])] += 1
        if case.get("expected_visible_title") is not None and case.get("expected_visible_title") != case.get("poster_title"):
            raise ValueError("visible title truth differs from rendered poster title")
    if set(cells.values()) != {5}:
        raise ValueError("media and layout cells are not balanced")
    observed = {tag for case in scored for tag in case.get("tags", [])}
    if not REQUIRED_CALIBRATION_TAGS <= observed:
        raise ValueError("title-fullpage corpus lacks required title-difficulty coverage")
    return corpus
