from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

from ..ocr_title_consistency.evidence import non_reuse_evidence
from ..ocr_title_consistency.freeze import check_freeze_manifest
from ..ocr_title_consistency.renderer import generate_assets
from ..ocr_title_consistency.schema import (
    calibration_data_root,
    calibration_evidence_root,
    canonical_json_bytes,
    file_sha256,
    load_json,
    repository_root,
    tool_root,
    validate_corpus,
    validate_protocol,
    value_sha256,
)
from .corpus import build_holdout_corpus


HOLDOUT_ROOT = tool_root() / "ocr-title-consistency-holdout"
CORPUS_PATH = HOLDOUT_ROOT / "corpus" / "holdout.json"
GENERATION_PATH = HOLDOUT_ROOT / "generation.json"
NON_REUSE_PATH = HOLDOUT_ROOT / "non-reuse.json"
SEAL_PATH = HOLDOUT_ROOT / "seal.json"
STATE_PATH = HOLDOUT_ROOT / "state.json"
EVIDENCE_ROOT = repository_root() / "docs" / "assistive-validation" / "evidence" / "ocr-title-consistency-holdout"
RUNNER_SOURCE_NAMES = ("__main__.py", "capture.py", "corpus.py", "one_shot.py", "seal.py")


def _git(*args: str) -> str:
    completed = subprocess.run(
        ["git", *args], cwd=repository_root(), check=True, capture_output=True, text=True, encoding="utf-8"
    )
    return completed.stdout.strip()


def initial_state(freeze_commit: str) -> dict[str, Any]:
    return {
        "schema_version": "pp1-ocr-title-consistency-holdout-state/v1",
        "status": "SEALED_UNCONSUMED",
        "run_count": 0,
        "freeze_commit": freeze_commit,
        "capture_sha256": None,
        "report_sha256": None,
    }


def _calibration_records() -> list[dict[str, str]]:
    report = load_json(calibration_evidence_root() / "calibration-report.json")
    return list(report["non_reuse"]["records"])


def prepare_holdout(freeze_commit: str, assets_dir: Path) -> Path:
    if any(path.exists() for path in (CORPUS_PATH, GENERATION_PATH, NON_REUSE_PATH, SEAL_PATH, STATE_PATH)):
        raise ValueError("holdout preparation path already exists")
    if EVIDENCE_ROOT.exists():
        raise ValueError("candidate output exists before holdout preparation")
    freeze = check_freeze_manifest()
    commit = _git("rev-parse", f"{freeze_commit}^{{commit}}")
    if commit != freeze_commit:
        raise ValueError("freeze commit must be a full exact commit identity")
    tracked_freeze = _git("show", f"{commit}:tools/assistive-validation-benchmark/ocr-title-consistency-calibration/candidate-freeze.json")
    if tracked_freeze.encode("utf-8") + b"\n" != canonical_json_bytes(freeze):
        raise ValueError("selected freeze commit does not contain the active freeze manifest")
    corpus = validate_corpus(build_holdout_corpus(), expected_split="holdout", expected_count=45)
    reuse = non_reuse_evidence(corpus, split="holdout", additional=_calibration_records())
    if not reuse["passed"]:
        raise ValueError("fresh holdout reuses historical or calibration content")
    CORPUS_PATH.parent.mkdir(parents=True, exist_ok=True)
    CORPUS_PATH.write_bytes(canonical_json_bytes(corpus))
    generation = generate_assets(corpus, assets_dir)
    GENERATION_PATH.write_bytes(canonical_json_bytes(generation))
    NON_REUSE_PATH.write_bytes(canonical_json_bytes(reuse))
    state = initial_state(commit)
    STATE_PATH.write_bytes(canonical_json_bytes(state))
    source_root = Path(__file__).resolve().parent
    protocol = validate_protocol(load_json(calibration_data_root() / "protocol.json"))
    seal = {
        "schema_version": "pp1-ocr-title-consistency-holdout-seal/v1",
        "status": "SEALED_UNCONSUMED",
        "freeze": {"commit": commit, "tree": _git("show", "-s", "--format=%T", commit)},
        "candidate_freeze_sha256": file_sha256(calibration_data_root() / "candidate-freeze.json"),
        "protocol_sha256": value_sha256(protocol),
        "corpus_sha256": value_sha256(corpus),
        "generation_sha256": value_sha256(generation),
        "corpus_asset_sha256": generation["corpus_asset_sha256"],
        "non_reuse_sha256": value_sha256(reuse),
        "initial_state_sha256": value_sha256(state),
        "runner_source_files": {name: file_sha256(source_root / name) for name in RUNNER_SOURCE_NAMES},
        "candidate": protocol["candidate"],
        "configuration": protocol["configuration"],
        "quality_gates": protocol["quality_gates"],
        "operational_gates": protocol["operational_gates"],
        "scored_case_count": 45,
        "inconsistent_case_count": sum(
            case["expected_consistency"] == "INCONSISTENT"
            for case in corpus["ocr_cases"]
            if case["split"] == "holdout"
        ),
        "candidate_output_absent_when_sealed": True,
        "one_shot_run_count": 0,
    }
    SEAL_PATH.write_bytes(canonical_json_bytes(seal))
    return SEAL_PATH


def check_seal(*, assets_dir: Path | None = None, require_unconsumed: bool = False) -> dict[str, Any]:
    freeze = check_freeze_manifest()
    corpus = validate_corpus(load_json(CORPUS_PATH), expected_split="holdout", expected_count=45)
    if corpus != build_holdout_corpus():
        raise ValueError("sealed holdout corpus differs from deterministic source")
    generation = load_json(GENERATION_PATH)
    reuse = non_reuse_evidence(corpus, split="holdout", additional=_calibration_records())
    if load_json(NON_REUSE_PATH) != reuse or not reuse["passed"]:
        raise ValueError("sealed holdout non-reuse evidence differs")
    seal = load_json(SEAL_PATH)
    source_root = Path(__file__).resolve().parent
    expected_fields = {
        "candidate_freeze_sha256": file_sha256(calibration_data_root() / "candidate-freeze.json"),
        "protocol_sha256": value_sha256(validate_protocol(load_json(calibration_data_root() / "protocol.json"))),
        "corpus_sha256": value_sha256(corpus),
        "generation_sha256": value_sha256(generation),
        "corpus_asset_sha256": generation["corpus_asset_sha256"],
        "non_reuse_sha256": value_sha256(reuse),
        "runner_source_files": {name: file_sha256(source_root / name) for name in RUNNER_SOURCE_NAMES},
    }
    if any(seal.get(key) != value for key, value in expected_fields.items()):
        raise ValueError("holdout seal differs from frozen inputs")
    commit = _git("rev-parse", f"{seal['freeze']['commit']}^{{commit}}")
    if commit != seal["freeze"]["commit"] or _git("show", "-s", "--format=%T", commit) != seal["freeze"]["tree"]:
        raise ValueError("holdout seal freeze identity differs")
    if seal["candidate_freeze_sha256"] != file_sha256(calibration_data_root() / "candidate-freeze.json"):
        raise ValueError("holdout seal candidate freeze differs")
    if freeze["phase"] != "FROZEN_TITLE_CANDIDATE" or seal["inconsistent_case_count"] < 15:
        raise ValueError("holdout seal contract differs")
    if assets_dir is not None:
        from .capture import _verify_assets

        _verify_assets(generation, assets_dir)
    if require_unconsumed:
        state = load_json(STATE_PATH)
        if state != initial_state(commit) or value_sha256(state) != seal["initial_state_sha256"]:
            raise ValueError("holdout one-shot state is not sealed and unconsumed")
        if EVIDENCE_ROOT.exists():
            raise ValueError("candidate output exists before the one-shot claim")
    return seal
