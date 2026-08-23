"""Tracked, byte-exact evidence for the one consumed Iteration 2 fresh-holdout run.

The authoritative run directory is ignored, local and already consumed. This module copies
its three raw files into the tracked evidence tree without reformatting them, binds them to
the frozen protocol/corpus/candidate identities, and then re-proves the recorded result from
those bytes alone.

``validate_result_evidence`` is the permanent guard. It re-scores the tracked capture through
the same frozen :func:`score_holdout_capture` path the run used and requires the recomputed
report to equal the tracked report canonically, so the stored decision can never drift away
from its own raw evidence. It loads no OCR provider, downloads no model and never touches the
ignored run directory: everything it reads is tracked, so clean lightweight CI can verify the
final result forever.
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Any

from ..ocr_iteration2_holdout_protocol.schema import (
    canonical_json_bytes,
    data_root as protocol_data_root,
    load_json,
    repository_root,
    validate_protocol,
    value_sha256,
)
from .corpus import corpus_path
from .runner import CAPTURE_FILENAME, REPORT_FILENAME, score_holdout_capture


EVIDENCE_SCHEMA = "pp1-ocr-iteration2-result-evidence/v1"
STATE_SCHEMA = "pp1-ocr-iteration2-one-shot-state/v1"
CAPTURE_SCHEMA = "pp1-ocr-iteration2-capture/v1"
REPORT_SCHEMA = "pp1-ocr-iteration2-one-shot-result/v1"
STATE_FILENAME = "one-shot-state.json"
MANIFEST_FILENAME = "result-evidence.json"
HEX_64 = re.compile(r"^[0-9a-f]{64}$")

# The commit the one authorised run was executed from (the squash merge of PR #172).
EXECUTION_COMMIT_SHA = "62930574a848cd517415bf6e4e6a7d105dda7a5c"
FINAL_DECISION = "OCR_PROVIDER_DEFERRED"
CANDIDATE = "PP-OCRv6 Small"

# Frozen identities the result stays bound to. A change here is a change of experiment.
EXPECTED_PROTOCOL_VERSION = "pp1-ocr-iteration2-holdout-protocol-v3"
EXPECTED_CORPUS_SHA256 = "137484e7b0741b2428f2f53e179f2c85f6c9163ac65256a4619c3f27ca5d2bab"
EXPECTED_FREEZE_TREE_SHA256 = "088d2a43da5c2595ff9098b6cabbc3af19582930ae741fc64dc0878768aef282"
EXPECTED_PRE_RUN_SEAL_SHA256 = "304ba342fd61a9fc781e4c161d162028d1087f4cb98319f71bc10f7aed53409d"
EXPECTED_RESULT_SHA256 = "505f7d30196a4ed19a4853be9c0ff4e61d4afbb976c8c92876cb001596df323f"

# The measured arithmetic. These are observations of the consumed run, re-proved from the
# tracked capture on every check; they are not tunable parameters.
EXPECTED_SCORED_CASES = 40
EXPECTED_FAILED_CASES = 0
EXPECTED_EXACT_TITLES = 38
EXPECTED_EXACT_TITLE_RATE = 0.95
EXPECTED_MATERIAL_FALSE_AGREEMENTS = 0
EXPECTED_PRIMARY_WER_EDITS = 364
EXPECTED_PRIMARY_WER_WORDS = 2296
EXPECTED_DIAGNOSTIC_WER = {
    "raw": (885, 2296),
    "geometry": (885, 2296),
}
EXPECTED_EQUALITY = {"true_positive": 31, "false_positive": 0, "true_negative": 8, "false_negative": 1}
EXPECTED_ASSISTIVE = {"true_positive": 32, "false_positive": 1, "true_negative": 7, "false_negative": 0}
EXPECTED_GATE_FAMILIES = {
    "quality": False,
    "title_safety": True,
    "operational": True,
    "provisioning": True,
    "offline_security": True,
}
EXPECTED_QUALITY_CHECKS = {
    "all_scored_cases_executed": True,
    "exact_title": True,
    "primary_wer": False,
}


def evidence_dir() -> Path:
    return (
        repository_root()
        / "docs"
        / "assistive-validation"
        / "evidence"
        / "ocr-iteration2-fresh-holdout"
    )


def manifest_path() -> Path:
    return evidence_dir() / MANIFEST_FILENAME


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def _file_record(path: Path) -> dict[str, Any]:
    raw = path.read_bytes()
    return {"bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}


def _load_exact(path: Path, expected: dict[str, Any], label: str) -> dict[str, Any]:
    """Read one evidence file and refuse it unless its raw bytes are the recorded bytes."""
    _require(path.is_file(), f"tracked {label} evidence is missing: {path.name}")
    raw = path.read_bytes()
    _require(
        len(raw) == expected["bytes"],
        f"tracked {label} evidence size changed: {len(raw)} != {expected['bytes']}",
    )
    observed = hashlib.sha256(raw).hexdigest()
    _require(
        observed == expected["sha256"],
        f"tracked {label} evidence hash changed: {observed} != {expected['sha256']}",
    )
    value = load_json(path)
    _require(
        canonical_json_bytes(value) == raw,
        f"tracked {label} evidence is not canonical JSON",
    )
    return value


def build_result_evidence(source_dir: Path) -> dict[str, Any]:
    """Build the manifest that binds the copied raw files to the frozen run identity."""
    state = load_json(source_dir / STATE_FILENAME)
    report = load_json(source_dir / REPORT_FILENAME)
    return {
        "schema_version": EVIDENCE_SCHEMA,
        "execution_commit_sha": EXECUTION_COMMIT_SHA,
        "protocol_version": report["protocol_version"],
        "corpus_sha256": report["corpus_sha256"],
        "freeze_tree_sha256": EXPECTED_FREEZE_TREE_SHA256,
        "pre_run_seal_sha256": state["pre_run_seal_sha256"],
        "candidate": report["candidate"],
        "candidate_engine": state["candidate_engine"],
        "configuration": report["configuration"],
        "selector": report["selector"],
        "primary_reading_order": report["primary_reading_order"],
        "files": {
            STATE_FILENAME: _file_record(source_dir / STATE_FILENAME),
            CAPTURE_FILENAME: _file_record(source_dir / CAPTURE_FILENAME),
            REPORT_FILENAME: _file_record(source_dir / REPORT_FILENAME),
        },
        "canonical_report_sha256": value_sha256(report),
        "ocr_run_count": 1,
        "ocr_executed": True,
        "rerun_permitted": False,
        "final_decision": report["decision"],
    }


def _validate_manifest_shape(manifest: dict[str, Any]) -> None:
    _require(manifest.get("schema_version") == EVIDENCE_SCHEMA, "result evidence schema changed")
    _require(
        manifest.get("execution_commit_sha") == EXECUTION_COMMIT_SHA,
        "result evidence execution commit changed",
    )
    _require(
        manifest.get("protocol_version") == EXPECTED_PROTOCOL_VERSION,
        "result evidence protocol binding changed",
    )
    _require(manifest.get("corpus_sha256") == EXPECTED_CORPUS_SHA256, "result evidence corpus binding changed")
    _require(
        manifest.get("freeze_tree_sha256") == EXPECTED_FREEZE_TREE_SHA256,
        "result evidence freeze-tree binding changed",
    )
    _require(
        manifest.get("pre_run_seal_sha256") == EXPECTED_PRE_RUN_SEAL_SHA256,
        "result evidence pre-run-seal binding changed",
    )
    _require(manifest.get("candidate") == CANDIDATE, "result evidence candidate changed")
    _require(manifest.get("candidate_engine") == "paddle-small", "result evidence candidate engine changed")
    _require(
        manifest.get("ocr_run_count") == 1
        and manifest.get("ocr_executed") is True
        and manifest.get("rerun_permitted") is False,
        "result evidence one-shot semantics changed",
    )
    _require(manifest.get("final_decision") == FINAL_DECISION, "result evidence final decision changed")
    _require(
        manifest.get("canonical_report_sha256") == EXPECTED_RESULT_SHA256,
        "result evidence canonical report hash changed",
    )
    files = manifest.get("files")
    _require(isinstance(files, dict), "result evidence file records are missing")
    _require(
        set(files) == {STATE_FILENAME, CAPTURE_FILENAME, REPORT_FILENAME},
        "result evidence file set changed",
    )
    for name, record in files.items():
        _require(isinstance(record, dict), f"result evidence record for {name} is malformed")
        _require(isinstance(record.get("bytes"), int) and record["bytes"] > 0, f"{name} size is not recorded")
        _require(
            isinstance(record.get("sha256"), str) and bool(HEX_64.fullmatch(record["sha256"])),
            f"{name} hash is not a sha256 digest",
        )


def _validate_state(state: dict[str, Any], report_sha256: str) -> None:
    _require(state.get("schema_version") == STATE_SCHEMA, "one-shot state schema changed")
    _require(state.get("status") == "completed", "one-shot state is not a completed run")
    _require(state.get("ocr_executed") is True, "one-shot state does not record an executed run")
    _require(state.get("ocr_run_count") == 1, "one-shot state run count is not exactly one")
    _require(state.get("rerun_permitted") is False, "one-shot state permits a rerun")
    _require(
        state.get("holdout_capture_exists") is True and state.get("holdout_result_exists") is True,
        "one-shot state does not record its capture and result",
    )
    _require(state.get("candidate_engine") == "paddle-small", "one-shot state candidate changed")
    _require(state.get("corpus_sha256") == EXPECTED_CORPUS_SHA256, "one-shot state corpus binding changed")
    _require(
        state.get("pre_run_seal_sha256") == EXPECTED_PRE_RUN_SEAL_SHA256,
        "one-shot state pre-run-seal binding changed",
    )
    _require(
        state.get("result_sha256") == report_sha256,
        "one-shot state result hash does not bind the stored report",
    )


def _validate_arithmetic(report: dict[str, Any]) -> None:
    quality = report["gate_families"]["quality"]
    _require(quality["scored_case_count"] == EXPECTED_SCORED_CASES, "scored case count changed")
    _require(quality["failed_case_count"] == EXPECTED_FAILED_CASES, "failed case count changed")
    _require(len(report["records"]) == EXPECTED_SCORED_CASES, "stored record count changed")
    _require(
        len({record["case_id"] for record in report["records"]}) == EXPECTED_SCORED_CASES,
        "stored records are not one per case",
    )
    _require(report["title_exact_count"] == EXPECTED_EXACT_TITLES, "exact title count changed")
    _require(report["title_exact_rate"] == EXPECTED_EXACT_TITLE_RATE, "exact title rate changed")
    _require(
        report["material_false_automatic_agreements"] == EXPECTED_MATERIAL_FALSE_AGREEMENTS,
        "material false automatic agreement count changed",
    )
    primary = report["word_error_rate"]["column"]
    _require(
        primary["word_edits"] == EXPECTED_PRIMARY_WER_EDITS
        and primary["reference_words"] == EXPECTED_PRIMARY_WER_WORDS,
        "primary WER arithmetic changed",
    )
    _require(
        primary["wer"] == EXPECTED_PRIMARY_WER_EDITS / EXPECTED_PRIMARY_WER_WORDS,
        "primary WER rate does not follow its own numerator and denominator",
    )
    for order, (edits, words) in EXPECTED_DIAGNOSTIC_WER.items():
        observed = report["word_error_rate"][order]
        _require(
            observed["word_edits"] == edits and observed["reference_words"] == words,
            f"{order} diagnostic WER arithmetic changed",
        )
    for label, expected in (("equality", EXPECTED_EQUALITY), ("assistive", EXPECTED_ASSISTIVE)):
        observed = report[f"{label}_precision_recall"]
        for key, value in expected.items():
            _require(observed[key] == value, f"{label} {key} changed")


def _validate_decision(report: dict[str, Any], protocol: dict[str, Any]) -> None:
    families = report["gate_families"]
    contract = protocol["decision_contract"]
    _require(
        set(families) == set(contract["select_gate_families"]) == set(EXPECTED_GATE_FAMILIES),
        "the five recorded gate families changed",
    )
    for name, expected in EXPECTED_GATE_FAMILIES.items():
        _require(families[name]["passed"] is expected, f"gate family {name} outcome changed")
    _require(
        families["quality"]["checks"] == EXPECTED_QUALITY_CHECKS,
        "the quality sub-gate outcomes changed",
    )
    _require(contract["select_requires_all_gates"] is True, "the decision contract no longer requires all gates")
    _require(contract["near_miss_may_select"] is False, "the decision contract now permits a near miss")
    _require(
        report["decision"] == FINAL_DECISION,
        f"the recorded final decision changed: {report['decision']} != {FINAL_DECISION}",
    )


def validate_result_evidence(directory: Path | None = None) -> dict[str, Any]:
    """Re-prove the final Iteration 2 result from tracked bytes alone. Runs no OCR."""
    root = directory if directory is not None else evidence_dir()
    manifest = load_json(root / MANIFEST_FILENAME)
    _validate_manifest_shape(manifest)
    files = manifest["files"]

    state = _load_exact(root / STATE_FILENAME, files[STATE_FILENAME], "state")
    capture = _load_exact(root / CAPTURE_FILENAME, files[CAPTURE_FILENAME], "capture")
    report = _load_exact(root / REPORT_FILENAME, files[REPORT_FILENAME], "report")

    _require(capture.get("schema_version") == CAPTURE_SCHEMA, "tracked capture schema changed")
    _require(report.get("schema_version") == REPORT_SCHEMA, "tracked report schema changed")

    stored_report_sha256 = value_sha256(report)
    _require(
        stored_report_sha256 == files[REPORT_FILENAME]["sha256"] == EXPECTED_RESULT_SHA256,
        "tracked report canonical hash changed",
    )
    _validate_state(state, stored_report_sha256)

    protocol = validate_protocol(load_json(protocol_data_root() / "protocol.json"))
    corpus = load_json(corpus_path())
    _require(
        value_sha256(corpus) == EXPECTED_CORPUS_SHA256,
        "the sealed holdout corpus is no longer the corpus this result was measured on",
    )
    _require(
        protocol["protocol_version"] == EXPECTED_PROTOCOL_VERSION,
        "the frozen protocol version changed",
    )
    _require(
        report["protocol_version"] == EXPECTED_PROTOCOL_VERSION
        and report["corpus_sha256"] == EXPECTED_CORPUS_SHA256
        and report["candidate"] == CANDIDATE
        and report["selector"] == protocol["title_contract"]["selector_id"]
        and report["primary_reading_order"] == protocol["wer_contract"]["primary_order"],
        "the stored report identity no longer matches the frozen protocol",
    )

    expected_ids = {case["id"] for case in corpus["ocr_cases"] if case["split"] == "holdout"}
    captured_ids = {record["case_id"] for record in capture["records"]}
    failed_ids = {failure["case_id"] for failure in capture["failures"]}
    _require(
        captured_ids == expected_ids and not failed_ids,
        "tracked capture case identities differ from the sealed corpus",
    )
    _require(
        len(capture["records"]) == len(captured_ids) == EXPECTED_SCORED_CASES,
        "tracked capture does not hold exactly one record per sealed case",
    )

    # Independent re-score through the frozen scoring path, using the provisioning evidence
    # preserved inside the report itself. No provider is loaded and no capture is performed.
    recomputed = score_holdout_capture(
        capture,
        corpus=corpus,
        protocol=protocol,
        provisioning=report["gate_families"]["provisioning"]["verified_evidence"],
    )
    _require(
        canonical_json_bytes(recomputed) == canonical_json_bytes(report),
        "re-scoring the tracked capture does not reproduce the tracked report",
    )
    _require(
        value_sha256(recomputed) == state["result_sha256"],
        "the re-scored report does not match the hash the run recorded",
    )

    _validate_arithmetic(recomputed)
    _validate_decision(recomputed, protocol)

    return {
        "schema_version": EVIDENCE_SCHEMA,
        "execution_commit_sha": EXECUTION_COMMIT_SHA,
        "protocol_version": EXPECTED_PROTOCOL_VERSION,
        "corpus_sha256": EXPECTED_CORPUS_SHA256,
        "pre_run_seal_sha256": EXPECTED_PRE_RUN_SEAL_SHA256,
        "candidate": CANDIDATE,
        "scored_case_count": EXPECTED_SCORED_CASES,
        "failed_case_count": EXPECTED_FAILED_CASES,
        "title_exact_count": recomputed["title_exact_count"],
        "title_exact_rate": recomputed["title_exact_rate"],
        "material_false_automatic_agreements": recomputed["material_false_automatic_agreements"],
        "primary_wer": recomputed["word_error_rate"]["column"],
        "gate_families": {name: family["passed"] for name, family in recomputed["gate_families"].items()},
        "quality_checks": recomputed["gate_families"]["quality"]["checks"],
        "canonical_report_sha256": stored_report_sha256,
        "recomputed_from_tracked_capture": True,
        "ocr_executed_by_this_check": False,
        "ocr_run_count": 1,
        "rerun_permitted": False,
        "final_decision": recomputed["decision"],
    }
