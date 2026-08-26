from __future__ import annotations

import json
import hashlib
import multiprocessing
import os
import platform
import queue
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..engines import current_process_peak_memory
from ..ocr_productionization.engine import _make_paddle, _run_paddle
from ..ocr_productionization.offline import enable_offline_guard
from .capture import CAPTURE_SCHEMA, _compact_blocks, verify_small_candidate
from .evidence import non_reuse_evidence
from .renderer import generate_assets, raster_path, reference_text
from .schema import (
    ASSET_SUFFIX,
    CORPUS_SCHEMA,
    canonical_json_bytes,
    evidence_root,
    holdout_data_root,
    load_json,
    repository_root,
    tool_root,
    validate_corpus,
    value_sha256,
)
from .scoring import score_capture


HOLDOUT_SEED = 1_106_308_231
HOLDOUT_CORPUS_VERSION = "pp1-ocr-iteration3-fresh-holdout-v1"
HOLDOUT_EVIDENCE_SCHEMA = "pp1-ocr-iteration3-holdout-seal/v1"
STATE_SCHEMA = "pp1-ocr-iteration3-one-shot-state/v1"
FREEZE_COMMIT = "ddb837653c8698260becb536fa622d6b4ed2713f"
PER_CASE_TIMEOUT_SECONDS = 90
SUBJECTS = (
    ("Transit Shelter", "transit shelters", "occupancy samples", "shelter zones", "Freight"),
    ("Estuary Boardwalk", "estuary boardwalks", "surface readings", "walkway reaches", "Tunnel"),
    ("Health Kiosk", "health kiosks", "service counts", "kiosk stations", "Retail"),
    ("Sports Pavilion", "sports pavilions", "access checks", "pavilion entries", "Warehouse"),
    ("Urban Orchard", "urban orchards", "growth observations", "orchard sectors", "Harbour"),
    ("Ferry Terminal", "ferry terminals", "visit tallies", "boarding points", "Freight"),
    ("Makerspace Ventilation", "makerspace ventilation", "airflow checks", "workshop bays", "Transit"),
    ("School Crossing", "school crossings", "visibility samples", "crossing approaches", "Tunnel"),
    ("Compost Hub", "compost hubs", "sorting counts", "processing cells", "Marina"),
)
METRICS = (
    ("Capacity Ledger", "bounded capacity"),
    ("Variance Map", "measured variance"),
    ("Access Queue", "access timing"),
    ("Safety Grid", "safety coverage"),
    ("Monthly Brief", "monthly trend"),
)
MATERIAL_NEGATIVE_INDEXES = {0, 6, 12, 18, 24, 30, 36}
PUNCTUATION_CONTROL_INDEXES = {5, 17, 29, 41}
VERSION_NEGATIVE_INDEX = 44


def holdout_evidence_root() -> Path:
    return evidence_root().parent / "ocr-iteration3-fresh-holdout"


def _style(index: int) -> str:
    return ("plain", "wrapped", "shadow", "plain", "multiline", "plain", "shadow")[index % 7]


def _relationship(index: int, title: str, replacement: str) -> tuple[str, bool, list[str]]:
    if index == VERSION_NEGATIVE_INDEX:
        return f"{title} v3", False, ["number_version_negative"]
    if index in MATERIAL_NEGATIVE_INDEXES:
        first = title.split()[0]
        return title.replace(first, replacement, 1), False, ["semantic_negative"]
    if index in PUNCTUATION_CONTROL_INDEXES:
        words = title.split()
        return f"{words[0]} {words[1]}: {' '.join(words[2:])}", True, ["punctuation_only_variation"]
    return title, True, []


def _case(index: int, *, media: str, layout: str, repetition: int) -> dict[str, Any]:
    subject_title, subject, measure, units, replacement = SUBJECTS[index // 5]
    metric_title, metric = METRICS[repetition]
    title = f"{subject_title} {metric_title}"
    if index == VERSION_NEGATIVE_INDEX:
        title = f"{title} v2"
    metadata, agreement, relation_tags = _relationship(index, title, replacement)
    columns = {"one_column": 1, "two_column": 2, "three_column": 3}[layout]
    difficulty = "challenging" if repetition in {1, 3, 4} else "clean"
    headings = ("SCOPE", "PROCESS", "EVIDENCE")
    sections: list[list[dict[str, str]]] = [[] for _ in range(columns)]
    for position, heading in enumerate(headings):
        column = min(position, columns - 1)
        sections[column].append(
            {
                "heading": heading,
                "body": (
                    f"Fresh synthetic holdout {index + 1:02d} examines {subject}; {measure} support a "
                    f"{metric} summary across invented {units} for offline staff review."
                ),
            }
        )
    closing = [
        {
            "heading": f"BOUND {position + 1}",
            "body": f"Lane {position + 1} contains fictional observations and grants no workflow authority.",
        }
        for position in range(columns)
    ]
    feature = ("table", "diagram", "none")[index % 3]
    if feature == "table":
        feature_heading = "SYNTHETIC CHECK TABLE: local values remain bounded and illustrative"
        feature_items = [f"Cell {position + 1}: {index + position + 7} invented checks" for position in range(columns)]
        feature_caption = "Table caption: figures are synthetic and require human interpretation."
    elif feature == "diagram":
        feature_heading = "OFFLINE REVIEW DIAGRAM: local observations move through bounded checks"
        feature_items = [f"Stage {position + 1}: fictional {units}" for position in range(columns)]
        feature_caption = "Diagram caption: arrows are descriptive and provide no automation authority."
    else:
        feature_heading, feature_items, feature_caption = "", [], ""
    distractors = []
    if index % 4 == 0:
        distractors.append({"position": "above", "text": "SYNTHETIC IMPACT REVIEW"})
    if index % 5 == 2:
        distractors.append({"position": "near", "text": f"Reference panel {index + 31}"})
    tags = ["top_page_control", *relation_tags]
    style = _style(index)
    if style in {"wrapped", "multiline"}:
        tags.append("wrapped_or_multiline_title")
    if distractors:
        tags.append("distractor_heading")
    if feature == "table":
        tags.append("table")
    if feature == "diagram":
        tags.append("diagram_caption")
    if difficulty == "challenging":
        tags.extend(["low_contrast", "compression", "mild_noise", "small_body_text"])
    case_id = f"ocr3-hold-{index + 1:03d}"
    return {
        "id": case_id,
        "split": "holdout",
        "media": media,
        "layout": layout,
        "difficulty": difficulty,
        "title": title,
        "metadata_title": metadata,
        "expected_agreement": agreement,
        "title_style": style,
        "tracking_px": 0.0,
        "contrast": "low" if difficulty == "challenging" else "high",
        "noise": "mild" if difficulty == "challenging" else "none",
        "jpeg_quality": 66 if difficulty == "challenging" else 88,
        "width": 1600,
        "height": 1100,
        "asset": f"{case_id}{ASSET_SUFFIX[media]}",
        "top_controls": [f"PP1 FRESH SYNTHETIC HOLDOUT {index + 1:02d}"],
        "distractors": distractors,
        "column_sections": sections,
        "feature": feature,
        "feature_heading": feature_heading,
        "feature_items": feature_items,
        "feature_caption": feature_caption,
        "closing_sections": closing,
        "tags": sorted(set(tags)),
    }


def build_holdout_corpus() -> dict[str, Any]:
    cases = []
    index = 0
    for media in ("png", "jpeg", "scanned_pdf"):
        for layout in ("one_column", "two_column", "three_column"):
            for repetition in range(5):
                cases.append(_case(index, media=media, layout=layout, repetition=repetition))
                index += 1
    warmup = _case(0, media="png", layout="one_column", repetition=0)
    warmup.update(
        {
            "id": "ocr3-hold-warmup-001",
            "split": "warmup",
            "title": "Fresh Holdout Warmup Card",
            "metadata_title": "Fresh Holdout Warmup Card",
            "expected_agreement": True,
            "asset": "ocr3-hold-warmup-001.png",
            "tags": ["top_page_control"],
        }
    )
    return {
        "schema_version": CORPUS_SCHEMA,
        "corpus_version": HOLDOUT_CORPUS_VERSION,
        "role": "holdout",
        "seed": HOLDOUT_SEED,
        "ocr_cases": [warmup, *cases],
        "native_controls": [
            {"id": "ocr3-hold-native-001", "title": "Native Solar Review Notes", "body": "Synthetic born digital PDF control.", "layout": "one_column", "asset": "ocr3-hold-native-001.pdf"},
            {"id": "ocr3-hold-native-002", "title": "Native Creek Review Notes", "body": "Synthetic born digital two column control.", "layout": "two_column", "asset": "ocr3-hold-native-002.pdf"},
            {"id": "ocr3-hold-native-003", "title": "Native Market Review Notes", "body": "Synthetic born digital three column control.", "layout": "three_column", "asset": "ocr3-hold-native-003.pdf"},
        ],
        "security_controls": [
            {"id": "ocr3-hold-security-001", "kind": "malformed_pdf", "asset": "ocr3-hold-security-001.pdf"},
            {"id": "ocr3-hold-security-002", "kind": "malformed_image", "asset": "ocr3-hold-security-002.png"},
        ],
    }


def _git(*args: str) -> str:
    return subprocess.run(
        ["git", *args],
        cwd=repository_root(),
        check=True,
        capture_output=True,
        text=True,
        timeout=20,
    ).stdout.strip()


def _source_sha256(path: Path) -> str:
    content = path.read_bytes().replace(b"\r\n", b"\n")
    return hashlib.sha256(content).hexdigest()


def _freeze_inputs() -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    root = repository_root()
    protocol = load_json(tool_root() / "ocr-iteration3-calibration" / "protocol.json")
    decision = load_json(evidence_root() / "calibration-decision.json")
    record = load_json(evidence_root() / "candidate-freeze-commit.json")
    if record["candidate_freeze_commit_sha"] != FREEZE_COMMIT or decision["selected_candidate"] != "CANDIDATE_A":
        raise ValueError("candidate freeze identity differs from the selected calibration decision")
    if record["calibration_decision_value_sha256"] != value_sha256(decision):
        raise ValueError("candidate freeze record does not bind the calibration decision")
    if record["holdout_paths_at_freeze"]:
        raise ValueError("candidate freeze did not prove holdout absence")
    tree_paths = _git("ls-tree", "-r", "--name-only", FREEZE_COMMIT).splitlines()
    if any("ocr-iteration3-fresh-holdout" in path for path in tree_paths):
        raise ValueError("candidate freeze commit already contained an Iteration 3 holdout")
    for item in decision["candidate_freeze"]["source_manifest"]:
        if _source_sha256(root / item["path"]) != item["sha256"]:
            raise ValueError(f"frozen Candidate A source changed: {item['path']}")
    return protocol, decision, record


def _holdout_non_reuse(corpus: dict[str, Any]) -> dict[str, Any]:
    calibration = load_json(evidence_root() / "calibration-report.json")["non_reuse"]["records"]
    return non_reuse_evidence(corpus, split="holdout", additional=calibration)


def build_seal(corpus: dict[str, Any], generation: dict[str, Any]) -> dict[str, Any]:
    protocol, decision, freeze = _freeze_inputs()
    validate_corpus(corpus, expected_split="holdout", expected_count=45)
    expected = build_holdout_corpus()
    if corpus != expected:
        raise ValueError("tracked holdout differs from its post-freeze deterministic source")
    non_reuse = _holdout_non_reuse(corpus)
    if not non_reuse["passed"]:
        raise ValueError("fresh holdout reuses exposed OCR content")
    if generation.get("corpus_version") != HOLDOUT_CORPUS_VERSION or generation.get("asset_count") != 51:
        raise ValueError("fresh holdout asset manifest is incomplete")
    root = repository_root()
    sources = [
        "tools/assistive-validation-benchmark/src/assistive_validation_benchmark/ocr_iteration3/holdout.py",
        "tools/assistive-validation-benchmark/src/assistive_validation_benchmark/ocr_iteration3/__main__.py",
    ]
    return {
        "schema_version": HOLDOUT_EVIDENCE_SCHEMA,
        "candidate_freeze_commit_sha": freeze["candidate_freeze_commit_sha"],
        "candidate_freeze_tree_sha": freeze["candidate_freeze_tree_sha"],
        "candidate_source_manifest_sha256": freeze["candidate_source_manifest_sha256"],
        "selected_candidate": decision["selected_candidate"],
        "protocol_sha256": value_sha256(protocol),
        "corpus_sha256": value_sha256(corpus),
        "corpus_version": corpus["corpus_version"],
        "seed": corpus["seed"],
        "case_count": 45,
        "media_layout_cell_count": 5,
        "generation": generation,
        "non_reuse": non_reuse,
        "holdout_source_manifest": [
            {"path": path, "sha256": _source_sha256(root / path)} for path in sources
        ],
        "one_shot": True,
        "candidate_output_visible": False,
        "production_integration_permitted": False,
    }


def write_seal(corpus: dict[str, Any], generation: dict[str, Any]) -> dict[str, Any]:
    seal = build_seal(corpus, generation)
    target = holdout_evidence_root()
    target.mkdir(parents=True, exist_ok=True)
    (target / "seal.json").write_bytes(canonical_json_bytes(seal))
    state = {
        "schema_version": STATE_SCHEMA,
        "status": "SEALED_UNCONSUMED",
        "run_count": 0,
        "seal_sha256": value_sha256(seal),
        "candidate_freeze_commit_sha": FREEZE_COMMIT,
        "capture_sha256": None,
        "report_sha256": None,
        "started_at": None,
        "completed_at": None,
    }
    (target / "one-shot-state.json").write_bytes(canonical_json_bytes(state))
    return {"seal": seal, "state": state}


def validate_seal() -> dict[str, Any]:
    corpus = validate_corpus(
        load_json(holdout_data_root() / "corpus" / "holdout.json"),
        expected_split="holdout",
        expected_count=45,
    )
    seal = load_json(holdout_evidence_root() / "seal.json")
    recomputed = build_seal(corpus, seal["generation"])
    if seal != recomputed:
        raise ValueError("stored Iteration 3 holdout seal differs from recomputation")
    state = load_json(holdout_evidence_root() / "one-shot-state.json")
    if state["schema_version"] != STATE_SCHEMA or state["seal_sha256"] != value_sha256(seal):
        raise ValueError("one-shot state is not bound to the holdout seal")
    return {"corpus": corpus, "seal": seal, "state": state}


def _worker(models_dir: str, requests: Any, responses: Any) -> None:
    try:
        offline = enable_offline_guard()
        baseline = current_process_peak_memory()
        instance, versions = _make_paddle("paddle-small", Path(models_dir))
        responses.put({"kind": "ready", "offline": offline, "baseline": baseline, "versions": versions})
        while True:
            item = requests.get()
            if item is None:
                return
            try:
                observation = _run_paddle(instance, Path(item["path"]))
                responses.put({"kind": "result", "case_id": item["case_id"], "observation": observation})
            except Exception as error:
                responses.put(
                    {
                        "kind": "error",
                        "case_id": item["case_id"],
                        "error_type": type(error).__name__,
                        "message": str(error)[:300],
                    }
                )
    except Exception as error:
        responses.put({"kind": "fatal", "error_type": type(error).__name__, "message": str(error)[:300]})


def _receive(responses: Any, *, timeout: int, expected_case: str | None = None) -> dict[str, Any]:
    try:
        result = responses.get(timeout=timeout)
    except queue.Empty as error:
        raise TimeoutError(f"OCR worker exceeded {timeout}s for {expected_case or 'initialization'}") from error
    if expected_case is not None and result.get("case_id") != expected_case:
        raise ValueError("OCR worker returned an unexpected case identity")
    return result


def capture_holdout(
    corpus: dict[str, Any],
    protocol: dict[str, Any],
    *,
    run_dir: Path,
    models_dir: Path,
    sealed_generation: dict[str, Any],
) -> dict[str, Any]:
    assets_dir = run_dir / "corpus"
    generation = generate_assets(corpus, assets_dir)
    if generation != sealed_generation:
        raise ValueError("generated holdout assets differ from the pre-run seal")
    provisioning = verify_small_candidate(protocol, models_dir)
    context = multiprocessing.get_context("spawn")
    requests, responses = context.Queue(), context.Queue()
    worker = context.Process(target=_worker, args=(str(models_dir), requests, responses))
    started = time.perf_counter()
    worker.start()
    rendered_dir = run_dir / "rendered"
    records, failures = [], []
    peak_values: list[int] = []
    try:
        ready = _receive(responses, timeout=PER_CASE_TIMEOUT_SECONDS)
        if ready.get("kind") != "ready":
            raise RuntimeError(f"OCR worker failed during initialization: {ready}")
        warmup = next(case for case in corpus["ocr_cases"] if case["split"] == "warmup")
        warmup_path = raster_path(warmup, assets_dir, rendered_dir, 180, 1920)
        requests.put({"case_id": warmup["id"], "path": str(warmup_path)})
        warmup_response = _receive(responses, timeout=PER_CASE_TIMEOUT_SECONDS, expected_case=warmup["id"])
        if warmup_response.get("kind") != "result":
            raise RuntimeError(f"OCR warmup failed: {warmup_response}")
        warmup_result = warmup_response["observation"]
        cold_start_ms = (time.perf_counter() - started) * 1000
        peak_values.append(int(warmup_result.get("peak_memory_bytes") or 0))
        cases = [case for case in corpus["ocr_cases"] if case["split"] == "holdout"]
        for case in cases:
            path = raster_path(case, assets_dir, rendered_dir, 180, 1920)
            requests.put({"case_id": case["id"], "path": str(path)})
            try:
                response = _receive(responses, timeout=PER_CASE_TIMEOUT_SECONDS, expected_case=case["id"])
            except TimeoutError as error:
                failures.append({"case_id": case["id"], "error_type": "TimeoutError", "message": str(error)})
                worker.terminate()
                for remaining in cases[len(records) + len(failures) :]:
                    failures.append(
                        {"case_id": remaining["id"], "error_type": "WorkerUnavailable", "message": "worker terminated after timeout"}
                    )
                break
            if response.get("kind") != "result":
                failures.append(
                    {
                        "case_id": case["id"],
                        "error_type": response.get("error_type", "WorkerError"),
                        "message": response.get("message", "OCR worker failed"),
                    }
                )
                continue
            observation = response["observation"]
            peak_values.append(int(observation.get("peak_memory_bytes") or 0))
            records.append(
                {
                    "case_id": case["id"],
                    "runtime_ms": observation["runtime_ms"],
                    "peak_memory_bytes": observation.get("peak_memory_bytes"),
                    "blocks": _compact_blocks(observation["blocks"]),
                }
            )
    finally:
        if worker.is_alive():
            requests.put(None)
            worker.join(timeout=10)
        if worker.is_alive():
            worker.terminate()
            worker.join(timeout=5)
    return {
        "schema_version": CAPTURE_SCHEMA,
        "engine": "paddle-small",
        "configuration_id": "dpi180-edge1920-cpu-adaptive-v1",
        "configuration": protocol["configuration"],
        "versions": ready["versions"],
        "offline": ready["offline"],
        "environment": {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "machine": platform.machine(),
            "processor": platform.processor(),
            "cpu_count": os.cpu_count(),
            "worker_start_method": "spawn",
            "per_case_timeout_seconds": PER_CASE_TIMEOUT_SECONDS,
        },
        "generation": generation,
        "provisioning": provisioning,
        "cold_start_ms": cold_start_ms,
        "warmup_runtime_ms": warmup_result["runtime_ms"],
        "memory_baseline_bytes": ready["baseline"],
        "peak_working_set_bytes": max(peak_values or [0]),
        "artifact_footprint_bytes": provisioning["artifact_footprint_bytes"],
        "case_count": 45,
        "failures": failures,
        "records": records,
    }


def build_holdout_report(
    capture: dict[str, Any], corpus: dict[str, Any], protocol: dict[str, Any], seal: dict[str, Any]
) -> dict[str, Any]:
    score = score_capture(capture, corpus, protocol)
    checks = score["final_gate_checks"]
    families = {
        "quality": all(
            checks[name]
            for name in ("all_scored_cases_executed", "exact_title", "primary_wer")
        ),
        "title_safety": checks["material_false_automatic_agreements"],
        "operational": checks["operational"],
        "provisioning": checks["provisioning"],
        "offline_security": checks["offline_security"],
    }
    decision = "READY_FOR_OCR_PROVIDER_INTEGRATION" if all(families.values()) else "OCR_PROVIDER_DEFERRED"
    return {
        "schema_version": "pp1-ocr-iteration3-fresh-holdout-result/v1",
        "seal_sha256": value_sha256(seal),
        "corpus_sha256": value_sha256(corpus),
        "capture_sha256": value_sha256(capture),
        "candidate_freeze_commit_sha": FREEZE_COMMIT,
        "one_shot_run_count": 1,
        "rerun_permitted": False,
        "gate_families": families,
        "score": score,
        "final_decision": decision,
        "production_integration_permitted": decision == "READY_FOR_OCR_PROVIDER_INTEGRATION",
    }


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def run_holdout_once(*, run_dir: Path, models_dir: Path) -> dict[str, Any]:
    values = validate_seal()
    state = values["state"]
    if state["status"] != "SEALED_UNCONSUMED" or state["run_count"] != 0:
        raise ValueError("Iteration 3 fresh holdout one-shot is already consumed")
    seal_commit = load_json(holdout_evidence_root() / "seal-commit.json")
    if seal_commit["seal_sha256"] != value_sha256(values["seal"]):
        raise ValueError("seal commit record does not bind the current holdout seal")
    pre_run_state = json.loads(
        _git("show", f"{seal_commit['seal_commit_sha']}:docs/assistive-validation/evidence/ocr-iteration3-fresh-holdout/one-shot-state.json")
    )
    if pre_run_state["status"] != "SEALED_UNCONSUMED" or value_sha256(pre_run_state) != seal_commit["sealed_state_sha256"]:
        raise ValueError("seal commit does not preserve an unconsumed one-shot state")
    protocol = load_json(tool_root() / "ocr-iteration3-calibration" / "protocol.json")
    verify_small_candidate(protocol, models_dir)
    if load_json(run_dir / "corpus" / "generation.json") != values["seal"]["generation"]:
        raise ValueError("local holdout assets differ from the sealed manifest")
    consumed = {**state, "status": "CONSUMED_RUNNING", "run_count": 1, "started_at": _now()}
    state_path = holdout_evidence_root() / "one-shot-state.json"
    state_path.write_bytes(canonical_json_bytes(consumed))
    capture = capture_holdout(
        values["corpus"],
        protocol,
        run_dir=run_dir,
        models_dir=models_dir,
        sealed_generation=values["seal"]["generation"],
    )
    report = build_holdout_report(capture, values["corpus"], protocol, values["seal"])
    capture_path = holdout_evidence_root() / "holdout-capture.json"
    report_path = holdout_evidence_root() / "holdout-report.json"
    capture_path.write_bytes(canonical_json_bytes(capture))
    report_path.write_bytes(canonical_json_bytes(report))
    complete = {
        **consumed,
        "status": "CONSUMED_COMPLETE",
        "capture_sha256": value_sha256(capture),
        "report_sha256": value_sha256(report),
        "completed_at": _now(),
    }
    state_path.write_bytes(canonical_json_bytes(complete))
    return {"capture": capture, "report": report, "state": complete}


def validate_holdout_result() -> dict[str, Any]:
    values = validate_seal()
    state = values["state"]
    if state["status"] != "CONSUMED_COMPLETE" or state["run_count"] != 1:
        raise ValueError("fresh holdout result is not a completed one-shot")
    capture = load_json(holdout_evidence_root() / "holdout-capture.json")
    report = load_json(holdout_evidence_root() / "holdout-report.json")
    protocol = load_json(tool_root() / "ocr-iteration3-calibration" / "protocol.json")
    expected = build_holdout_report(capture, values["corpus"], protocol, values["seal"])
    if report != expected:
        raise ValueError("stored fresh holdout report differs from recomputation")
    if state["capture_sha256"] != value_sha256(capture) or state["report_sha256"] != value_sha256(report):
        raise ValueError("one-shot state does not bind the stored result")
    return {"decision": report["final_decision"], "report": report, "state": state}
