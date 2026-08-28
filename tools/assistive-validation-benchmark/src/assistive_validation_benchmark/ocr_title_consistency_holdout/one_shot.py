from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..ocr_title_consistency.schema import (
    calibration_data_root,
    canonical_json_bytes,
    load_json,
    validate_corpus,
    validate_protocol,
    value_sha256,
)
from ..ocr_title_consistency.scoring import score_capture
from .capture import capture_holdout
from .seal import (
    CORPUS_PATH,
    EVIDENCE_ROOT,
    GENERATION_PATH,
    SEAL_PATH,
    STATE_PATH,
    check_seal,
)


def _write_state(state: dict[str, Any]) -> None:
    temporary = STATE_PATH.with_suffix(".claim.tmp")
    temporary.write_bytes(canonical_json_bytes(state))
    os.replace(temporary, STATE_PATH)


def run_once(*, assets_dir: Path, run_dir: Path, models_dir: Path) -> dict[str, Any]:
    seal = check_seal(assets_dir=assets_dir, require_unconsumed=True)
    seal_sha = value_sha256(seal)
    started = datetime.now(timezone.utc).isoformat()
    claimed = {
        "schema_version": "pp1-ocr-title-consistency-holdout-state/v1",
        "status": "CONSUMED_CLAIMED",
        "run_count": 1,
        "freeze_commit": seal["freeze"]["commit"],
        "seal_sha256": seal_sha,
        "started_at": started,
        "capture_sha256": None,
        "report_sha256": None,
    }
    _write_state(claimed)
    protocol = validate_protocol(load_json(calibration_data_root() / "protocol.json"))
    corpus = validate_corpus(load_json(CORPUS_PATH), expected_split="holdout", expected_count=45)
    generation = load_json(GENERATION_PATH)
    run_dir.mkdir(parents=True, exist_ok=True)
    try:
        capture = capture_holdout(
            corpus,
            protocol,
            generation,
            assets_dir=assets_dir,
            run_dir=run_dir,
            models_dir=models_dir,
        )
        score = score_capture(capture, corpus, protocol, expected_split="holdout")
        report = {
            "schema_version": "pp1-ocr-title-consistency-holdout-report/v1",
            "freeze_commit": seal["freeze"]["commit"],
            "seal_sha256": seal_sha,
            "capture_sha256": value_sha256(capture),
            "score": score,
            "final_decision": score["decision"],
            "production_integration_permitted": score["final_gates_passed"],
            "post_result_tuning_permitted": False,
        }
        EVIDENCE_ROOT.mkdir(parents=True, exist_ok=False)
        capture_path = EVIDENCE_ROOT / "holdout-capture.json"
        report_path = EVIDENCE_ROOT / "holdout-report.json"
        capture_path.write_bytes(canonical_json_bytes(capture))
        report_path.write_bytes(canonical_json_bytes(report))
        completed = {
            **claimed,
            "status": "CONSUMED_RECORDED",
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "capture_sha256": value_sha256(capture),
            "report_sha256": value_sha256(report),
            "final_decision": report["final_decision"],
        }
        _write_state(completed)
        return report
    except BaseException as error:
        failed = {
            **claimed,
            "status": "CONSUMED_FAILED",
            "failed_at": datetime.now(timezone.utc).isoformat(),
            "error_type": type(error).__name__,
            "error_message": str(error)[:500],
        }
        _write_state(failed)
        raise


def check_result() -> dict[str, Any]:
    seal = check_seal()
    state = load_json(STATE_PATH)
    capture = load_json(EVIDENCE_ROOT / "holdout-capture.json")
    report = load_json(EVIDENCE_ROOT / "holdout-report.json")
    corpus = validate_corpus(load_json(CORPUS_PATH), expected_split="holdout", expected_count=45)
    protocol = validate_protocol(load_json(calibration_data_root() / "protocol.json"))
    score = score_capture(capture, corpus, protocol, expected_split="holdout")
    expected_report = {
        "schema_version": "pp1-ocr-title-consistency-holdout-report/v1",
        "freeze_commit": seal["freeze"]["commit"],
        "seal_sha256": value_sha256(seal),
        "capture_sha256": value_sha256(capture),
        "score": score,
        "final_decision": score["decision"],
        "production_integration_permitted": score["final_gates_passed"],
        "post_result_tuning_permitted": False,
    }
    if report != expected_report:
        raise ValueError("stored holdout result differs from frozen recomputation")
    if (
        state.get("status") != "CONSUMED_RECORDED"
        or state.get("run_count") != 1
        or state.get("capture_sha256") != value_sha256(capture)
        or state.get("report_sha256") != value_sha256(report)
    ):
        raise ValueError("stored holdout one-shot state differs from result evidence")
    return report
