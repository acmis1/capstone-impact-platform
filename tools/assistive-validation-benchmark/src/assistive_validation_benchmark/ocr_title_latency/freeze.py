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
)
CALIBRATION_EVIDENCE_NAMES = (
    "baseline-full-mkldnn-off-capture.json",
    "baseline-full-mkldnn-off-report.json",
    "candidate-comparison.json",
    "candidate-selection.json",
    "default-cpu-fast-r30-t10-boundary-capture.json",
    "default-cpu-fast-r30-t10-boundary-report.json",
    "default-cpu-fast-r36-t10-boundary-capture.json",
    "default-cpu-fast-r36-t10-boundary-report.json",
    "default-cpu-fast-r36-t12-capture.json",
    "default-cpu-fast-r36-t12-report.json",
    "default-cpu-fast-r36-t4-capture.json",
    "default-cpu-fast-r36-t4-report.json",
    "default-cpu-fast-r36-t8-capture.json",
    "default-cpu-fast-r36-t8-report.json",
    "mkldnn-compatibility.json",
)
FREEZE_NAME = "candidate-freeze.json"


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


def build_freeze_manifest(calibration_commit: str) -> dict[str, Any]:
    protocol = validate_protocol(load_json(data_root() / "protocol.json"))
    corpus = validate_corpus(load_json(data_root() / "corpus" / "calibration.json"))
    selection = load_json(evidence_root() / "candidate-selection.json")
    selected_report = load_json(evidence_root() / "default-cpu-fast-r36-t4-report.json")
    if selection.get("selected_candidate_id") != "default-cpu-fast-r36-t4":
        raise ValueError("unexpected title-latency candidate selected for freeze")
    if selection.get("selected_report_sha256") != value_sha256(selected_report):
        raise ValueError("selected report hash differs from calibration selection")
    if not selected_report.get("score", {}).get("calibration_margin_passed"):
        raise ValueError("selected title-latency candidate did not meet the calibration margin")

    commit = _git("rev-parse", f"{calibration_commit}^{{commit}}")
    tree = _git("show", "-s", "--format=%T", commit)
    tracked = set(_git("ls-tree", "-r", "--name-only", commit).splitlines())
    holdout_prefix = "tools/assistive-validation-benchmark/ocr-title-latency-holdout/"
    if any(path.startswith(holdout_prefix) for path in tracked):
        raise ValueError("a title-latency holdout existed at the calibration checkpoint")
    source_root = Path(__file__).resolve().parent
    source_files = {name: file_sha256(source_root / name) for name in SOURCE_NAMES}
    evidence_files = {name: file_sha256(evidence_root() / name) for name in CALIBRATION_EVIDENCE_NAMES}
    return {
        "schema_version": "pp1-ocr-title-latency-freeze/v1",
        "phase": "FROZEN_TITLE_LATENCY_CANDIDATE",
        "calibration_checkpoint": {
            "commit": commit,
            "tree": tree,
            "holdout_path_absent": True,
        },
        "protocol_sha256": value_sha256(protocol),
        "calibration_corpus_sha256": value_sha256(corpus),
        "calibration_evidence_files": evidence_files,
        "calibration_evidence_sha256": value_sha256(evidence_files),
        "source_files": source_files,
        "source_files_sha256": value_sha256(source_files),
        "selected_candidate_id": selection["selected_candidate_id"],
        "selected_configuration": selection["selected_configuration"],
        "selected_report_sha256": selection["selected_report_sha256"],
        "model": protocol["candidate"],
        "fast_path_contract": protocol["fast_path_contract"],
        "title_contract": protocol["title_contract"],
        "quality_gates": protocol["quality_gates"],
        "operational_gates": protocol["operational_gates"],
        "security": protocol["security"],
        "input_output_bounds": {
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
        raise ValueError("title-latency candidate freeze already exists")
    if (data_root().parent / "ocr-title-latency-holdout").exists():
        raise ValueError("a title-latency holdout exists before candidate freeze")
    path.write_bytes(canonical_json_bytes(build_freeze_manifest(calibration_commit)))
    return path


def check_freeze_manifest() -> dict[str, Any]:
    stored = load_json(data_root() / FREEZE_NAME)
    checkpoint = stored.get("calibration_checkpoint") or {}
    expected = build_freeze_manifest(str(checkpoint.get("commit", "")))
    if stored != expected:
        raise ValueError("title-latency candidate freeze differs from frozen source and evidence")
    return stored
