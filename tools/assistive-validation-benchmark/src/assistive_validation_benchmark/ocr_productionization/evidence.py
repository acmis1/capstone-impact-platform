from __future__ import annotations

import hashlib
import importlib.metadata
import json
import platform
import subprocess
from pathlib import Path
from typing import Any

import pypdfium2 as pdfium
from PIL import Image

from ..core import timing_summary
from ..engines import pdfium_extract
from ..runner import environment_evidence
from .boundary import check_production_boundary
from .provision import prepare_models
from .schema import (
    canonical_json_bytes,
    corpus_manifest,
    file_sha256,
    load_json,
    prove_phase0_holdout_independence,
    repository_root,
    validate_artifact_manifest,
    validate_combined_corpus,
    validate_protocol,
    value_sha256,
)
from .title_safety import binary_metrics, normalize_metric_title


NEURAL_ENGINES = ("paddle-tiny", "paddle-small", "paddle-medium")
ALL_ENGINES = ("tesseract", *NEURAL_ENGINES)


def _git(root: Path, arguments: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *arguments],
        cwd=root,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        encoding="utf-8",
        shell=False,
        check=check,
    )


def protocol_frozen_paths(tool_root: Path) -> list[Path]:
    source = tool_root / "src" / "assistive_validation_benchmark" / "ocr_productionization"
    paths = [
            tool_root / "pyproject.toml",
            tool_root / "ocr-productionization" / "protocol.json",
            tool_root / "ocr-productionization" / "artifact-manifest.json",
            tool_root / "ocr-productionization" / "corpus" / "calibration.json",
            *source.glob("*.py"),
        ]
    calibration_summary = tool_root / "ocr-productionization" / "calibration-summary.json"
    if calibration_summary.is_file():
        paths.append(calibration_summary)
    return sorted(paths, key=lambda path: path.as_posix())


def protocol_tree_sha256(tool_root: Path) -> str:
    digest = hashlib.sha256()
    for path in protocol_frozen_paths(tool_root):
        relative = path.relative_to(repository_root()).as_posix()
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(bytes.fromhex(file_sha256(path)))
    return digest.hexdigest()


def verify_protocol_freeze(tool_root: Path, freeze_sha: str) -> dict[str, Any]:
    root = repository_root()
    resolved = _git(root, ["rev-parse", f"{freeze_sha}^{{commit}}"]).stdout.strip()
    if resolved != freeze_sha:
        raise ValueError("protocol freeze SHA must be a full exact commit SHA")
    checked = 0
    for path in protocol_frozen_paths(tool_root):
        relative = path.relative_to(root).as_posix()
        frozen_blob = _git(root, ["rev-parse", f"{freeze_sha}:{relative}"]).stdout.strip()
        working_blob = _git(root, ["hash-object", "--path", relative, relative]).stdout.strip()
        if frozen_blob != working_blob:
            raise ValueError(f"protocol-frozen file changed after holdout exposure: {relative}")
        checked += 1
    holdout_relative = (
        tool_root / "ocr-productionization" / "corpus" / "holdout.json"
    ).relative_to(root).as_posix()
    present = _git(root, ["cat-file", "-e", f"{freeze_sha}:{holdout_relative}"], check=False).returncode == 0
    if present:
        raise ValueError("fresh holdout already existed at the protocol freeze commit")
    return {
        "protocol_freeze_commit_sha": freeze_sha,
        "frozen_file_count": checked,
        "protocol_tree_sha256": protocol_tree_sha256(tool_root),
        "holdout_absent_at_freeze": True,
    }


def _mean(records: list[dict[str, Any]], key: str) -> float | None:
    values = [float(record[key]) for record in records if record.get(key) is not None]
    return sum(values) / len(values) if values else None


def summarize_engine(observation: dict[str, Any], protocol: dict[str, Any]) -> dict[str, Any]:
    records = observation["records"]
    case_count = observation["case_count"]
    if len(records) + len(observation["failures"]) != case_count:
        raise ValueError("engine observation case arithmetic is inconsistent")
    exact_count = sum(bool(record["title_exact"]) for record in records)
    assistive_count = sum(bool(record["title_assistive"]) for record in records)
    exact_rate = exact_count / case_count
    assistive_rate = assistive_count / case_count
    clean = [record for record in records if record["difficulty"] == "clean"]
    challenging = [record for record in records if record["difficulty"] == "challenging"]
    equality = binary_metrics(
        [record["expected_agreement"] for record in records],
        [record["downstream_outcome"] == "AGREES" for record in records],
    )
    assistive = binary_metrics(
        [record["expected_agreement"] for record in records],
        [record["downstream_outcome"] in {"AGREES", "REVIEW"} for record in records],
    )
    material_false_agreements = sum(
        not record["expected_agreement"] and record["downstream_outcome"] == "AGREES" for record in records
    )
    latency = timing_summary([float(record["runtime_ms"]) for record in records])
    quality_gate = protocol["quality_gate"]
    operational_gate = protocol["operational_gate"]
    mean_wer = _mean(records, "wer")
    checks = {
        "executed_all_cases": observation["status"] == "executed" and len(records) == case_count,
        "exact_title": exact_rate >= quality_gate["holdout_exact_title_recovery_minimum"],
        "wer": mean_wer is not None and mean_wer <= quality_gate["holdout_mean_wer_maximum"],
        "title_safety": material_false_agreements <= quality_gate["material_false_agreements_maximum"],
        "cold_start": observation["cold_start_ms"] <= operational_gate["cold_start_ms_maximum"],
        "p50": latency["p50_ms"] is not None and latency["p50_ms"] <= operational_gate["holdout_p50_ms_maximum"],
        "p95": latency["p95_ms"] is not None and latency["p95_ms"] <= operational_gate["holdout_p95_ms_maximum"],
        "peak_memory": observation["peak_working_set_bytes"] <= operational_gate["peak_working_set_bytes_maximum"],
        "artifact_footprint": observation["artifact_footprint_bytes"] <= operational_gate["artifact_footprint_bytes_maximum"],
        "per_case_timeout": all(
            record["runtime_ms"] <= operational_gate["per_case_timeout_seconds"] * 1000 for record in records
        ),
        "offline": observation["offline"].get("enabled") is True
        and observation["offline"].get("self_test_passed") is True,
    }
    return {
        "engine": observation["engine"],
        "execution_status": observation["status"],
        "versions": observation["versions"],
        "configuration": observation["configuration"],
        "holdout_case_count": case_count,
        "holdout_success_count": len(records),
        "exact_title_count": exact_count,
        "exact_title_rate": exact_rate,
        "assistive_title_count": assistive_count,
        "assistive_title_rate": assistive_rate,
        "mean_cer": _mean(records, "cer"),
        "mean_wer": mean_wer,
        "clean_case_count": len(clean),
        "clean_mean_wer": _mean(clean, "wer"),
        "challenging_case_count": len(challenging),
        "challenging_mean_wer": _mean(challenging, "wer"),
        "whole_page_ordering_warning_cases": sum(
            record["layout"] != "one_column" and record["title_exact"] and record["wer"] > 0.12 for record in records
        ),
        "cold_start_ms": observation["cold_start_ms"],
        "latency": latency,
        "peak_working_set_bytes": observation["peak_working_set_bytes"],
        "memory_baseline_bytes": observation["memory_baseline_bytes"],
        "artifact_footprint_bytes": observation["artifact_footprint_bytes"],
        "offline": observation["offline"],
        "downstream_title_safety": {
            "equality_path": equality,
            "assistive_review_path": assistive,
            "material_false_agreements": material_false_agreements,
        },
        "gate_checks": checks,
        "records": records,
        "failures": observation["failures"],
    }


def _native_controls(manifest: dict[str, Any], assets_dir: Path) -> dict[str, Any]:
    controls = []
    for part in (manifest["calibration"], manifest["holdout"]):
        controls.extend(part["native_controls"])
    records = []
    for control in controls:
        observation = pdfium_extract(assets_dir / control["asset"])
        lines = [line.strip() for line in observation.get("text", "").splitlines() if line.strip()]
        candidate = lines[0] if lines else ""
        records.append(
            {
                "case_id": control["id"],
                "status": observation["status"],
                "title_exact": normalize_metric_title(candidate) == normalize_metric_title(control["title"]),
                "runtime_ms": observation.get("runtime_ms"),
            }
        )
    return {
        "case_count": len(records),
        "exact_title_count": sum(record["title_exact"] for record in records),
        "all_completed": all(record["status"] == "ok" for record in records),
        "records": records,
    }


def _security_controls(manifest: dict[str, Any], assets_dir: Path) -> dict[str, Any]:
    controls = []
    for part in (manifest["calibration"], manifest["holdout"]):
        controls.extend(part.get("security_controls", []))
    records = []
    for control in controls:
        rejected = False
        error_type = None
        try:
            if control["kind"] == "malformed_pdf":
                document = pdfium.PdfDocument(str(assets_dir / control["asset"]))
                document.close()
            else:
                with Image.open(assets_dir / control["asset"]) as image:
                    image.load()
        except Exception as error:
            rejected = True
            error_type = type(error).__name__
        records.append(
            {
                "case_id": control["id"],
                "kind": control["kind"],
                "expected": control["expected"],
                "observed": "BOUNDED_REJECTION" if rejected else "UNEXPECTED_ACCEPTANCE",
                "error_type": error_type,
            }
        )
    return {
        "case_count": len(records),
        "all_bounded_rejections": bool(records) and all(record["observed"] == "BOUNDED_REJECTION" for record in records),
        "records": records,
    }


def build_evidence(
    *,
    tool_root: Path,
    freeze_sha: str,
    calibration: dict[str, Any],
    holdout: dict[str, Any],
    protocol: dict[str, Any],
    artifact_manifest: dict[str, Any],
    engine_observations: dict[str, dict[str, Any]],
    generation: dict[str, Any],
    assets_dir: Path,
    archives_dir: Path,
    models_dir: Path,
) -> dict[str, Any]:
    validate_protocol(protocol)
    validate_artifact_manifest(artifact_manifest)
    manifest = validate_combined_corpus(calibration, holdout)
    independence = prove_phase0_holdout_independence(manifest)
    freeze = verify_protocol_freeze(tool_root, freeze_sha)
    boundary = check_production_boundary(repository_root())
    provisioning = prepare_models(
        tool_root / "ocr-productionization" / "artifact-manifest.json",
        archives_dir=archives_dir,
        models_dir=models_dir,
        allow_download=False,
    )
    if set(engine_observations) != set(ALL_ENGINES):
        raise ValueError("final evidence requires all four frozen OCR candidates")
    engines = {name: summarize_engine(engine_observations[name], protocol) for name in ALL_ENGINES}
    decisions: dict[str, Any] = {}
    for name in ALL_ENGINES:
        evidence = engines[name]
        all_checks = all(evidence["gate_checks"].values())
        if name == "tesseract":
            decisions[name] = {
                "classification": "DEFER",
                "role": "baseline_only",
                "all_numeric_and_offline_gates_passed": all_checks,
            }
        else:
            decisions[name] = {
                "classification": "SELECT" if all_checks else "DEFER",
                "all_gates_passed": all_checks,
                "failed_gates": [key for key, passed in evidence["gate_checks"].items() if not passed],
            }
    selected = [name for name in NEURAL_ENGINES if decisions[name]["classification"] == "SELECT"]
    final_decision = "READY_FOR_OCR_PROVIDER_INTEGRATION" if selected else "NEEDS_MORE_OCR_BENCHMARKING"
    primary = selected[0] if selected else "paddle-medium"
    tesseract_records = {record["case_id"]: record for record in engines["tesseract"]["records"]}
    primary_records = {record["case_id"]: record for record in engines[primary]["records"]}
    quality_rescues = [
        case_id
        for case_id, record in primary_records.items()
        if not record["title_exact"] and tesseract_records.get(case_id, {}).get("title_exact")
    ]
    report = {
        "schema_version": "pp1-ocr-productionization-report/v1",
        "benchmark_version": protocol["benchmark_version"],
        "protocol_freeze": freeze,
        "hashes": {
            "protocol_sha256": value_sha256(protocol),
            "artifact_manifest_sha256": value_sha256(artifact_manifest),
            "corpus_manifest_sha256": value_sha256(manifest),
            "calibration_part_sha256": value_sha256(calibration),
            "holdout_part_sha256": value_sha256(holdout),
            "generated_corpus_asset_sha256": generation["corpus_asset_sha256"],
        },
        "environment": environment_evidence(repository_root(), protocol["seed"], protocol["corpus_version"]),
        "corpus": {
            "version": protocol["corpus_version"],
            "seed": protocol["seed"],
            "calibration_count": sum(case["split"] == "calibration" for case in calibration["ocr_cases"]),
            "holdout_count": len(holdout["ocr_cases"]),
            "native_control_count": len(calibration["native_controls"]) + len(holdout["native_controls"]),
            "security_control_count": len(calibration.get("security_controls", []))
            + len(holdout.get("security_controls", [])),
            "holdout_distribution": {
                "media": {media: sum(case["media"] == media for case in holdout["ocr_cases"]) for media in ("png", "jpeg", "scanned_pdf")},
                "layout": {layout: sum(case["layout"] == layout for case in holdout["ocr_cases"]) for layout in ("one_column", "two_column", "three_column")},
                "difficulty": {difficulty: sum(case["difficulty"] == difficulty for case in holdout["ocr_cases"]) for difficulty in ("clean", "challenging")},
            },
            "phase0_independence": independence,
            "native_controls": _native_controls(manifest, assets_dir),
            "security_controls": _security_controls(manifest, assets_dir),
        },
        "protocol": {
            "quality_gate": protocol["quality_gate"],
            "operational_gate": protocol["operational_gate"],
            "configuration": protocol["configuration"],
            "worker_bounds": protocol["worker_bounds"],
        },
        "provisioning": provisioning,
        "engines": engines,
        "decisions": decisions,
        "tesseract_role": {
            "production_fallback_justified": False,
            "quality_rescue_case_count": len(quality_rescues),
            "quality_rescue_case_ids": quality_rescues,
            "reason": "Any quality rescue is label-dependent and no deterministic provider-failure trigger was observed; Tesseract remains a benchmark reference.",
        },
        "production_boundary": boundary,
        "final_decision": final_decision,
        "selected_neural_candidates": selected,
        "weights_tracked": False,
    }
    validate_evidence(report, protocol=protocol, artifact_manifest=artifact_manifest, calibration=calibration, holdout=holdout)
    return report


def validate_evidence(
    report: dict[str, Any],
    *,
    protocol: dict[str, Any],
    artifact_manifest: dict[str, Any],
    calibration: dict[str, Any],
    holdout: dict[str, Any],
) -> dict[str, Any]:
    if report.get("schema_version") != "pp1-ocr-productionization-report/v1":
        raise ValueError("unsupported OCR evidence schema")
    manifest = validate_combined_corpus(calibration, holdout)
    expected_hashes = {
        "protocol_sha256": value_sha256(protocol),
        "artifact_manifest_sha256": value_sha256(artifact_manifest),
        "corpus_manifest_sha256": value_sha256(manifest),
        "calibration_part_sha256": value_sha256(calibration),
        "holdout_part_sha256": value_sha256(holdout),
    }
    for key, expected in expected_hashes.items():
        if report["hashes"].get(key) != expected:
            raise ValueError(f"stored evidence hash mismatch: {key}")
    recalculated_decisions = {}
    for name in ALL_ENGINES:
        evidence = report["engines"][name]
        records = evidence["records"]
        denominator = evidence["holdout_case_count"]
        if evidence["exact_title_count"] != sum(record["title_exact"] for record in records):
            raise ValueError(f"stored exact-title count is inconsistent for {name}")
        if abs(evidence["exact_title_rate"] - evidence["exact_title_count"] / denominator) > 1e-12:
            raise ValueError(f"stored exact-title rate is inconsistent for {name}")
        mean_wer = _mean(records, "wer")
        if mean_wer is None or abs(evidence["mean_wer"] - mean_wer) > 1e-12:
            raise ValueError(f"stored WER arithmetic is inconsistent for {name}")
        for branch, predicted in (
            ("equality_path", [record["downstream_outcome"] == "AGREES" for record in records]),
            ("assistive_review_path", [record["downstream_outcome"] in {"AGREES", "REVIEW"} for record in records]),
        ):
            expected_metric = binary_metrics([record["expected_agreement"] for record in records], predicted)
            if evidence["downstream_title_safety"][branch] != expected_metric:
                raise ValueError(f"stored title-safety arithmetic is inconsistent for {name}/{branch}")
        all_checks = all(evidence["gate_checks"].values())
        recalculated_decisions[name] = "DEFER" if name == "tesseract" or not all_checks else "SELECT"
        if report["decisions"][name]["classification"] != recalculated_decisions[name]:
            raise ValueError(f"stored candidate decision is inconsistent for {name}")
    selected = [name for name in NEURAL_ENGINES if recalculated_decisions[name] == "SELECT"]
    expected_final = "READY_FOR_OCR_PROVIDER_INTEGRATION" if selected else "NEEDS_MORE_OCR_BENCHMARKING"
    if report["final_decision"] != expected_final or report["selected_neural_candidates"] != selected:
        raise ValueError("stored final OCR productionization decision is inconsistent")
    if report.get("weights_tracked") is not False:
        raise ValueError("evidence must confirm model weights are not tracked")
    return report
