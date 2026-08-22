"""Frozen Iteration 2 holdout-protocol contract, hashing helpers and the no-holdout guard.

Every constant here is a freeze, not a default. ``validate_protocol`` refuses a protocol file
that weakens a gate, adds a second OCR candidate, reopens model selection, permits per-page
metric switching or claims that a holdout exists. ``assert_no_holdout_content`` is the hard
guard that keeps this branch protocol-only: it fails if any holdout case, asset, capture,
metric or production selection appears anywhere in the frozen tree.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any


HEX_64 = re.compile(r"^[0-9a-f]{64}$")

# The future holdout ID namespace is frozen as a pattern with zero instances. Instantiating any
# matching ID in this branch is a hard failure, not a warning.
HOLDOUT_CASE_ID_PATTERN = r"^ocr2h-[0-9]{3}$"
HOLDOUT_CASE_ID = re.compile(HOLDOUT_CASE_ID_PATTERN)

FROZEN_CANDIDATE_ENGINE = "paddle-small"
FROZEN_DETECTION_ARTIFACT = "PP-OCRv6_small_det_infer"
FROZEN_RECOGNITION_ARTIFACT = "PP-OCRv6_small_rec_infer"
FROZEN_RUNTIME = {
    "paddleocr": "3.7.0",
    "paddlepaddle_cpu": "3.3.0",
    "paddlex_ocr_core": "3.7.2",
}
FROZEN_RASTER_DPI = 180
FROZEN_MAX_INPUT_DIMENSION = 1920
FROZEN_SELECTOR_ID = "top_band_prominence@geometry"
FROZEN_SELECTOR = "top_band_prominence"
FROZEN_SELECTOR_ORDER = "geometry"
FROZEN_PRIMARY_READING_ORDER = "column"
FROZEN_DIAGNOSTIC_READING_ORDERS = ["raw", "geometry"]
DEVELOPMENT_EVIDENCE_COMMIT_SHA = "02dd8522cec6ec6e7a70a8ff9d886de0787ab092"

SCORED_CASE_COUNT = 40
FROZEN_QUALITY_GATE = {
    "exact_title_rate_minimum": 0.95,
    "primary_mean_wer_maximum": 0.12,
    "material_false_agreements_maximum": 0,
    "minimum_exact_titles": 38,
    "scored_case_count": SCORED_CASE_COUNT,
}
FROZEN_OPERATIONAL_CEILINGS = {
    "cold_start_ms_maximum": 30000,
    "p50_ms_maximum": 10000,
    "p95_ms_maximum": 20000,
    "peak_working_set_bytes_maximum": 4294967296,
    "artifact_footprint_bytes_maximum": 1073741824,
    "per_case_timeout_seconds": 90,
}
FROZEN_WORKER_SAFETY_CEILINGS = {
    "max_raster_dpi": 200,
    "max_raster_pixels_per_page": 40000000,
    "max_total_raster_pixels": 80000000,
    "max_extracted_characters": 100000,
    "max_text_blocks": 5000,
}
ALLOWED_DECISIONS = {
    "READY_FOR_OCR_PROVIDER_INTEGRATION",
    "OCR_PROVIDER_DEFERRED",
    "HOLDOUT_INVALID_PROTOCOL_BUG",
}
REQUIRED_DISTRACTOR_KINDS = {
    "school_or_faculty_masthead",
    "program_name",
    "discipline",
    "unit_or_course_code",
    "year_or_date",
    "supervisor_label",
    "category_or_tag",
    "event_or_showcase_heading",
    "team_label",
}
REQUIRED_NEGATIVE_KINDS = {
    "one_character_material",
    "one_word_material",
    "semantically_related_incorrect",
    "number_or_version",
}
FORBIDDEN_ADDITIONAL_CANDIDATES = {
    "paddle-tiny",
    "paddle-medium",
    "rapidocr",
    "doctr",
    "surya",
    "paddleocr-vl",
    "qwen",
    "gemini",
    "llm",
    "vlm",
    "cloud-ocr",
}
REQUIRED_REPORTED_METRICS = {
    "title_exact_count",
    "assistive_title_result",
    "equality_precision_recall",
    "assistive_precision_recall",
    "provider_raw_wer",
    "clean_wer",
    "challenging_wer",
    "media_breakdown",
    "layout_breakdown",
}
REQUIRED_TITLE_TEXT_COVERAGE = {
    "single_line",
    "wrapped_multi_line",
    "punctuation",
    "hyphen_and_dash_variants",
    "numbers_and_acronyms",
    "australian_english",
    "technical_vocabulary",
    "accented_latin",
    "curly_punctuation",
    "subscripts",
}
SELECT_GATE_FAMILIES = {"quality", "title_safety", "operational", "provisioning", "offline_security"}


def tool_root() -> Path:
    return Path(__file__).resolve().parents[3]


def repository_root() -> Path:
    return tool_root().parents[1]


def data_root() -> Path:
    return tool_root() / "ocr-iteration2-holdout-protocol"


def package_root() -> Path:
    return Path(__file__).resolve().parent


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path.name} must contain one JSON object")
    return value


def canonical_json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n").encode("utf-8")


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalized_text_file_sha256(path: Path) -> str:
    """Hash tracked text as LF so a Windows CRLF checkout cannot change freeze identity."""
    return hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest()


def value_sha256(value: Any) -> str:
    return hashlib.sha256(canonical_json_bytes(value)).hexdigest()


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def _minimum(value: dict[str, Any], key: str, floor: int) -> None:
    _require(isinstance(value.get(key), int) and value[key] >= floor, f"{key} must be at least {floor}")


def _validate_candidate(value: dict[str, Any]) -> None:
    candidate = value.get("candidate", {})
    _require(candidate.get("engine") == FROZEN_CANDIDATE_ENGINE, "the frozen holdout candidate must be PP-OCRv6 Small")
    _require(
        candidate.get("family") == "PP-OCRv6" and candidate.get("variant") == "small",
        "candidate model family or variant changed",
    )
    _require(
        candidate.get("detection_artifact") == FROZEN_DETECTION_ARTIFACT
        and candidate.get("recognition_artifact") == FROZEN_RECOGNITION_ARTIFACT,
        "candidate detection/recognition artifact identity changed",
    )
    for key in (
        "detection_archive_sha256",
        "recognition_archive_sha256",
        "detection_tree_sha256",
        "recognition_tree_sha256",
    ):
        _require(bool(HEX_64.fullmatch(str(candidate.get(key)))), f"candidate {key} is not a frozen SHA-256")
    _require(candidate.get("runtime") == FROZEN_RUNTIME, "candidate runtime versions differ from the reviewed environment")
    _require(candidate.get("device") == "cpu", "the frozen candidate must run on CPU")
    for key in ("enable_mkldnn", "use_doc_orientation_classify", "use_doc_unwarping", "use_textline_orientation"):
        _require(candidate.get(key) is False, f"candidate {key} must stay disabled as benchmarked")
    _require(candidate.get("license") == "Apache-2.0", "candidate license identity changed")
    _minimum(candidate, "artifact_footprint_bytes", 1)
    _require(
        candidate["artifact_footprint_bytes"] <= FROZEN_OPERATIONAL_CEILINGS["artifact_footprint_bytes_maximum"],
        "candidate footprint exceeds the frozen artifact ceiling",
    )
    provisioning = candidate.get("offline_provisioning", {})
    _require(provisioning.get("runtime_download_during_holdout") is False, "the holdout run may not download models")
    _require(provisioning.get("network_disabled_during_run") is True, "the holdout run must execute behind the offline guard")
    _require(
        provisioning.get("official_host_allowlist") == ["paddle-model-ecology.bj.bcebos.com"],
        "model provisioning host allowlist changed",
    )
    _require(
        value.get("additional_candidates") == [],
        "the fresh holdout tests one calibration-selected challenger; model selection stays closed",
    )
    declared = {str(item).casefold() for item in value.get("candidates", [])}
    _require(declared == {FROZEN_CANDIDATE_ENGINE}, "only the calibration-selected challenger may enter the fresh holdout")
    _require(
        not (FORBIDDEN_ADDITIONAL_CANDIDATES & declared),
        "no additional OCR, LLM, VLM or cloud candidate may enter the fresh holdout",
    )


def _validate_raster(value: dict[str, Any]) -> None:
    raster = value.get("raster_contract", {})
    _require(raster.get("raster_dpi") == FROZEN_RASTER_DPI, "the frozen scanned-PDF raster DPI changed")
    _require(raster.get("max_input_dimension") == FROZEN_MAX_INPUT_DIMENSION, "the frozen maximum long edge changed")
    for key in ("aspect_preserving", "applies_to_every_scored_case"):
        _require(raster.get(key) is True, f"raster contract {key} must remain true")
    for key in (
        "crop_permitted",
        "upscaling_permitted",
        "label_guided_preprocessing_permitted",
        "per_case_switching_permitted",
    ):
        _require(raster.get(key) is False, f"raster contract {key} must remain false")
    ceilings = value.get("worker_safety_ceilings", {})
    _require(ceilings == FROZEN_WORKER_SAFETY_CEILINGS, "existing worker safety ceilings must remain authoritative")
    _require(raster["raster_dpi"] <= ceilings["max_raster_dpi"], "raster DPI exceeds the production worker ceiling")
    _require(
        raster["max_input_dimension"] ** 2 <= ceilings["max_raster_pixels_per_page"],
        "raster long edge exceeds the production worker pixel ceiling",
    )


def _validate_title_and_wer(value: dict[str, Any]) -> None:
    title = value.get("title_contract", {})
    _require(title.get("selector_id") == FROZEN_SELECTOR_ID, "the frozen title selector changed")
    _require(
        title.get("selector") == FROZEN_SELECTOR and title.get("order") == FROZEN_SELECTOR_ORDER,
        "frozen selector composition changed",
    )
    _require(
        title.get("metadata_blind") is True and title.get("ground_truth_in_selection") is False,
        "title candidate selection must stay metadata and ground-truth blind",
    )
    _require(
        title.get("semantic_similarity_may_create_automatic_agreement") is False,
        "semantic relatedness may never convert a material mismatch into automatic agreement",
    )
    _require(title.get("negative_metadata_titles_required") is True, "the holdout must test material title negatives")
    _require(
        title.get("selection_evidence")
        == "docs/assistive-validation/evidence/ocr-productionization-iteration2-distractor-calibration.json",
        "the corrected selector must remain bound to the exposed development evidence",
    )
    for key in ("selector_source", "order_source", "normalization_source", "safety_source"):
        _require(isinstance(title.get(key), str) and title[key], f"title contract {key} must name a frozen source file")
    wer = value.get("wer_contract", {})
    _require(wer.get("primary_order") == FROZEN_PRIMARY_READING_ORDER, "the primary holdout reading order changed")
    _require(
        wer.get("required_diagnostic_orders") == FROZEN_DIAGNOSTIC_READING_ORDERS,
        "the required diagnostic reading orders changed",
    )
    _require(wer.get("applies_to_every_scored_page") is True, "the primary order must apply to every scored page")
    _require(
        wer.get("reference_scope") == "all_intentionally_rendered_semantic_text"
        and wer.get("reference_text_includes_upper_page_distractors") is True,
        "whole-page WER must include every intentionally rendered semantic string",
    )
    _require(
        wer.get("reference_visual_order")
        == [
            "above_title_distractors",
            "project_title",
            "near_title_distractors",
            "section_headings_and_body_in_frozen_column_order",
        ],
        "the full-visible-text WER reference order changed",
    )
    for key in (
        "per_page_order_selection_permitted",
        "ground_truth_order_selection_permitted",
        "best_of_oracle_primary_permitted",
        "wer_driven_order_switching_permitted",
    ):
        _require(wer.get(key) is False, f"WER contract {key} must remain false")
    for key in ("ordering_source", "metric_source", "reference_source"):
        _require(isinstance(wer.get(key), str) and wer[key], f"WER contract {key} must name a frozen source file")


def _validate_gates(value: dict[str, Any]) -> None:
    _require(value.get("quality_gate") == FROZEN_QUALITY_GATE, "the fresh-holdout quality gate may not be weakened")
    operational = value.get("operational_gate", {})
    _require(operational.get("ceilings") == FROZEN_OPERATIONAL_CEILINGS, "the frozen operational ceilings may not be loosened")
    _require(
        operational.get("parts") == ["historical_operational_prior", "holdout_run_current_configuration"],
        "the two-part operational model established by the merged calibration must be preserved",
    )
    for key in ("recompute_from_raw_measurements_required", "faster_machine_cannot_clear_failing_prior"):
        _require(operational.get(key) is True, f"operational gate {key} must remain true")
    _require(
        operational.get("stored_boolean_override_permitted") is False,
        "stored booleans may never override raw measured operational evidence",
    )
    _require(
        isinstance(operational.get("implementation_source"), str) and operational["implementation_source"],
        "the operational gate must name its frozen implementation source",
    )
    metrics = set(value.get("required_reported_metrics", []))
    _require(
        REQUIRED_REPORTED_METRICS <= metrics,
        f"required reported metrics are incomplete: {sorted(REQUIRED_REPORTED_METRICS - metrics)}",
    )


def _validate_distribution(value: dict[str, Any]) -> None:
    distribution = value.get("holdout_distribution", {})
    _require(distribution.get("scored_case_count") == SCORED_CASE_COUNT, "the frozen scored holdout size changed")
    _require(distribution.get("difficulty") == {"clean": 20, "challenging": 20}, "the frozen clean/challenging split changed")
    media = distribution.get("media", {})
    layout = distribution.get("layout", {})
    _require(set(media) == {"png", "jpeg", "scanned_pdf"}, "holdout media coverage is incomplete")
    _require(set(layout) == {"one_column", "two_column", "three_column"}, "holdout layout coverage is incomplete")
    _require(sum(media.values()) == SCORED_CASE_COUNT, "media targets do not sum to the scored case count")
    _require(sum(layout.values()) == SCORED_CASE_COUNT, "layout targets do not sum to the scored case count")
    _require(min(media.values()) >= 13 and min(layout.values()) >= 13, "media and layout must stay reasonably balanced")
    _minimum(distribution, "minimum_cases_per_media_difficulty_cell", 6)
    _minimum(distribution, "minimum_cases_per_layout_difficulty_cell", 6)
    _require(
        distribution.get("allocation_rule_fixed_before_content") is True,
        "the deterministic allocation rule must be fixed before any case content exists",
    )


def _validate_generalisation(value: dict[str, Any]) -> None:
    distractors = value.get("upper_page_distractors", {})
    _minimum(distractors, "cases_with_any_distractor_minimum", 32)
    _minimum(distractors, "cases_with_distractor_above_title_minimum", 32)
    _minimum(distractors, "cases_with_distractor_near_title_minimum", 16)
    _minimum(distractors, "cases_with_both_above_and_near_minimum", 8)
    topmost = distractors.get("cases_with_title_as_topmost_region_maximum")
    _require(
        isinstance(topmost, int) and 0 <= topmost <= 8,
        "the project title may not be the topmost region on more than eight scored cases",
    )
    _require(
        distractors["cases_with_distractor_above_title_minimum"] + topmost <= SCORED_CASE_COUNT,
        "distractor prevalence and the topmost-title allowance are mutually inconsistent",
    )
    kinds = distractors.get("required_kinds", {})
    _require(set(kinds) == REQUIRED_DISTRACTOR_KINDS, "the required upper-page distractor kinds changed")
    _require(
        all(isinstance(count, int) and count >= 3 for count in kinds.values()),
        "every distractor kind must appear on at least three scored cases",
    )
    _require(
        distractors.get("selector_tuned_against_these_cases") is False,
        "the frozen selector may never be tuned against the future distractor cases",
    )
    _require(
        distractors.get("distractor_text_is_reference_text") is True,
        "visible distractor text must remain part of whole-page OCR reference text",
    )
    styles = value.get("title_style_coverage", {})
    _minimum(styles, "plain_minimum", 20)
    _minimum(styles, "wrapped_minimum", 6)
    _minimum(styles, "tracked_minimum", 3)
    _minimum(styles, "shadow_minimum", 3)
    outlined = styles.get("outlined_maximum")
    _require(isinstance(outlined, int) and 0 < outlined <= 2, "an outlined title must stay an explicit minority style")
    _require(styles["plain_minimum"] * 2 >= SCORED_CASE_COUNT, "ordinary unstroked titles must remain the majority")
    _require(styles.get("artificial_stroke_on_every_title") is False, "the v1 all-stroked-title artifact may not return")
    _require(
        styles.get("tracking_is_visual_only") is True and styles.get("semantic_string_mutation_permitted") is False,
        "visual tracking must never mutate the semantic title string",
    )
    _require(styles.get("tracking_px_bounds") == [0, 4], "visual glyph tracking must stay inside the reviewed pixel range")
    coverage = set(value.get("title_text_coverage", []))
    _require(
        REQUIRED_TITLE_TEXT_COVERAGE <= coverage,
        f"title text coverage is incomplete: {sorted(REQUIRED_TITLE_TEXT_COVERAGE - coverage)}",
    )
    degradation = value.get("degradation_coverage", {})
    for key, floor in (
        ("low_resolution_minimum", 6),
        ("moderate_compression_minimum", 6),
        ("mild_noise_minimum", 6),
        ("medium_or_low_contrast_minimum", 8),
        ("small_body_text_minimum", 6),
    ):
        _minimum(degradation, key, floor)


def _validate_negatives_and_controls(value: dict[str, Any]) -> None:
    negatives = value.get("material_title_negatives", {})
    _minimum(negatives, "minimum_scored_cases", 8)
    kinds = negatives.get("required_kinds", {})
    _require(set(kinds) == REQUIRED_NEGATIVE_KINDS, "material title negative coverage changed")
    _require(
        all(isinstance(count, int) and count >= 2 for count in kinds.values()),
        "every material negative kind needs at least two scored cases",
    )
    _minimum(negatives, "punctuation_only_non_material_controls_minimum", 2)
    _require(
        negatives.get("semantic_relatedness_may_produce_automatic_agreement") is False,
        "semantic relatedness may never turn a material mismatch into automatic agreement",
    )
    _require(
        negatives.get("relationship_contract")
        == {
            "metric_normalization_source": "src/assistive_validation_benchmark/ocr_productionization/title_safety.py",
            "production_normalization_source": "src/assistive_validation_benchmark/ocr_productionization/title_safety.py",
            "edit_distance_source": "src/assistive_validation_benchmark/core.py",
            "unlabelled_agreement_normalized_equality_required": True,
            "material_normalized_difference_required": True,
            "punctuation_only_raw_difference_required": True,
            "punctuation_only_normalized_equality_required": True,
            "one_character_metric_edit_distance": 1,
            "one_word_metric_token_edit_distance": 1,
            "one_word_excludes_one_character_and_number_version": True,
            "number_version_non_number_tokens_identical": True,
            "semantic_relation_authority": "human_ground_truth",
            "semantic_relation_rationale_required": True,
            "classified_before_ocr_required": True,
            "semantic_relation_evidence_only": True,
            "relation_evidence_enters_measurement_runtime": False,
        },
        "the material-negative relationship contract changed",
    )
    controls = value.get("controls", {})
    _minimum(controls, "native_pdf_control_minimum", 3)
    _minimum(controls, "security_control_minimum", 2)
    _require(controls.get("unscored_warmup_count") == 1, "the protocol must keep exactly one unscored warm-up")
    _require(
        controls.get("counted_toward_ocr_quality_rates") is False,
        "controls stay separate from the forty scored OCR-required cases",
    )
    freshness = value.get("corpus_freshness_rule", {})
    for key in (
        "no_phase0_title_body_reuse",
        "no_v1_productionization_title_body_reuse",
        "no_iteration2_calibration_title_body_reuse",
        "no_real_participant_or_project_data",
    ):
        _require(freshness.get(key) is True, f"corpus freshness rule {key} must remain required")
    _require(
        freshness.get("evidence_name") == "fresh_holdout_non_reuse_independence_evidence",
        "the fresh holdout non-reuse evidence name changed",
    )


def _validate_decision_and_future(value: dict[str, Any]) -> None:
    decision = value.get("decision_contract", {})
    _require(set(decision.get("allowed_decisions", [])) == ALLOWED_DECISIONS, "the holdout decision contract changed")
    _require(
        decision.get("select_requires_all_gates") is True and decision.get("near_miss_may_select") is False,
        "a near miss may never become a production selection",
    )
    _require(set(decision.get("select_gate_families", [])) == SELECT_GATE_FAMILIES, "the SELECT gate families changed")
    future = value.get("future_run_contract", {})
    _require(future.get("branch_starts_from_merged_freeze_commit") is True, "2B3 must start from the merged freeze commit")
    _require(
        future.get("holdout_runs") == 1 and future.get("post_result_tuning_permitted") is False,
        "the one-shot, no-post-result-tuning rule changed",
    )
    steps = future.get("ordered_steps")
    _require(isinstance(steps, list) and len(steps) == 12, "the future 2B3 procedure must remain the twelve frozen steps")
    supersession = future.get("protocol_bug_supersession", {})
    for key in (
        "preserve_exposed_result",
        "mark_superseded_with_reason",
        "fix_protocol_in_later_version",
        "generate_new_fresh_holdout",
    ):
        _require(supersession.get(key) is True, f"supersession rule {key} must remain required")
    _require(
        supersession.get("retune_and_rerun_same_holdout_permitted") is False,
        "an exposed holdout may never be tuned against and rerun as though independent",
    )


def validate_protocol(value: dict[str, Any]) -> dict[str, Any]:
    from . import PROTOCOL_VERSION, SCHEMA_VERSION

    _require(value.get("schema_version") == SCHEMA_VERSION, "unsupported Iteration 2 holdout protocol schema")
    _require(value.get("protocol_version") == PROTOCOL_VERSION, "Iteration 2 holdout protocol identity changed")
    _require(value.get("measurement_role") == "protocol_freeze_only", "this protocol may only freeze; it may not measure")
    for key in ("holdout_created", "holdout_measurement_exists", "production_selection_authorized", "ocr_executed"):
        _require(value.get(key) is False, f"the freeze branch must keep {key} false")
    _require(value.get("holdout_case_id_pattern") == HOLDOUT_CASE_ID_PATTERN, "the future holdout ID namespace changed")
    _require(value.get("instantiated_holdout_case_ids") == [], "no future holdout case ID may be instantiated here")
    _require(
        value.get("content_policy") == "synthetic_or_explicitly_deidentified_only",
        "the synthetic-only content policy changed",
    )
    _validate_candidate(value)
    _validate_raster(value)
    _validate_title_and_wer(value)
    _validate_gates(value)
    _validate_distribution(value)
    _validate_generalisation(value)
    _validate_negatives_and_controls(value)
    _validate_decision_and_future(value)
    historical = value.get("historical_evidence_sha256")
    _require(isinstance(historical, dict) and len(historical) >= 6, "the historical evidence binding is incomplete")
    for relative, digest in historical.items():
        _require(bool(HEX_64.fullmatch(str(digest))), f"historical evidence hash is invalid: {relative}")
    development = value.get("development_evidence_sha256")
    _require(
        isinstance(development, dict)
        and set(development)
        == {"docs/assistive-validation/evidence/ocr-productionization-iteration2-distractor-calibration.json"},
        "the development correction evidence binding is incomplete",
    )
    for relative, digest in development.items():
        _require(bool(HEX_64.fullmatch(str(digest))), f"development evidence hash is invalid: {relative}")
    _require(
        value.get("development_evidence_commit_sha") == DEVELOPMENT_EVIDENCE_COMMIT_SHA,
        "the development-only evidence commit identity changed",
    )
    return value


def verify_historical_evidence(protocol: dict[str, Any]) -> dict[str, str]:
    """Prove every immutable predecessor and development evidence file is byte-unchanged."""
    observed: dict[str, str] = {}
    for binding in ("historical_evidence_sha256", "development_evidence_sha256"):
        for relative, expected in protocol[binding].items():
            path = repository_root() / relative
            digest = normalized_text_file_sha256(path)
            if digest != expected:
                raise ValueError(f"bound evidence changed: {relative}")
            observed[relative] = digest
    return observed


FORBIDDEN_ASSET_SUFFIXES = {".png", ".jpg", ".jpeg", ".pdf", ".webp", ".tif", ".tiff", ".bmp"}
FORBIDDEN_TEXT_PATTERNS = {
    "instantiated future holdout case ID": re.compile(r"ocr2h-[0-9]{3}"),
    "final holdout metric record": re.compile(r'"final_holdout_metrics"\s*:'),
    "final holdout OCR capture": re.compile(r'"holdout_capture"\s*:'),
    "created fresh holdout": re.compile(r'"holdout_created"\s*:\s*true'),
    "recorded holdout measurement": re.compile(r'"holdout_measurement_exists"\s*:\s*true'),
    "production selection authorization": re.compile(r'"production_selection_authorized"\s*:\s*true'),
    "production SELECT classification": re.compile(r'"production_select_classification"\s*:\s*true'),
}


def scanned_paths() -> list[Path]:
    documentation = repository_root() / "docs" / "assistive-validation"
    scoped = [
        *data_root().rglob("*"),
        *package_root().rglob("*"),
        tool_root() / "tests" / "test_ocr_iteration2_holdout_protocol.py",
        documentation / "ocr-productionization-iteration2-holdout-protocol.md",
        documentation / "evidence" / "ocr-productionization-iteration2-distractor-calibration.json",
        documentation / "evidence" / "ocr-productionization-iteration2-holdout-protocol.json",
    ]
    # Byte-compiled caches are excluded so the scanned set is the same on every machine and the
    # recorded assertion stays reproducible.
    return sorted(
        {
            path.resolve()
            for path in scoped
            if path.is_file() and "__pycache__" not in path.parts
        }
    )


def assert_no_holdout_content() -> dict[str, Any]:
    """Fail if this protocol-freeze branch contains any fresh holdout material at all.

    The result reports findings only. It deliberately omits the scanned-file count, because the
    scan covers the freeze evidence document itself and a count would otherwise change the moment
    that document is written.
    """
    root = data_root().resolve()
    files = scanned_paths()
    forbidden_files = [
        str(path)
        for path in files
        if path.name.casefold() == "holdout.json"
        or (path.suffix.casefold() in FORBIDDEN_ASSET_SUFFIXES and root in path.parents)
        or HOLDOUT_CASE_ID.fullmatch(path.stem)
    ]
    if forbidden_files:
        raise ValueError(f"fresh holdout artifacts are forbidden in the protocol freeze: {forbidden_files}")
    for path in files:
        if path.suffix.casefold() not in {".py", ".json", ".md"}:
            continue
        text = path.read_text(encoding="utf-8")
        for label, pattern in FORBIDDEN_TEXT_PATTERNS.items():
            if pattern.search(text):
                raise ValueError(f"forbidden {label} in {path}")
    return {
        "holdout_created": False,
        "holdout_measurement_exists": False,
        "ocr_executed": False,
        "production_selection_authorized": False,
        "holdout_artifact_count": 0,
        "instantiated_holdout_case_id_count": 0,
    }


def check_inputs() -> dict[str, Any]:
    protocol = validate_protocol(load_json(data_root() / "protocol.json"))
    from .distractor_calibration import validate_development_evidence

    development_path = (
        repository_root()
        / "docs"
        / "assistive-validation"
        / "evidence"
        / "ocr-productionization-iteration2-distractor-calibration.json"
    )
    return {
        "protocol_sha256": value_sha256(protocol),
        "protocol_version": protocol["protocol_version"],
        "scored_case_count": protocol["holdout_distribution"]["scored_case_count"],
        "historical_evidence": verify_historical_evidence(protocol),
        "development_correction": validate_development_evidence(load_json(development_path)),
        "no_holdout_assertion": assert_no_holdout_content(),
        "scanned_file_count": len(scanned_paths()),
    }
