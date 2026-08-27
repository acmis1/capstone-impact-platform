"""Irreversible one-shot runner for the post-freeze full-page title holdout."""

from __future__ import annotations

import copy
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..ocr_iteration3.capture import verify_small_candidate
from ..ocr_productionization.offline import enable_offline_guard
from ..ocr_title_fullpage.freeze import check_freeze_manifest
from ..ocr_title_fullpage.host_load import await_quiet_host
from ..ocr_title_fullpage.schema import canonical_json_bytes, data_root, load_json, repository_root, validate_protocol, value_sha256
from ..ocr_title_fullpage.scoring import score_capture
from .capture import capture_holdout, verify_assets
from .seal import CORPUS_PATH, EVIDENCE_ROOT, GENERATION_PATH, STATE_PATH, check_seal, validate_holdout_corpus


def _write_state(state: dict[str, Any]) -> None:
    temporary = STATE_PATH.with_suffix(".claim.tmp")
    temporary.write_bytes(canonical_json_bytes(state))
    os.replace(temporary, STATE_PATH)


def _score_holdout(capture: dict[str, Any], corpus: dict[str, Any], protocol: dict[str, Any]) -> dict[str, Any]:
    scoring_view = copy.deepcopy(corpus)
    scoring_view["role"] = "calibration"
    for case in scoring_view["ocr_cases"]:
        if case["split"] == "holdout":
            case["split"] = "calibration"
    score = score_capture(capture, scoring_view, protocol)
    score["role"] = "holdout"
    score["final_gate_checks"]["environment_validity"] = capture["host_load"]["quiescent"] is True
    score["final_gates_passed"] = all(score["final_gate_checks"].values())
    score["decision"] = (
        "READY_FOR_TITLE_OCR_INTEGRATION" if score["final_gates_passed"] else "OCR_TITLE_PROVIDER_DEFERRED"
    )
    return score


def preflight(*, assets_dir: Path, run_dir: Path, models_dir: Path) -> dict[str, Any]:
    import psutil

    seal = check_seal(assets_dir=assets_dir, require_unconsumed=True)
    freeze = check_freeze_manifest()
    protocol = validate_protocol(load_json(data_root() / "protocol.json"))
    generation = load_json(GENERATION_PATH)
    verify_assets(generation, assets_dir)
    provisioning = verify_small_candidate(protocol, models_dir)
    offline = enable_offline_guard()
    host_precondition = await_quiet_host(protocol["repeatability"]["host_load_control"])
    disk_root = run_dir.parent if run_dir.parent.exists() else repository_root()
    disk_free = shutil.disk_usage(disk_root).free
    memory_available = psutil.virtual_memory().available
    if disk_free < 1_073_741_824:
        raise ValueError("insufficient free disk for sealed title-fullpage v2 holdout")
    if memory_available < 1_073_741_824:
        raise ValueError("insufficient available memory for sealed title-fullpage v2 holdout")
    return {
        "schema_version": "pp1-ocr-title-fullpage-holdout-v2-preflight/v1",
        "passed": True,
        "freeze_commit": seal["freeze"]["commit"],
        "freeze_source_sha256": freeze["source_files_sha256"],
        "seal_sha256": value_sha256(seal),
        "provisioning": provisioning,
        "offline": offline,
        "host_precondition": host_precondition,
        "download_required": False,
        "disk_free_bytes": disk_free,
        "memory_available_bytes": memory_available,
        "state_unconsumed": True,
    }


def run_once(*, assets_dir: Path, run_dir: Path, models_dir: Path) -> dict[str, Any]:
    preflight_evidence = preflight(assets_dir=assets_dir, run_dir=run_dir, models_dir=models_dir)
    seal = check_seal(assets_dir=assets_dir, require_unconsumed=True)
    started = datetime.now(timezone.utc).isoformat()
    claimed = {
        "schema_version": "pp1-ocr-title-fullpage-holdout-v2-state/v1",
        "status": "CONSUMED_CLAIMED",
        "run_count": 1,
        "freeze_commit": seal["freeze"]["commit"],
        "seal_sha256": value_sha256(seal),
        "started_at": started,
        "capture_sha256": None,
        "report_sha256": None,
    }
    _write_state(claimed)
    protocol = validate_protocol(load_json(data_root() / "protocol.json"))
    corpus = validate_holdout_corpus(load_json(CORPUS_PATH))
    generation = load_json(GENERATION_PATH)
    configuration = dict(seal["configuration"])
    selector_id = seal["selector"]["selected_selector_id"]
    run_dir.mkdir(parents=True, exist_ok=True)
    try:
        capture = capture_holdout(
            corpus,
            protocol,
            generation,
            configuration,
            selector_id,
            preflight_evidence,
            assets_dir=assets_dir,
            run_dir=run_dir,
            models_dir=models_dir,
        )
        score = _score_holdout(capture, corpus, protocol)
        report = {
            "schema_version": "pp1-ocr-title-fullpage-holdout-v2-report/v1",
            "freeze_commit": seal["freeze"]["commit"],
            "freeze_tree": seal["freeze"]["tree"],
            "seal_sha256": value_sha256(seal),
            "capture_sha256": value_sha256(capture),
            "score": score,
            "final_decision": score["decision"],
            "production_integration_permitted": score["final_gates_passed"],
            "post_result_tuning_permitted": False,
        }
        EVIDENCE_ROOT.mkdir(parents=True, exist_ok=False)
        (EVIDENCE_ROOT / "holdout-capture.json").write_bytes(canonical_json_bytes(capture))
        (EVIDENCE_ROOT / "holdout-report.json").write_bytes(canonical_json_bytes(report))
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
    corpus = validate_holdout_corpus(load_json(CORPUS_PATH))
    protocol = validate_protocol(load_json(data_root() / "protocol.json"))
    score = _score_holdout(capture, corpus, protocol)
    expected = {
        "schema_version": "pp1-ocr-title-fullpage-holdout-v2-report/v1",
        "freeze_commit": seal["freeze"]["commit"],
        "freeze_tree": seal["freeze"]["tree"],
        "seal_sha256": value_sha256(seal),
        "capture_sha256": value_sha256(capture),
        "score": score,
        "final_decision": score["decision"],
        "production_integration_permitted": score["final_gates_passed"],
        "post_result_tuning_permitted": False,
    }
    if report != expected:
        raise ValueError("stored title-fullpage v2 result differs from frozen recomputation")
    if (
        state.get("status") != "CONSUMED_RECORDED"
        or state.get("run_count") != 1
        or state.get("capture_sha256") != value_sha256(capture)
        or state.get("report_sha256") != value_sha256(report)
        or state.get("final_decision") != report["final_decision"]
    ):
        raise ValueError("stored title-fullpage v2 one-shot state differs from result evidence")
    if report["final_decision"] not in {
        "READY_FOR_TITLE_OCR_INTEGRATION",
        "OCR_TITLE_PROVIDER_DEFERRED",
        "HOLDOUT_INVALID_PROTOCOL_BUG",
    }:
        raise ValueError("stored title-fullpage v2 decision is outside the frozen contract")
    return report
