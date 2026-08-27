"""Seal and replay checks for the post-freeze full-page title holdout."""

from __future__ import annotations

import json
import string
import subprocess
from pathlib import Path
from typing import Any

from ..ocr_title_fullpage.corpus import build_calibration_corpus
from ..ocr_title_fullpage.evidence import calibration_non_reuse, non_reuse_evidence
from ..ocr_title_fullpage.freeze import check_freeze_manifest
from ..ocr_title_fullpage.renderer import generate_assets
from ..ocr_title_fullpage.schema import (
    ASSET_SUFFIX,
    CORPUS_SCHEMA,
    LAYOUTS,
    canonical_json_bytes,
    data_root,
    file_sha256,
    load_json,
    repository_root,
    tool_root,
    validate_protocol,
    value_sha256,
)
from .corpus import HOLDOUT_SEED, HOLDOUT_VERSION, build_holdout_corpus


HOLDOUT_ROOT = tool_root() / "ocr-title-fullpage-holdout-v2"
CORPUS_PATH = HOLDOUT_ROOT / "corpus" / "holdout.json"
GENERATION_PATH = HOLDOUT_ROOT / "generation.json"
NON_REUSE_PATH = HOLDOUT_ROOT / "non-reuse.json"
SEAL_PATH = HOLDOUT_ROOT / "seal.json"
STATE_PATH = HOLDOUT_ROOT / "state.json"
EVIDENCE_ROOT = repository_root() / "docs" / "assistive-validation" / "evidence" / "ocr-title-fullpage-holdout-v2"
RUNNER_SOURCE_NAMES = ("__init__.py", "__main__.py", "capture.py", "corpus.py", "one_shot.py", "seal.py")
FREEZE_RELATIVE = "tools/assistive-validation-benchmark/ocr-title-fullpage-calibration/candidate-freeze.json"


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


def validate_holdout_corpus(corpus: dict[str, Any]) -> dict[str, Any]:
    if (
        corpus.get("schema_version") != CORPUS_SCHEMA
        or corpus.get("corpus_version") != HOLDOUT_VERSION
        or corpus.get("role") != "holdout"
        or corpus.get("seed") != HOLDOUT_SEED
    ):
        raise ValueError("unsupported title-fullpage v2 holdout corpus")
    if len(HOLDOUT_SEED) != 32 or any(character not in string.hexdigits for character in HOLDOUT_SEED):
        raise ValueError("title-fullpage holdout seed is not 128-bit hexadecimal")
    cases = corpus.get("ocr_cases")
    if not isinstance(cases, list):
        raise ValueError("title-fullpage holdout cases must be an array")
    scored = [case for case in cases if case.get("split") == "holdout"]
    warmups = [case for case in cases if case.get("split") == "warmup"]
    if len(scored) != 60 or len(warmups) != 1:
        raise ValueError("title-fullpage v2 holdout requires 60 scored cases and one warmup")
    if len({case.get("id") for case in cases}) != len(cases):
        raise ValueError("title-fullpage v2 holdout case IDs are not unique")
    if any(case.get("media") not in ASSET_SUFFIX for case in cases):
        raise ValueError("title-fullpage v2 holdout contains unsupported media")
    inconsistent = sum(case.get("expected_consistency") == "INCONSISTENT" for case in scored)
    if inconsistent < 20:
        raise ValueError("title-fullpage v2 holdout has fewer than twenty inconsistent cases")
    cells = {(media, layout): 0 for media in ASSET_SUFFIX for layout in LAYOUTS}
    for case in scored:
        cells[(case["media"], case["layout"])] += 1
        if case.get("expected_visible_title") != case.get("poster_title"):
            raise ValueError("title-fullpage v2 visible-title truth differs from rendered title")
    if max(cells.values()) - min(cells.values()) > 1 or sum(cells.values()) != 60:
        raise ValueError("title-fullpage v2 media/layout cells are not balanced")
    required_families = {
        "administrative_heading_above",
        "administrative_line_adjacent",
        "ambiguous_headings",
        "branding_above",
        "hostile_prompt_text",
        "low_contrast",
        "multiline_title",
        "repeated_title_in_body",
        "short_second_line",
        "small_title",
        "status_line_below",
        "subtitle_below",
        "title_absent",
    }
    if not required_families <= {case["family"] for case in scored}:
        raise ValueError("title-fullpage v2 holdout lacks required difficulty coverage")
    return corpus


def initial_state(freeze_commit: str) -> dict[str, Any]:
    return {
        "schema_version": "pp1-ocr-title-fullpage-holdout-v2-state/v1",
        "status": "SEALED_UNCONSUMED",
        "run_count": 0,
        "freeze_commit": freeze_commit,
        "capture_sha256": None,
        "report_sha256": None,
    }


def _calibration_reuse(records: list[dict[str, str]]) -> dict[str, Any]:
    calibration = calibration_non_reuse(build_calibration_corpus())
    fields = (
        "normalized_metadata_title",
        "normalized_poster_title",
        "normalized_full_reference_sha256",
        "meaningful_case_identity_sha256",
    )
    prior = {field: {record[field] for record in calibration["records"] if record[field]} for field in fields}
    reuse = {
        field: sorted(record["case_id"] for record in records if record[field] and record[field] in prior[field])
        for field in fields
    }
    return {
        "calibration_corpus_sha256": value_sha256(build_calibration_corpus()),
        "calibration_case_count": len(calibration["records"]),
        "reuse_case_ids": reuse,
        "prohibited_reuse_count": sum(len(case_ids) for case_ids in reuse.values()),
    }


def holdout_non_reuse(corpus: dict[str, Any]) -> dict[str, Any]:
    result = non_reuse_evidence(corpus, split="holdout")
    current_calibration = _calibration_reuse(result["records"])
    result["current_calibration"] = current_calibration
    result["prohibited_reuse_count"] += current_calibration["prohibited_reuse_count"]
    result["passed"] = result["passed"] and current_calibration["prohibited_reuse_count"] == 0
    return result


def _tracked_freeze(commit: str) -> dict[str, Any]:
    return json.loads(_git("show", f"{commit}:{FREEZE_RELATIVE}"))


def prepare_holdout(freeze_commit: str, assets_dir: Path) -> Path:
    if any(path.exists() for path in (CORPUS_PATH, GENERATION_PATH, NON_REUSE_PATH, SEAL_PATH, STATE_PATH)):
        raise ValueError("title-fullpage v2 holdout preparation path already exists")
    if EVIDENCE_ROOT.exists():
        raise ValueError("candidate output exists before title-fullpage v2 holdout preparation")
    freeze = check_freeze_manifest()
    commit = _git("rev-parse", f"{freeze_commit}^{{commit}}")
    if commit != freeze_commit:
        raise ValueError("freeze commit must be a full exact commit identity")
    if _tracked_freeze(commit) != freeze:
        raise ValueError("selected freeze commit does not contain the active title-fullpage freeze")
    corpus = validate_holdout_corpus(build_holdout_corpus())
    reuse = holdout_non_reuse(corpus)
    if not reuse["passed"]:
        raise ValueError("fresh title-fullpage v2 holdout reuses prohibited content")
    CORPUS_PATH.parent.mkdir(parents=True, exist_ok=True)
    CORPUS_PATH.write_bytes(canonical_json_bytes(corpus))
    generation = generate_assets(corpus, assets_dir)
    GENERATION_PATH.write_bytes(canonical_json_bytes(generation))
    NON_REUSE_PATH.write_bytes(canonical_json_bytes(reuse))
    state = initial_state(commit)
    STATE_PATH.write_bytes(canonical_json_bytes(state))
    protocol = validate_protocol(load_json(data_root() / "protocol.json"))
    source_root = Path(__file__).resolve().parent
    scored = [case for case in corpus["ocr_cases"] if case["split"] == "holdout"]
    cells = {
        f"{media}:{layout}": sum(case["media"] == media and case["layout"] == layout for case in scored)
        for media in ASSET_SUFFIX
        for layout in LAYOUTS
    }
    seal = {
        "schema_version": "pp1-ocr-title-fullpage-holdout-v2-seal/v1",
        "status": "SEALED_UNCONSUMED",
        "freeze": {"commit": commit, "tree": _git("show", "-s", "--format=%T", commit)},
        "candidate_freeze_sha256": file_sha256(data_root() / "candidate-freeze.json"),
        "protocol_sha256": value_sha256(protocol),
        "corpus_sha256": value_sha256(corpus),
        "generation_sha256": value_sha256(generation),
        "corpus_asset_sha256": generation["corpus_asset_sha256"],
        "non_reuse_sha256": value_sha256(reuse),
        "initial_state_sha256": value_sha256(state),
        "runner_source_files": {name: file_sha256(source_root / name) for name in RUNNER_SOURCE_NAMES},
        "frozen_candidate_source_files": freeze["source_files"],
        "frozen_scorer_sha256": freeze["source_files"]["scoring.py"],
        "candidate": freeze["model"],
        "configuration": freeze["selected_configuration"],
        "selector": freeze["selector"],
        "title_contract": freeze["title_contract"],
        "quality_gates": freeze["quality_gates"],
        "operational_gates": freeze["operational_gates"],
        "environment_validity": freeze["repeatability"]["host_load_control"],
        "security": freeze["security"],
        "input_output_bounds": freeze["input_output_bounds"],
        "decision_contract": freeze["decision_contract"],
        "seed": HOLDOUT_SEED,
        "seed_bits": 128,
        "corpus_version": HOLDOUT_VERSION,
        "scored_case_count": len(scored),
        "warmup_case_count": 1,
        "inconsistent_case_count": sum(case["expected_consistency"] == "INCONSISTENT" for case in scored),
        "media_layout_cells": cells,
        "historical_corpus_count": reuse["historical_corpus_count"],
        "historical_case_count": reuse["historical_case_count"],
        "exposed_v1_fingerprint_case_count": reuse["exposed_invalid_holdout"]["fingerprint_case_count"],
        "current_calibration_case_count": reuse["current_calibration"]["calibration_case_count"],
        "candidate_output_absent_when_sealed": True,
        "one_shot_run_count": 0,
    }
    SEAL_PATH.write_bytes(canonical_json_bytes(seal))
    return SEAL_PATH


def check_seal(*, assets_dir: Path | None = None, require_unconsumed: bool = False) -> dict[str, Any]:
    freeze = check_freeze_manifest()
    corpus = validate_holdout_corpus(load_json(CORPUS_PATH))
    if corpus != build_holdout_corpus():
        raise ValueError("sealed title-fullpage v2 corpus differs from deterministic source")
    generation = load_json(GENERATION_PATH)
    reuse = holdout_non_reuse(corpus)
    if load_json(NON_REUSE_PATH) != reuse or not reuse["passed"]:
        raise ValueError("sealed title-fullpage v2 non-reuse evidence differs")
    seal = load_json(SEAL_PATH)
    source_root = Path(__file__).resolve().parent
    expected = {
        "candidate_freeze_sha256": file_sha256(data_root() / "candidate-freeze.json"),
        "protocol_sha256": value_sha256(validate_protocol(load_json(data_root() / "protocol.json"))),
        "corpus_sha256": value_sha256(corpus),
        "generation_sha256": value_sha256(generation),
        "corpus_asset_sha256": generation["corpus_asset_sha256"],
        "non_reuse_sha256": value_sha256(reuse),
        "runner_source_files": {name: file_sha256(source_root / name) for name in RUNNER_SOURCE_NAMES},
        "frozen_candidate_source_files": freeze["source_files"],
        "frozen_scorer_sha256": freeze["source_files"]["scoring.py"],
    }
    if any(seal.get(key) != value for key, value in expected.items()):
        raise ValueError("title-fullpage v2 holdout seal differs from frozen inputs")
    commit = _git("rev-parse", f"{seal['freeze']['commit']}^{{commit}}")
    if commit != seal["freeze"]["commit"] or _git("show", "-s", "--format=%T", commit) != seal["freeze"]["tree"]:
        raise ValueError("title-fullpage v2 freeze identity differs")
    if _tracked_freeze(commit) != freeze:
        raise ValueError("sealed freeze commit differs from active title-fullpage freeze")
    if (
        seal.get("status") != "SEALED_UNCONSUMED"
        or seal.get("seed") != HOLDOUT_SEED
        or seal.get("seed_bits") != 128
        or seal.get("scored_case_count") != 60
        or seal.get("inconsistent_case_count", 0) < 20
        or seal.get("one_shot_run_count") != 0
    ):
        raise ValueError("title-fullpage v2 holdout seal contract differs")
    if assets_dir is not None:
        from .capture import verify_assets

        verify_assets(generation, assets_dir)
    if require_unconsumed:
        state = load_json(STATE_PATH)
        if state != initial_state(commit) or value_sha256(state) != seal["initial_state_sha256"]:
            raise ValueError("title-fullpage v2 one-shot state is not sealed and unconsumed")
        if EVIDENCE_ROOT.exists():
            raise ValueError("title-fullpage v2 candidate output exists before one-shot claim")
    return seal
