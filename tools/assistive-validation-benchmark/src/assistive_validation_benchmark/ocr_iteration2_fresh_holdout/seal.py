"""Human approval, deterministic generation evidence, and pre-run sealing."""

from __future__ import annotations

import copy
import re
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any

from ..ocr_iteration2_holdout_protocol.fingerprint import require_verification_environment
from ..ocr_iteration2_holdout_protocol.holdout_contract import (
    holdout_non_reuse_evidence,
    validate_holdout_corpus,
)
from ..ocr_iteration2_holdout_protocol.manifest import (
    manifest_path,
    validate_freeze_commit_record,
    verify_freeze_manifest,
)
from ..ocr_iteration2_holdout_protocol.renderer import generate_holdout_assets
from ..ocr_iteration2_holdout_protocol.schema import (
    canonical_json_bytes,
    data_root as protocol_data_root,
    load_json,
    tool_root,
    validate_protocol,
    value_sha256,
)
from .corpus import (
    PREAPPROVAL_SCHEMA,
    SEED,
    SEED_DERIVATION_SHA256,
    STARTING_MAIN_SHA,
    corpus_path,
    data_root,
    preapproval_corpus_sha256,
    preapproval_path,
)


APPROVAL_INPUT_SCHEMA = "pp1-ocr-iteration2-human-approval-input/v1"
HUMAN_REVIEW_SCHEMA = "pp1-ocr-iteration2-human-ground-truth/v1"
GENERATION_MANIFEST_SCHEMA = "pp1-ocr-iteration2-content-addressed-generation/v1"
PRE_RUN_SEAL_SCHEMA = "pp1-ocr-iteration2-pre-run-seal/v1"
HEX_64 = re.compile(r"^[0-9a-f]{64}$")


def human_review_path() -> Path:
    return data_root() / "human-review.json"


def non_reuse_path() -> Path:
    return data_root() / "non-reuse.json"


def generation_manifest_path() -> Path:
    return data_root() / "generation-manifest.json"


def pre_run_seal_path() -> Path:
    return data_root() / "pre-run-seal.json"


def _semantic_cases(corpus: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        case
        for case in corpus["ocr_cases"]
        if case["split"] == "holdout" and case["negative_kind"] == "semantically_related_incorrect"
    ]


def verify_preapproval_lock(corpus: dict[str, Any], record: dict[str, Any]) -> dict[str, Any]:
    if record.get("schema_version") != PREAPPROVAL_SCHEMA:
        raise ValueError("unsupported pre-approval lock schema")
    if record.get("ocr_run_count") != 0 or record.get("ocr_executed") is not False:
        raise ValueError("pre-approval lock does not prove zero OCR runs")
    if record.get("holdout_result_exists") is not False:
        raise ValueError("pre-approval lock already claims a holdout result")
    if record.get("seed") != SEED or record.get("seed_derivation_sha256") != SEED_DERIVATION_SHA256:
        raise ValueError("pre-approval seed identity changed")
    observed = preapproval_corpus_sha256(corpus)
    if observed != record.get("preapproval_corpus_sha256"):
        raise ValueError("candidate corpus changed after the pre-approval lock")
    expected = {
        case["id"]: (case["title"], case["metadata_title"])
        for case in _semantic_cases(corpus)
    }
    recorded = {
        item["case_id"]: (item["poster_title"], item["metadata_title"])
        for item in record.get("semantic_review_cases", [])
    }
    if recorded != expected:
        raise ValueError("semantic review pairs differ from the locked candidate")
    if any(case["negative_relation_evidence"] is not None for case in _semantic_cases(corpus)):
        raise ValueError("pending candidate already carries purported human authority")
    return {
        "preapproval_corpus_sha256": observed,
        "semantic_case_ids": sorted(expected),
        "ocr_executed": False,
    }


def apply_human_approval(
    corpus: dict[str, Any],
    preapproval: dict[str, Any],
    approval_input: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Apply only the explicit human decisions to the already-locked semantic pairs."""
    locked = verify_preapproval_lock(corpus, preapproval)
    if approval_input.get("schema_version") != APPROVAL_INPUT_SCHEMA or approval_input.get("approved") is not True:
        raise ValueError("human approval input is absent or not explicitly approved")
    items = approval_input.get("cases")
    if not isinstance(items, list):
        raise ValueError("human approval input must contain a case list")
    by_id = {item.get("case_id"): item for item in items if isinstance(item, dict)}
    if set(by_id) != set(locked["semantic_case_ids"]):
        raise ValueError("human approval must cover exactly the locked semantic cases")
    approved = copy.deepcopy(corpus)
    original_pairs = {
        item["case_id"]: item
        for item in preapproval["semantic_review_cases"]
    }
    evidence_items = []
    corrections = []
    for case in _semantic_cases(approved):
        decision = by_id[case["id"]]
        poster = decision.get("poster_title")
        metadata = decision.get("metadata_title")
        rationale = decision.get("rationale")
        if not all(isinstance(value, str) and value.strip() == value for value in (poster, metadata, rationale)):
            raise ValueError(f"human approval fields are missing or unbounded: {case['id']}")
        original = original_pairs[case["id"]]
        if (poster, metadata) != (original["poster_title"], original["metadata_title"]):
            corrections.append(
                {
                    "case_id": case["id"],
                    "original_poster_title": original["poster_title"],
                    "original_metadata_title": original["metadata_title"],
                    "approved_poster_title": poster,
                    "approved_metadata_title": metadata,
                    "correction_recorded_before_ocr": True,
                }
            )
        case["title"] = poster
        case["metadata_title"] = metadata
        case["negative_relation_evidence"] = {
            "authority": "human_ground_truth",
            "classified_before_ocr": True,
            "rationale": rationale,
        }
        evidence_items.append(
            {
                "case_id": case["id"],
                "poster_title": poster,
                "metadata_title": metadata,
                "rationale": rationale,
                "authority": "human_ground_truth",
                "classified_before_ocr": True,
                "original_poster_title": original["poster_title"],
                "original_metadata_title": original["metadata_title"],
            }
        )
    review = {
        "schema_version": HUMAN_REVIEW_SCHEMA,
        "authority": "human_ground_truth",
        "classified_before_ocr": True,
        "preapproval_corpus_sha256": locked["preapproval_corpus_sha256"],
        "semantic_case_ids": locked["semantic_case_ids"],
        "cases": sorted(evidence_items, key=lambda item: item["case_id"]),
        "corrections": sorted(corrections, key=lambda item: item["case_id"]),
        "corpus_regenerated_after_approval": False,
        "ocr_run_count": 0,
        "ocr_executed": False,
    }
    return approved, review


def _generation_manifest(
    corpus: dict[str, Any],
    protocol: dict[str, Any],
    generated: dict[str, Any],
) -> dict[str, Any]:
    corpus_sha = value_sha256(corpus)
    renderer = generated["renderer_fingerprint_sha256"]
    assets = [
        {
            "case_control_id": item["case_id"],
            "relative_asset_path": item["asset"],
            "bytes": item["bytes"],
            "sha256": item["sha256"],
            "corpus_sha256": corpus_sha,
            "renderer_fingerprint_sha256": renderer,
            "protocol_version": protocol["protocol_version"],
        }
        for item in generated["assets"]
    ]
    return {
        "schema_version": GENERATION_MANIFEST_SCHEMA,
        "protocol_version": protocol["protocol_version"],
        "corpus_version": corpus["corpus_version"],
        "corpus_schema_version": corpus["schema_version"],
        "corpus_sha256": corpus_sha,
        "renderer_fingerprint_sha256": renderer,
        "asset_count": len(assets),
        "corpus_asset_sha256": generated["corpus_asset_sha256"],
        "assets": assets,
        "canonical_generation_repetitions": 2,
        "deterministic_regeneration_match": True,
        "binary_assets_committed": False,
        "binary_assets_reproducible_from_sealed_corpus": True,
    }


def validate_generation_manifest(manifest: dict[str, Any], corpus: dict[str, Any]) -> dict[str, Any]:
    if manifest.get("schema_version") != GENERATION_MANIFEST_SCHEMA:
        raise ValueError("unsupported generation manifest schema")
    if manifest.get("corpus_sha256") != value_sha256(corpus):
        raise ValueError("generation manifest corpus hash changed")
    if manifest.get("canonical_generation_repetitions") != 2 or manifest.get("deterministic_regeneration_match") is not True:
        raise ValueError("generation manifest does not prove deterministic canonical regeneration")
    if manifest.get("binary_assets_committed") is not False:
        raise ValueError("generation manifest unexpectedly claims committed binary assets")
    expected_ids = {
        case["id"] for case in corpus["ocr_cases"]
    } | {control["id"] for control in corpus["native_controls"]} | {
        control["id"] for control in corpus["security_controls"]
    }
    assets = manifest.get("assets")
    if not isinstance(assets, list) or len(assets) != len(expected_ids) or manifest.get("asset_count") != len(assets):
        raise ValueError("generation manifest asset count changed")
    observed_ids = set()
    for item in assets:
        if set(item) != {
            "case_control_id",
            "relative_asset_path",
            "bytes",
            "sha256",
            "corpus_sha256",
            "renderer_fingerprint_sha256",
            "protocol_version",
        }:
            raise ValueError("generation manifest asset uses an unknown field set")
        relative = PurePosixPath(item["relative_asset_path"])
        if relative.is_absolute() or ".." in relative.parts or len(relative.parts) != 1:
            raise ValueError("generation manifest contains an unsafe asset path")
        if not isinstance(item["bytes"], int) or item["bytes"] <= 0 or not HEX_64.fullmatch(str(item["sha256"])):
            raise ValueError("generation manifest contains an invalid asset size or hash")
        if item["corpus_sha256"] != manifest["corpus_sha256"]:
            raise ValueError("generation manifest asset corpus binding changed")
        if item["renderer_fingerprint_sha256"] != manifest["renderer_fingerprint_sha256"]:
            raise ValueError("generation manifest asset renderer binding changed")
        if item["protocol_version"] != manifest["protocol_version"]:
            raise ValueError("generation manifest asset protocol binding changed")
        observed_ids.add(item["case_control_id"])
    if observed_ids != expected_ids:
        raise ValueError("generation manifest case/control identities changed")
    return {"asset_count": len(assets), "corpus_sha256": manifest["corpus_sha256"]}


def _build_pre_run_seal(
    protocol: dict[str, Any],
    freeze: dict[str, Any],
    corpus: dict[str, Any],
    review: dict[str, Any],
    non_reuse: dict[str, Any],
    generation: dict[str, Any],
) -> dict[str, Any]:
    candidate = protocol["candidate"]
    return {
        "schema_version": PRE_RUN_SEAL_SCHEMA,
        "origin_main_starting_sha": STARTING_MAIN_SHA,
        "protocol_version": protocol["protocol_version"],
        "freeze_tree_sha256": freeze["freeze_tree_sha256"],
        "freeze_manifest_sha256": freeze["freeze_manifest_sha256"],
        "renderer_fingerprint_sha256": generation["renderer_fingerprint_sha256"],
        "corpus_version": corpus["corpus_version"],
        "corpus_schema_version": corpus["schema_version"],
        "corpus_sha256": value_sha256(corpus),
        "seed_derivation_sha256": SEED_DERIVATION_SHA256,
        "human_ground_truth_review_sha256": value_sha256(review),
        "non_reuse_evidence_sha256": value_sha256(non_reuse),
        "generation_manifest_sha256": value_sha256(generation),
        "candidate": {
            "engine": candidate["engine"],
            "family": candidate["family"],
            "variant": candidate["variant"],
            "detection_artifact": candidate["detection_artifact"],
            "detection_tree_sha256": candidate["detection_tree_sha256"],
            "recognition_artifact": candidate["recognition_artifact"],
            "recognition_tree_sha256": candidate["recognition_tree_sha256"],
            "runtime": candidate["runtime"],
            "device": candidate["device"],
        },
        "raster_dpi": 180,
        "max_input_dimension": 1920,
        "expected_scored_cases": 40,
        "ocr_run_count": 0,
        "ocr_executed": False,
        "holdout_result_exists": False,
        "holdout_capture_exists": False,
        "post_result_tuning_permitted": False,
    }


def seal_approved_candidate(approval_file: Path) -> dict[str, Any]:
    """Seal the approved corpus after two canonical generations; never execute OCR."""
    if pre_run_seal_path().exists():
        raise ValueError("fresh holdout is already sealed; refusing to reseal or regenerate")
    protocol = validate_protocol(load_json(protocol_data_root() / "protocol.json"))
    freeze = verify_freeze_manifest(load_json(manifest_path()))
    validate_freeze_commit_record(load_json(protocol_data_root() / "freeze-commit.json"))
    pending = load_json(corpus_path())
    preapproval = load_json(preapproval_path())
    approved, review = apply_human_approval(pending, preapproval, load_json(approval_file))
    validation = validate_holdout_corpus(approved, protocol)
    non_reuse = holdout_non_reuse_evidence(approved)
    if non_reuse["exact_title_body_reuse_count"] != 0 or non_reuse["real_participant_or_project_data"] is not False:
        raise ValueError("approved corpus failed the frozen non-reuse or synthetic-content rule")
    artifacts_parent = tool_root() / "artifacts"
    artifacts_parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="ocr2h-seal-a-", dir=artifacts_parent) as first_dir:
        with tempfile.TemporaryDirectory(prefix="ocr2h-seal-b-", dir=artifacts_parent) as second_dir:
            first = generate_holdout_assets(approved, Path(first_dir))
            second = generate_holdout_assets(approved, Path(second_dir))
    if first != second:
        raise ValueError("canonical deterministic regeneration produced different manifests")
    generation = _generation_manifest(approved, protocol, first)
    validate_generation_manifest(generation, approved)
    review["final_corpus_sha256"] = value_sha256(approved)
    review["approved_semantic_case_count"] = len(review["cases"])
    seal = _build_pre_run_seal(protocol, freeze, approved, review, non_reuse, generation)
    corpus_path().write_bytes(canonical_json_bytes(approved))
    human_review_path().write_bytes(canonical_json_bytes(review))
    non_reuse_path().write_bytes(canonical_json_bytes(non_reuse))
    generation_manifest_path().write_bytes(canonical_json_bytes(generation))
    pre_run_seal_path().write_bytes(canonical_json_bytes(seal))
    return {
        "contract_validation": validation,
        "historical_case_count": non_reuse["historical_case_count"],
        "asset_count": generation["asset_count"],
        "corpus_sha256": seal["corpus_sha256"],
        "human_review_sha256": seal["human_ground_truth_review_sha256"],
        "non_reuse_sha256": seal["non_reuse_evidence_sha256"],
        "generation_manifest_sha256": seal["generation_manifest_sha256"],
        "pre_run_seal_sha256": value_sha256(seal),
        "ocr_run_count": 0,
        "ocr_executed": False,
    }


def _restore_pending_for_lock(corpus: dict[str, Any], review: dict[str, Any]) -> dict[str, Any]:
    restored = copy.deepcopy(corpus)
    by_id = {item["case_id"]: item for item in review["cases"]}
    for case in _semantic_cases(restored):
        item = by_id[case["id"]]
        case["title"] = item["original_poster_title"]
        case["metadata_title"] = item["original_metadata_title"]
        case["negative_relation_evidence"] = None
    return restored


def validate_seal() -> dict[str, Any]:
    """Cheap CI-safe seal validation. It never generates assets, loads Paddle, or runs OCR."""
    protocol = validate_protocol(load_json(protocol_data_root() / "protocol.json"))
    freeze = verify_freeze_manifest(load_json(manifest_path()))
    validate_freeze_commit_record(load_json(protocol_data_root() / "freeze-commit.json"))
    renderer = require_verification_environment()
    corpus = load_json(corpus_path())
    validation = validate_holdout_corpus(corpus, protocol)
    preapproval = load_json(preapproval_path())
    review = load_json(human_review_path())
    non_reuse = load_json(non_reuse_path())
    generation = load_json(generation_manifest_path())
    seal = load_json(pre_run_seal_path())
    if review.get("schema_version") != HUMAN_REVIEW_SCHEMA or review.get("authority") != "human_ground_truth":
        raise ValueError("human review evidence is missing its frozen authority")
    if review.get("classified_before_ocr") is not True or review.get("ocr_executed") is not False:
        raise ValueError("human review evidence was not recorded before OCR")
    restored = _restore_pending_for_lock(corpus, review)
    if preapproval_corpus_sha256(restored) != preapproval.get("preapproval_corpus_sha256"):
        raise ValueError("human review evidence cannot reconstruct the locked pre-approval corpus")
    expected_non_reuse = holdout_non_reuse_evidence(corpus)
    if non_reuse != expected_non_reuse or non_reuse["exact_title_body_reuse_count"] != 0:
        raise ValueError("stored non-reuse evidence does not recompute")
    validate_generation_manifest(generation, corpus)
    expected_seal = _build_pre_run_seal(protocol, freeze, corpus, review, non_reuse, generation)
    if seal != expected_seal:
        raise ValueError("stored pre-run seal does not follow its bound evidence")
    forbidden = [
        path
        for path in data_root().rglob("*")
        if path.is_file() and ("capture" in path.name.casefold() or "report" in path.name.casefold() or "result" in path.name.casefold())
    ]
    if forbidden:
        raise ValueError(f"holdout result or capture exists before the one-shot run: {forbidden}")
    if renderer["expected_fingerprint_sha256"] != seal["renderer_fingerprint_sha256"]:
        raise ValueError("sealed renderer fingerprint differs from the frozen verification environment")
    return {
        "protocol_version": protocol["protocol_version"],
        "freeze_tree_sha256": freeze["freeze_tree_sha256"],
        "freeze_manifest_sha256": freeze["freeze_manifest_sha256"],
        "renderer_fingerprint_sha256": seal["renderer_fingerprint_sha256"],
        "corpus_sha256": seal["corpus_sha256"],
        "pre_run_seal_sha256": value_sha256(seal),
        "scored_case_count": validation["scored_case_count"],
        "asset_count": generation["asset_count"],
        "historical_case_count": non_reuse["historical_case_count"],
        "exact_title_body_reuse_count": 0,
        "ocr_run_count": 0,
        "ocr_executed": False,
        "holdout_result_exists": False,
    }
