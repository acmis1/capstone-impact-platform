"""Candidate/protocol freeze. Written only while no fresh holdout exists anywhere in the tree."""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

from .schema import (
    canonical_json_bytes,
    data_root,
    evidence_root,
    file_sha256,
    load_json,
    repository_root,
    validate_corpus,
    validate_protocol,
    value_sha256,
)


SOURCE_NAMES = (
    "__init__.py",
    "__main__.py",
    "capture.py",
    "corpus.py",
    "evidence.py",
    "freeze.py",
    "pipeline.py",
    "renderer.py",
    "schema.py",
    "scoring.py",
    "selection.py",
    "selector.py",
    "selector_diagnostic.py",
    "selectors.py",
)
FREEZE_NAME = "candidate-freeze.json"
HOLDOUT_DIRECTORY_NAME = "ocr-title-fullpage-holdout"
HOLDOUT_TRACKED_PREFIX = f"tools/assistive-validation-benchmark/{HOLDOUT_DIRECTORY_NAME}/"


def _git(*args: str) -> str:
    completed = subprocess.run(
        ["git", *args],
        cwd=repository_root(),
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    return completed.stdout.strip()


def _evidence_file_names() -> tuple[str, ...]:
    root = evidence_root()
    return tuple(sorted(path.name for path in root.glob("*.json")))


def build_freeze_manifest(calibration_commit: str) -> dict[str, Any]:
    protocol = validate_protocol(load_json(data_root() / "protocol.json"))
    corpus = validate_corpus(load_json(data_root() / "corpus" / "calibration.json"))
    selection = load_json(evidence_root() / "candidate-selection.json")
    selector_decision = load_json(evidence_root() / "selector-decision.json")
    candidate_id = selection["selected_candidate_id"]
    selected = load_json(evidence_root() / f"{candidate_id}-aggregate.json")
    if selection["selected_aggregate_sha256"] != value_sha256(selected):
        raise ValueError("selected aggregate hash differs from calibration selection")
    if not selected["selection_eligible"]:
        raise ValueError("selected title-fullpage candidate is not eligible")
    if selected["repeat_count"] < protocol["repeatability"]["required_independent_repeats"]:
        raise ValueError("selected candidate has fewer repeats than the frozen contract requires")
    if selected["selector_id"] != selector_decision["selected_selector_id"]:
        raise ValueError("selected candidate did not use the decided selector")

    commit = _git("rev-parse", f"{calibration_commit}^{{commit}}")
    tree = _git("show", "-s", "--format=%T", commit)
    tracked = set(_git("ls-tree", "-r", "--name-only", commit).splitlines())
    if any(path.startswith(HOLDOUT_TRACKED_PREFIX) for path in tracked):
        raise ValueError("a title-fullpage holdout existed at the calibration checkpoint")
    source_root = Path(__file__).resolve().parent
    source_files = {name: file_sha256(source_root / name) for name in SOURCE_NAMES}
    evidence_files = {name: file_sha256(evidence_root() / name) for name in _evidence_file_names()}
    return {
        "schema_version": "pp1-ocr-title-fullpage-freeze/v1",
        "phase": "FROZEN_FULL_PAGE_TITLE_CANDIDATE",
        "calibration_checkpoint": {"commit": commit, "tree": tree, "holdout_path_absent": True},
        "protocol_sha256": value_sha256(protocol),
        "calibration_corpus_sha256": value_sha256(corpus),
        "calibration_evidence_files": evidence_files,
        "calibration_evidence_sha256": value_sha256(evidence_files),
        "source_files": source_files,
        "source_files_sha256": value_sha256(source_files),
        "selected_candidate_id": candidate_id,
        "selected_configuration": selected["configuration"],
        "selected_architecture": selected["architecture"],
        "selected_complexity_rank": selected["complexity_rank"],
        "selected_aggregate_sha256": selection["selected_aggregate_sha256"],
        "selection_rule": protocol["selection_rule"],
        "repeatability": protocol["repeatability"],
        "selector": {
            "selected_selector_id": selector_decision["selected_selector_id"],
            "baseline_selector_id": selector_decision["baseline_selector_id"],
            "decision": selector_decision["decision"],
            "decision_sha256": value_sha256(selector_decision),
        },
        "model": protocol["candidate"],
        "title_contract": protocol["title_contract"],
        "quality_gates": protocol["quality_gates"],
        "calibration_margin": protocol["calibration_margin"],
        "operational_gates": protocol["operational_gates"],
        "security": protocol["security"],
        "input_output_bounds": {
            "page_scope": "FULL_PAGE",
            "raster_dpi": 180,
            "max_input_dimension": 1920,
            "per_case_timeout_seconds": 90,
            "max_ocr_blocks": 5000,
            "max_ocr_text_characters": 100000,
            "worker_concurrency": 1,
        },
        "decision_contract": {
            "allowed": [
                "READY_FOR_TITLE_OCR_INTEGRATION",
                "OCR_TITLE_PROVIDER_DEFERRED",
                "HOLDOUT_INVALID_PROTOCOL_BUG",
            ],
            "ready_requires_every_final_gate": True,
        },
        "holdout_existed_when_manifest_written": False,
    }


def write_freeze_manifest(calibration_commit: str) -> Path:
    path = data_root() / FREEZE_NAME
    if path.exists():
        raise ValueError("title-fullpage candidate freeze already exists")
    if (data_root().parent / HOLDOUT_DIRECTORY_NAME).exists():
        raise ValueError("a title-fullpage holdout exists before candidate freeze")
    path.write_bytes(canonical_json_bytes(build_freeze_manifest(calibration_commit)))
    return path


def check_freeze_manifest() -> dict[str, Any]:
    stored = load_json(data_root() / FREEZE_NAME)
    checkpoint = stored.get("calibration_checkpoint") or {}
    expected = build_freeze_manifest(str(checkpoint.get("commit", "")))
    if stored != expected:
        raise ValueError("title-fullpage candidate freeze differs from frozen source and evidence")
    return stored
