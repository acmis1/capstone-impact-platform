from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

from .schema import (
    calibration_data_root,
    calibration_evidence_root,
    canonical_json_bytes,
    file_sha256,
    load_json,
    repository_root,
    validate_corpus,
    validate_protocol,
    value_sha256,
)


SOURCE_NAMES = (
    "__main__.py",
    "capture.py",
    "corpus.py",
    "evidence.py",
    "freeze.py",
    "renderer.py",
    "schema.py",
    "scoring.py",
    "selector.py",
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
    protocol = validate_protocol(load_json(calibration_data_root() / "protocol.json"))
    corpus = validate_corpus(
        load_json(calibration_data_root() / "corpus" / "calibration.json"),
        expected_split="calibration",
        expected_count=30,
    )
    commit = _git("rev-parse", f"{calibration_commit}^{{commit}}")
    tree = _git("show", "-s", "--format=%T", commit)
    tracked = set(_git("ls-tree", "-r", "--name-only", commit).splitlines())
    if any("ocr-title-consistency-holdout" in path for path in tracked):
        raise ValueError("a title holdout existed at the calibration checkpoint")
    source_root = Path(__file__).resolve().parent
    evidence_root = calibration_evidence_root()
    evidence_names = (
        "calibration-attempt-1-capture.json",
        "calibration-attempt-1-report.json",
        "calibration-capture.json",
        "calibration-decision.json",
        "calibration-report.json",
    )
    return {
        "schema_version": "pp1-ocr-title-consistency-freeze/v1",
        "phase": "FROZEN_TITLE_CANDIDATE",
        "calibration_checkpoint": {"commit": commit, "tree": tree, "holdout_path_absent": True},
        "protocol_sha256": value_sha256(protocol),
        "calibration_corpus_sha256": value_sha256(corpus),
        "source_files": {name: file_sha256(source_root / name) for name in SOURCE_NAMES},
        "calibration_evidence_files": {name: file_sha256(evidence_root / name) for name in evidence_names},
        "candidate": protocol["candidate"],
        "configuration": protocol["configuration"],
        "title_contract": protocol["title_contract"],
        "quality_gates": protocol["quality_gates"],
        "operational_gates": protocol["operational_gates"],
        "decision_contract": protocol["decision_contract"],
        "holdout_existed_when_manifest_written": False,
    }


def write_freeze_manifest(calibration_commit: str) -> Path:
    path = calibration_data_root() / FREEZE_NAME
    if path.exists():
        raise ValueError("candidate freeze manifest already exists")
    path.write_bytes(canonical_json_bytes(build_freeze_manifest(calibration_commit)))
    return path


def check_freeze_manifest() -> dict[str, Any]:
    path = calibration_data_root() / FREEZE_NAME
    stored = load_json(path)
    checkpoint = stored.get("calibration_checkpoint") or {}
    expected = build_freeze_manifest(str(checkpoint.get("commit", "")))
    if stored != expected:
        raise ValueError("candidate freeze manifest differs from frozen source and evidence")
    return stored
