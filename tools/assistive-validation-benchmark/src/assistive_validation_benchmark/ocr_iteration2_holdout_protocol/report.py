"""Machine-readable protocol-freeze evidence, and its recomputation check.

``build_freeze_evidence`` records what was frozen. ``validate_freeze_evidence`` recomputes all
of it — manifest hashes, renderer fingerprint, candidate identity, historical evidence and the
no-holdout assertion — so a stored claim can never drift away from the frozen tree.

The production-boundary block is a historical fact about the freeze plus a PR-relative scope
guard. It is deliberately *not* a permanent requirement that ``main`` keep two OCR providers
and thirty-three migrations forever: a later legitimate OCR integration must not retroactively
invalidate this freeze.
"""

from __future__ import annotations

from typing import Any

from . import PROTOCOL_VERSION, SCHEMA_VERSION
from .distractor_calibration import validate_development_evidence
from .fingerprint import environment_path, validate_environment, verify_fingerprint
from .holdout_contract import HOLDOUT_CORPUS_VERSION
from .manifest import manifest_path, verify_freeze_manifest
from .schema import (
    assert_no_holdout_content,
    data_root,
    load_json,
    repository_root,
    validate_protocol,
    value_sha256,
    verify_historical_evidence,
)


PRODUCTION_BOUNDARY = {
    "evidence_role": (
        "historical starting-state evidence plus a PR-relative scope guard; not a permanent "
        "requirement on future main"
    ),
    "production_ocr_task_providers": ["NONE", "TESSERACT"],
    "coordinator_ocr_selection": "NONE",
    "migration_count": 33,
    "production_behavior_changed": False,
    "production_provider_integration": False,
    "migration_34": False,
    "supabase_changed": False,
}
IMPLEMENTED = [
    "holdout_protocol_freeze",
    "canonical_renderer_environment",
    "renderer_fingerprint",
    "development_distractor_selector_and_wer_correction",
]
NOT_IMPLEMENTED = [
    "fresh_holdout",
    "holdout_measurement",
    "production_ocr_provider",
    "production_select_classification",
]
SCIENTIFIC_INTEGRITY = {
    "measurement_role": "protocol_freeze_only",
    "holdout_created": False,
    "holdout_measurement_exists": False,
    "ocr_executed": False,
    "production_selection_authorized": False,
    "unbiased_accuracy_claimed": False,
    "historical_evidence_mutated": False,
    "calibration_results_are_not_holdout_results": True,
    "development_ocr_executed": True,
    "fresh_holdout_ocr_executed": False,
    "development_evidence_is_not_holdout_evidence": True,
}


def _candidate_identity(protocol: dict[str, Any]) -> dict[str, Any]:
    candidate = protocol["candidate"]
    return {
        "engine": candidate["engine"],
        "family": candidate["family"],
        "variant": candidate["variant"],
        "detection_artifact": candidate["detection_artifact"],
        "recognition_artifact": candidate["recognition_artifact"],
        "detection_tree_sha256": candidate["detection_tree_sha256"],
        "recognition_tree_sha256": candidate["recognition_tree_sha256"],
        "artifact_footprint_bytes": candidate["artifact_footprint_bytes"],
        "runtime": candidate["runtime"],
        "license": candidate["license"],
        "additional_candidates": protocol["additional_candidates"],
    }


def _freeze_state() -> dict[str, Any]:
    protocol = validate_protocol(load_json(data_root() / "protocol.json"))
    environment = validate_environment(load_json(environment_path()))
    manifest = verify_freeze_manifest(load_json(manifest_path()))
    fingerprint = verify_fingerprint(environment)
    return {
        "protocol": protocol,
        "environment": environment,
        "manifest": manifest,
        "fingerprint": fingerprint,
    }


def _evidence_from_state(state: dict[str, Any]) -> dict[str, Any]:
    protocol = state["protocol"]
    environment = state["environment"]
    fingerprint = state["fingerprint"]
    development_path = (
        repository_root()
        / "docs"
        / "assistive-validation"
        / "evidence"
        / "ocr-productionization-iteration2-distractor-calibration.json"
    )
    development = validate_development_evidence(load_json(development_path))
    return {
        "schema_version": SCHEMA_VERSION,
        "protocol_version": PROTOCOL_VERSION,
        "implemented": IMPLEMENTED,
        "not_implemented": NOT_IMPLEMENTED,
        "starting_state": {
            "merged_calibration_decision": "READY_TO_FREEZE_OCR_ITERATION_2_HOLDOUT_PROTOCOL",
            "calibration_selected_engine": "PP-OCRv6 Small",
            "calibration_selected_raster": "dpi180-edge1920",
            "merged_calibration_selected_selector": "first_bounded_group@geometry",
            "corrected_frozen_selector": protocol["title_contract"]["selector_id"],
            "calibration_primary_reading_order": protocol["wer_contract"]["primary_order"],
            "calibration_results_role": "development calibration only; not holdout accuracy",
        },
        "frozen_candidate": _candidate_identity(protocol),
        "frozen_raster_contract": protocol["raster_contract"],
        "frozen_title_contract": protocol["title_contract"],
        "frozen_wer_contract": protocol["wer_contract"],
        "frozen_quality_gate": protocol["quality_gate"],
        "frozen_operational_gate": protocol["operational_gate"],
        "frozen_holdout_distribution": protocol["holdout_distribution"],
        "frozen_upper_page_distractors": protocol["upper_page_distractors"],
        "frozen_material_title_negatives": protocol["material_title_negatives"],
        "frozen_controls": protocol["controls"],
        "frozen_decision_contract": protocol["decision_contract"],
        "development_correction_evidence": {
            "path": "docs/assistive-validation/evidence/ocr-productionization-iteration2-distractor-calibration.json",
            "sha256": protocol["development_evidence_sha256"][
                "docs/assistive-validation/evidence/ocr-productionization-iteration2-distractor-calibration.json"
            ],
            "commit_sha": protocol["development_evidence_commit_sha"],
            **development,
        },
        "future_run_contract": protocol["future_run_contract"],
        "future_holdout_corpus_version": HOLDOUT_CORPUS_VERSION,
        "hashes": {
            "protocol_sha256": value_sha256(protocol),
            "renderer_environment_sha256": value_sha256(environment),
            "freeze_manifest_sha256": state["manifest"]["freeze_manifest_sha256"],
            "freeze_tree_sha256": state["manifest"]["freeze_tree_sha256"],
        },
        "canonical_renderer": {
            "environment_id": environment["environment_id"],
            "pinned_toolchain": environment["pinned_toolchain"],
            "font_sha256": environment["font"]["sha256"],
            "system_font_fallback": False,
            "runtime_font_download": False,
            "network_during_generation": False,
            "reference_fixture_is_scored": False,
            "fingerprint_sha256": fingerprint["expected_fingerprint_sha256"],
            "canonical_generation_platform": fingerprint["canonical_generation_platform"],
            "attested_platform_ids": fingerprint["attested_platform_ids"],
            "render_digests_are_platform_specific": True,
            "noncanonical_render_digest_parity_required": False,
            "encoded_byte_parity_is_binding": False,
        },
        "frozen_component_count": state["manifest"]["component_count"],
        "historical_evidence": verify_historical_evidence(protocol),
        "no_holdout_assertion": assert_no_holdout_content(),
        "scientific_integrity": SCIENTIFIC_INTEGRITY,
        "production_boundary": PRODUCTION_BOUNDARY,
    }


def build_freeze_evidence() -> dict[str, Any]:
    state = _freeze_state()
    if not state["fingerprint"]["matches_canonical_renderer"]:
        raise ValueError(
            "refusing to record freeze evidence outside the canonical generation renderer"
        )
    return _evidence_from_state(state)


def validate_freeze_evidence(stored: dict[str, Any]) -> dict[str, Any]:
    if stored.get("schema_version") != SCHEMA_VERSION:
        raise ValueError("unsupported stored Iteration 2 holdout protocol-freeze evidence")
    state = _freeze_state()
    if not state["fingerprint"]["matches_verification_environment"]:
        raise ValueError(
            "stored freeze evidence cannot be verified outside the pinned renderer environment; divergent components: "
            + ", ".join(state["fingerprint"]["divergent_binding_components"])
        )
    expected = _evidence_from_state(state)
    for key in sorted(set(expected) | set(stored)):
        if stored.get(key) != expected.get(key):
            raise ValueError(f"stored protocol-freeze evidence does not follow the frozen tree: {key}")
    return {
        "protocol_version": expected["protocol_version"],
        "freeze_tree_sha256": expected["hashes"]["freeze_tree_sha256"],
        "freeze_manifest_sha256": expected["hashes"]["freeze_manifest_sha256"],
        "renderer_fingerprint_sha256": expected["canonical_renderer"]["fingerprint_sha256"],
        "frozen_component_count": expected["frozen_component_count"],
        "holdout_created": False,
        "holdout_measurement_exists": False,
        "ocr_executed": False,
        "production_selection_authorized": False,
    }
