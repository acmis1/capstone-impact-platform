from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

from ..ocr_title_consistency.evidence import non_reuse_evidence
from ..ocr_title_latency.freeze import check_freeze_manifest
from ..ocr_title_latency.renderer import generate_assets
from ..ocr_title_latency.schema import (
    ASSET_SUFFIX,
    CORPUS_SCHEMA,
    canonical_json_bytes,
    data_root,
    file_sha256,
    load_json,
    repository_root,
    tool_root,
    validate_protocol,
    value_sha256,
)
from .corpus import HOLDOUT_SEED, build_holdout_corpus


HOLDOUT_ROOT = tool_root() / "ocr-title-latency-holdout"
CORPUS_PATH = HOLDOUT_ROOT / "corpus" / "holdout.json"
GENERATION_PATH = HOLDOUT_ROOT / "generation.json"
NON_REUSE_PATH = HOLDOUT_ROOT / "non-reuse.json"
SEAL_PATH = HOLDOUT_ROOT / "seal.json"
STATE_PATH = HOLDOUT_ROOT / "state.json"
EVIDENCE_ROOT = repository_root() / "docs" / "assistive-validation" / "evidence" / "ocr-title-latency-holdout"
RUNNER_SOURCE_NAMES = ("__init__.py", "__main__.py", "capture.py", "corpus.py", "one_shot.py", "seal.py")


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
    if corpus.get("schema_version") != CORPUS_SCHEMA or corpus.get("role") != "holdout":
        raise ValueError("unsupported title-latency holdout corpus")
    cases = corpus.get("ocr_cases")
    if not isinstance(cases, list):
        raise ValueError("title-latency holdout cases must be an array")
    scored = [case for case in cases if case.get("split") == "holdout"]
    warmups = [case for case in cases if case.get("split") == "warmup"]
    if len(scored) != 54 or len(warmups) != 1:
        raise ValueError("title-latency holdout requires 54 scored cases and one warmup")
    if len({case.get("id") for case in cases}) != len(cases):
        raise ValueError("title-latency holdout case IDs are not unique")
    if any(case.get("media") not in ASSET_SUFFIX for case in cases):
        raise ValueError("title-latency holdout contains unsupported media")
    inconsistent = sum(case.get("expected_consistency") == "INCONSISTENT" for case in scored)
    if inconsistent < 18:
        raise ValueError("title-latency holdout has fewer than 18 inconsistent cases")
    cells = {(media, layout): 0 for media in ASSET_SUFFIX for layout in ("one_column", "two_column", "three_column")}
    for case in scored:
        cells[(case["media"], case["layout"])] += 1
        if case.get("expected_visible_title") != case.get("poster_title"):
            raise ValueError("holdout visible-title truth differs from rendered title")
    if set(cells.values()) != {6}:
        raise ValueError("title-latency holdout media/layout cells are not balanced")
    tags = {tag for case in scored for tag in case.get("tags", [])}
    required = {
        "fresh_sealed_holdout", "title_unusually_low", "title_beside_logo", "administrative_heading",
        "title_below_normal_crop", "title_crosses_crop_boundary", "multiline_title", "crop_distractor",
        "title_absent", "ambiguous_title", "low_contrast", "hostile_prompt_text",
    }
    if not required <= tags:
        raise ValueError("title-latency holdout lacks required fast/fallback coverage")
    return corpus


def initial_state(freeze_commit: str) -> dict[str, Any]:
    return {
        "schema_version": "pp1-ocr-title-latency-holdout-state/v1",
        "status": "SEALED_UNCONSUMED",
        "run_count": 0,
        "freeze_commit": freeze_commit,
        "capture_sha256": None,
        "report_sha256": None,
    }


def _prior_records() -> list[dict[str, str]]:
    root = repository_root()
    prior_calibration = load_json(
        root / "docs" / "assistive-validation" / "evidence" / "ocr-title-consistency-calibration" / "calibration-report.json"
    )
    prior_holdout = load_json(
        root / "tools" / "assistive-validation-benchmark" / "ocr-title-consistency-holdout" / "non-reuse.json"
    )
    latency_calibration = load_json(
        root / "docs" / "assistive-validation" / "evidence" / "ocr-title-latency-calibration"
        / "default-cpu-fast-r36-t4-report.json"
    )
    return [
        *prior_calibration["non_reuse"]["records"],
        *prior_holdout["records"],
        *latency_calibration["non_reuse"]["records"],
    ]


def holdout_non_reuse(corpus: dict[str, Any]) -> dict[str, Any]:
    result = non_reuse_evidence(corpus, split="holdout", additional=_prior_records())
    result["prohibited_additional_case_count"] = len(_prior_records())
    return result


def prepare_holdout(freeze_commit: str, assets_dir: Path) -> Path:
    if any(path.exists() for path in (CORPUS_PATH, GENERATION_PATH, NON_REUSE_PATH, SEAL_PATH, STATE_PATH)):
        raise ValueError("title-latency holdout preparation path already exists")
    if EVIDENCE_ROOT.exists():
        raise ValueError("candidate output exists before title-latency holdout preparation")
    freeze = check_freeze_manifest()
    commit = _git("rev-parse", f"{freeze_commit}^{{commit}}")
    if commit != freeze_commit:
        raise ValueError("freeze commit must be a full exact commit identity")
    tracked = json.loads(
        _git("show", f"{commit}:tools/assistive-validation-benchmark/ocr-title-latency-calibration/candidate-freeze.json")
    )
    if tracked != freeze:
        raise ValueError("selected freeze commit does not contain the active title-latency freeze")
    corpus = validate_holdout_corpus(build_holdout_corpus())
    reuse = holdout_non_reuse(corpus)
    if not reuse["passed"]:
        raise ValueError("fresh title-latency holdout reuses historical or calibration content")
    CORPUS_PATH.parent.mkdir(parents=True, exist_ok=True)
    CORPUS_PATH.write_bytes(canonical_json_bytes(corpus))
    generation = generate_assets(corpus, assets_dir)
    GENERATION_PATH.write_bytes(canonical_json_bytes(generation))
    NON_REUSE_PATH.write_bytes(canonical_json_bytes(reuse))
    state = initial_state(commit)
    STATE_PATH.write_bytes(canonical_json_bytes(state))
    protocol = validate_protocol(load_json(data_root() / "protocol.json"))
    source_root = Path(__file__).resolve().parent
    seal = {
        "schema_version": "pp1-ocr-title-latency-holdout-seal/v1",
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
        "fast_path_contract": freeze["fast_path_contract"],
        "title_contract": freeze["title_contract"],
        "quality_gates": freeze["quality_gates"],
        "operational_gates": freeze["operational_gates"],
        "security": freeze["security"],
        "decision_contract": freeze["decision_contract"],
        "seed": HOLDOUT_SEED,
        "scored_case_count": 54,
        "inconsistent_case_count": sum(
            case["expected_consistency"] == "INCONSISTENT" for case in corpus["ocr_cases"] if case["split"] == "holdout"
        ),
        "candidate_output_absent_when_sealed": True,
        "one_shot_run_count": 0,
    }
    SEAL_PATH.write_bytes(canonical_json_bytes(seal))
    return SEAL_PATH


def check_seal(*, assets_dir: Path | None = None, require_unconsumed: bool = False) -> dict[str, Any]:
    freeze = check_freeze_manifest()
    corpus = validate_holdout_corpus(load_json(CORPUS_PATH))
    if corpus != build_holdout_corpus():
        raise ValueError("sealed title-latency holdout differs from deterministic source")
    generation = load_json(GENERATION_PATH)
    reuse = holdout_non_reuse(corpus)
    if load_json(NON_REUSE_PATH) != reuse or not reuse["passed"]:
        raise ValueError("sealed title-latency holdout non-reuse evidence differs")
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
        raise ValueError("title-latency holdout seal differs from frozen inputs")
    commit = _git("rev-parse", f"{seal['freeze']['commit']}^{{commit}}")
    if commit != seal["freeze"]["commit"] or _git("show", "-s", "--format=%T", commit) != seal["freeze"]["tree"]:
        raise ValueError("title-latency holdout seal freeze identity differs")
    tracked = json.loads(
        _git("show", f"{commit}:tools/assistive-validation-benchmark/ocr-title-latency-calibration/candidate-freeze.json")
    )
    if tracked != freeze:
        raise ValueError("sealed freeze commit differs from active title-latency freeze")
    if (
        seal.get("status") != "SEALED_UNCONSUMED"
        or seal.get("scored_case_count") != 54
        or seal.get("inconsistent_case_count", 0) < 18
        or seal.get("one_shot_run_count") != 0
    ):
        raise ValueError("title-latency holdout seal contract differs")
    if assets_dir is not None:
        from .capture import verify_assets

        verify_assets(generation, assets_dir)
    if require_unconsumed:
        state = load_json(STATE_PATH)
        if state != initial_state(commit) or value_sha256(state) != seal["initial_state_sha256"]:
            raise ValueError("title-latency one-shot state is not sealed and unconsumed")
        if EVIDENCE_ROOT.exists():
            raise ValueError("title-latency candidate output exists before one-shot claim")
    return seal
