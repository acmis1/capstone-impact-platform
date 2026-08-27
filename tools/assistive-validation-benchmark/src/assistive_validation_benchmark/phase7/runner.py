from __future__ import annotations

import hashlib
import json
import os
import platform
import shutil
import subprocess
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, BinaryIO

from .grammar import local_languagetool_server, run_harper, run_languagetool
from .evaluation import evaluate_engine_findings
from .freeze import load_freeze_manifest, normalised_text_sha256, verify_freeze_commit
from .history import check_calibration_non_reuse, check_fresh_holdout_non_reuse
from .policy import EXPECTED_ENGINES, canonical_json_bytes, validate_policy, value_sha256

EVIDENCE_SCHEMA_VERSION = 1
PRODUCTION_BOUNDARY = {
    "production_language_integration": False,
    "production_runtime_changed": False,
    "database_migration_added": False,
    "hosted_supabase_touched": False,
    "render_touched": False,
    "duda_touched": False,
    "teammate_owned_surface_modified": False,
    "cloud_ai_used": False,
    "llm_judge_used": False,
    "real_participant_data_used": False,
}


def _command_version(command: list[str]) -> str | None:
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=30, shell=False)
    except (OSError, subprocess.SubprocessError):
        return None
    output = f"{result.stdout}\n{result.stderr}".strip()
    return output.splitlines()[0].strip() if output else None


def runtime_identity() -> dict[str, Any]:
    node = shutil.which("node")
    java = shutil.which("java")
    return {
        "python": platform.python_version(),
        "node": _command_version([node, "--version"]) if node else None,
        "java": _command_version([java, "-version"]) if java else None,
        "platform": platform.platform(),
        "cpu_only": True,
    }


def _stream_sha256(stream: BinaryIO) -> str:
    digest = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        digest.update(chunk)
    return digest.hexdigest()


def _file_sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return _stream_sha256(stream)


def verify_candidate_artifacts(
    tool_root: Path,
    policy: dict[str, Any],
    languagetool_archive: Path,
    languagetool_jar: Path,
) -> dict[str, Any]:
    harper_package = tool_root / "node_modules" / "harper.js" / "package.json"
    if not harper_package.is_file():
        raise ValueError("Pinned local Harper package is unavailable")
    harper_version = json.loads(harper_package.read_text(encoding="utf-8")).get("version")
    if harper_version != policy["engines"]["harper"]["version"]:
        raise ValueError("Local Harper package differs from the frozen candidate")
    lock_path = tool_root / "package-lock.json"
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    locked_harper = lock.get("packages", {}).get("node_modules/harper.js", {}).get("version")
    if locked_harper != harper_version:
        raise ValueError("Harper package-lock identity differs from the installed candidate")

    lt_contract = policy["engines"]["languagetool"]["runtime_contract"]
    if languagetool_archive.name != lt_contract["archive_name"] or not languagetool_archive.is_file():
        raise ValueError("LanguageTool must use the frozen official numbered archive")
    archive_sha = _file_sha256(languagetool_archive)
    if archive_sha != lt_contract["archive_sha256"]:
        raise ValueError("LanguageTool archive SHA-256 differs from the reviewed 6.6 artifact")
    if not languagetool_jar.is_file() or languagetool_jar.name != "languagetool-server.jar":
        raise ValueError("LanguageTool server jar is unavailable")
    member_name = lt_contract["server_member"]
    with zipfile.ZipFile(languagetool_archive) as archive:
        if member_name not in archive.namelist():
            raise ValueError("Frozen LanguageTool archive does not contain the expected 6.6 server jar")
        with archive.open(member_name) as member:
            member_sha = _stream_sha256(member)
    jar_sha = _file_sha256(languagetool_jar)
    if member_sha != jar_sha:
        raise ValueError("Extracted LanguageTool server jar differs from the frozen archive member")
    return {
        "harper": {
            "package": "harper.js",
            "version": harper_version,
            "package_lock_sha256": normalised_text_sha256(lock_path),
        },
        "languagetool": {
            "archive_name": languagetool_archive.name,
            "archive_sha256": archive_sha,
            "server_member": member_name,
            "server_jar_sha256": jar_sha,
        },
    }


def _normalise_engine_result(
    name: str,
    raw: dict[str, Any],
    cases: list[dict[str, Any]],
    policy: dict[str, Any],
) -> dict[str, Any]:
    expected = policy["engines"][name]
    if raw.get("status") != "ok":
        raise RuntimeError(f"Required {name} candidate did not execute: {raw.get('status')}")
    if raw.get("version") != expected["version"]:
        raise RuntimeError(
            f"{name} reported {raw.get('version')!r}; frozen candidate is {expected['version']}"
        )
    if raw.get("configuration") != expected["configuration"]:
        raise RuntimeError(f"{name} candidate configuration differs from the frozen policy")
    findings = raw.pop("case_findings")
    return {
        "engine": name,
        "status": "ok",
        "version": raw["version"],
        "dependency_source": raw["dependency_source"],
        "license": raw["license"],
        "backend": raw["backend"],
        "configuration": raw["configuration"],
        "cold_start_ms": raw.get("cold_start_ms"),
        "process_runtime_ms": raw.get("process_runtime_ms"),
        "latency_p50_ms": raw.get("latency_p50_ms"),
        "latency_p95_ms": raw.get("latency_p95_ms"),
        "peak_memory_bytes": raw.get("peak_memory_bytes"),
        "excluded_non_prose_finding_count": raw.get("excluded_non_prose_finding_count", 0),
        "evaluation": evaluate_engine_findings(name, cases, findings, policy),
    }


def run_candidates(
    cases: list[dict[str, Any]],
    *,
    tool_root: Path,
    policy: dict[str, Any],
    languagetool_archive: Path,
    languagetool_jar: Path,
) -> tuple[dict[str, Any], dict[str, Any]]:
    artifacts = verify_candidate_artifacts(tool_root, policy, languagetool_archive, languagetool_jar)
    harper = run_harper(cases, tool_root)
    with local_languagetool_server(languagetool_jar) as server:
        languagetool = run_languagetool(cases, server["base_url"], server["pid"])
        languagetool["cold_start_ms"] = server["cold_start_ms"]
    engines = {
        "harper": _normalise_engine_result("harper", harper, cases, policy),
        "languagetool": _normalise_engine_result("languagetool", languagetool, cases, policy),
    }
    return engines, artifacts


def preflight_candidate_runtime(
    *,
    tool_root: Path,
    policy: dict[str, Any],
    languagetool_archive: Path,
    languagetool_jar: Path,
) -> dict[str, Any]:
    artifacts = verify_candidate_artifacts(tool_root, policy, languagetool_archive, languagetool_jar)
    if shutil.which("node") is None or shutil.which("java") is None:
        raise RuntimeError("Frozen local candidate runtimes are unavailable")
    with local_languagetool_server(languagetool_jar) as server:
        startup = {"loopback": server["base_url"].startswith("http://127.0.0.1:"), "cold_start_ms": server["cold_start_ms"]}
    if startup["loopback"] is not True:
        raise RuntimeError("LanguageTool preflight did not bind to IPv4 loopback")
    return {"artifacts": artifacts, "runtime": startup}


def derive_decisions(engines: dict[str, Any], policy: dict[str, Any]) -> dict[str, Any]:
    scoring = policy["scoring"]
    calibration_candidate = policy["calibration_gates"]["candidate"]
    quality: dict[str, tuple[float, float, int, float]] = {}
    for name, engine in engines.items():
        if name != calibration_candidate:
            continue
        metrics = engine["evaluation"]["policy"]
        if metrics["precision"] >= scoring["precision_gate"] and metrics["recall"] >= scoring["recall_gate"]:
            quality[name] = (
                metrics["precision"],
                metrics["recall"],
                -metrics["false_positives"],
                -(engine["latency_p95_ms"] or float("inf")),
            )
    winner = max(quality, key=lambda name: quality[name]) if quality else None
    decisions: dict[str, Any] = {}
    for name in ("harper", "languagetool"):
        metrics = engines[name]["evaluation"]["policy"]
        decision = "READY_FOR_LANGUAGE_INTEGRATION" if name == winner else "LANGUAGE_PROVIDER_DEFERRED"
        if name != calibration_candidate:
            reason = "Comparator did not clear the frozen overall calibration recall margin and is not final-eligible."
        elif metrics["precision"] < scoring["precision_gate"]:
            reason = (
                f"Holdout precision {metrics['precision']:.1%} fails the frozen "
                f"{scoring['precision_gate']:.1%} gate."
            )
        elif metrics["recall"] < scoring["recall_gate"]:
            reason = (
                f"Holdout recall {metrics['recall']:.1%} fails the frozen anti-triviality "
                f"{scoring['recall_gate']:.1%} gate."
            )
        elif name == winner:
            reason = "Candidate meets both frozen gates and leads the frozen selection order."
        else:
            reason = "Candidate meets both frozen gates but does not lead the frozen selection order."
        decisions[name] = {
            "decision": decision,
            "bounded_role": "non_authoritative_language_suggestions_for_staff_review",
            "reason": reason,
        }
    return decisions


def _corpus_summary(cases: list[dict[str, Any]], corpus_version: str) -> dict[str, Any]:
    return {
        "corpus_version": corpus_version,
        "case_count": len(cases),
        "clean_case_count": sum(case["intentionally_clean"] for case in cases),
        "error_case_count": sum(not case["intentionally_clean"] for case in cases),
        "issue_count": sum(len(case["issues"]) for case in cases),
        "fields": sorted({case["field"] for case in cases}),
        "error_categories": sorted({issue["category"] for case in cases for issue in case["issues"]}),
    }


def _base_report(
    measurement: str,
    cases: list[dict[str, Any]],
    corpus_version: str,
    policy: dict[str, Any],
    policy_summary: dict[str, Any],
    engines: dict[str, Any],
    artifacts: dict[str, Any],
) -> dict[str, Any]:
    return {
        "evidence_schema_version": EVIDENCE_SCHEMA_VERSION,
        "evidence_schema": "pp1_assistive_final_language_evidence_v1",
        "benchmark": "PP1 final spelling and grammar qualification benchmark",
        "measurement": measurement,
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "policy_id": policy["policy_id"],
        "policy_sha256": value_sha256(policy),
        "policy_summary": policy_summary,
        "corpus": _corpus_summary(cases, corpus_version),
        "runtime": runtime_identity(),
        "candidate_artifacts": artifacts,
        "engines": engines,
        "production_boundary": dict(PRODUCTION_BOUNDARY),
    }


def build_calibration_report(
    cases: list[dict[str, Any]],
    corpus_version: str,
    *,
    tool_root: Path,
    repository_root: Path,
    policy: dict[str, Any],
    languagetool_archive: Path,
    languagetool_jar: Path,
) -> dict[str, Any]:
    policy_summary = validate_policy(policy, cases, repository_root)
    engines, artifacts = run_candidates(
        cases,
        tool_root=tool_root,
        policy=policy,
        languagetool_archive=languagetool_archive,
        languagetool_jar=languagetool_jar,
    )
    report = _base_report(
        "calibration", cases, corpus_version, policy, policy_summary, engines, artifacts
    )
    report["calibration_non_reuse"] = check_calibration_non_reuse(tool_root, cases)
    report["scientific_integrity"] = {
        "calibration_only": True,
        "fresh_holdout_exists": False,
        "holdout_informed_policy": False,
        "synthetic_only": True,
    }
    return report


def build_final_report(
    holdout_cases: list[dict[str, Any]],
    holdout_corpus_version: str,
    calibration_cases: list[dict[str, Any]],
    *,
    tool_root: Path,
    repository_root: Path,
    policy: dict[str, Any],
    freeze_commit_sha: str,
    languagetool_archive: Path,
    languagetool_jar: Path,
) -> dict[str, Any]:
    policy_summary = validate_policy(policy, calibration_cases, repository_root)
    freeze_manifest = load_freeze_manifest(tool_root / "phase7" / "freeze-manifest.json", tool_root)
    freeze = verify_freeze_commit(tool_root, freeze_commit_sha, freeze_manifest)
    non_reuse = check_fresh_holdout_non_reuse(tool_root, calibration_cases, holdout_cases)
    engines, artifacts = run_candidates(
        holdout_cases,
        tool_root=tool_root,
        policy=policy,
        languagetool_archive=languagetool_archive,
        languagetool_jar=languagetool_jar,
    )
    report = _base_report(
        "final", holdout_cases, holdout_corpus_version, policy, policy_summary, engines, artifacts
    )
    report["protocol_freeze"] = freeze
    report["holdout_non_reuse"] = non_reuse
    report["decisions"] = derive_decisions(engines, policy)
    report["scientific_integrity"] = {
        "calibration_only_policy_development": True,
        "policy_frozen_before_fresh_holdout": True,
        "final_measurement_number": 1,
        "post_holdout_retuning": False,
        "synthetic_only": True,
    }
    return report


def _replace_json(path: Path, value: dict[str, Any]) -> None:
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("x", encoding="utf-8", newline="\n") as stream:
        stream.write(canonical_json_bytes(value).decode("utf-8"))
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def seal_one_shot_state(
    state_path: Path,
    holdout_path: Path,
    policy_sha256: str,
    freeze_sha: str,
) -> Path:
    state_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema_version": 1,
        "status": "SEALED_UNCONSUMED",
        "policy_sha256": policy_sha256,
        "policy_freeze_commit_sha": freeze_sha,
        "holdout_sha256": normalised_text_sha256(holdout_path),
        "run_count": 0,
        "final_measurement_number": 1,
    }
    with state_path.open("x", encoding="utf-8", newline="\n") as stream:
        stream.write(canonical_json_bytes(payload).decode("utf-8"))
    return state_path


def claim_one_shot_output(
    state_path: Path,
    holdout_path: Path,
    policy_sha256: str,
    freeze_sha: str,
) -> Path:
    state = json.loads(state_path.read_text(encoding="utf-8"))
    expected_keys = {
        "schema_version", "status", "policy_sha256", "policy_freeze_commit_sha",
        "holdout_sha256", "run_count", "final_measurement_number",
    }
    if not isinstance(state, dict) or set(state) != expected_keys:
        raise ValueError("Phase 7 sealed one-shot state schema is closed")
    if state.get("schema_version") != 1 or state.get("status") != "SEALED_UNCONSUMED" or state.get("run_count") != 0:
        raise ValueError("Phase 7 final holdout is not sealed and unconsumed")
    if (
        state.get("policy_sha256") != policy_sha256
        or state.get("policy_freeze_commit_sha") != freeze_sha
        or state.get("holdout_sha256") != normalised_text_sha256(holdout_path)
        or state.get("final_measurement_number") != 1
    ):
        raise ValueError("Phase 7 sealed one-shot identity changed")
    state["status"] = "CLAIMED"
    state["run_count"] = 1
    _replace_json(state_path, state)
    return state_path


def complete_one_shot_output(state_path: Path, evidence_path: Path) -> None:
    state = json.loads(state_path.read_text(encoding="utf-8"))
    if state.get("status") != "CLAIMED" or state.get("run_count") != 1:
        raise ValueError("Phase 7 one-shot state was not exclusively claimed")
    state["status"] = "COMPLETED"
    state["evidence_sha256"] = normalised_text_sha256(evidence_path)
    _replace_json(state_path, state)


def validate_completed_one_shot_state(
    state_path: Path,
    holdout_path: Path,
    evidence_path: Path,
    policy_sha256: str,
    freeze_sha: str,
) -> dict[str, Any]:
    state = json.loads(state_path.read_text(encoding="utf-8"))
    expected_keys = {
        "schema_version", "status", "policy_sha256", "policy_freeze_commit_sha",
        "holdout_sha256", "run_count", "final_measurement_number", "evidence_sha256",
    }
    if not isinstance(state, dict) or set(state) != expected_keys:
        raise ValueError("Phase 7 completed one-shot state schema is closed")
    expected = {
        "schema_version": 1,
        "status": "COMPLETED",
        "policy_sha256": policy_sha256,
        "policy_freeze_commit_sha": freeze_sha,
        "holdout_sha256": normalised_text_sha256(holdout_path),
        "run_count": 1,
        "final_measurement_number": 1,
        "evidence_sha256": normalised_text_sha256(evidence_path),
    }
    if state != expected:
        raise ValueError("Phase 7 completed one-shot state is inconsistent")
    return state
