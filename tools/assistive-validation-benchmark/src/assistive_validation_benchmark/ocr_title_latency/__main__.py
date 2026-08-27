from __future__ import annotations

import argparse
import re
from pathlib import Path

from .capture import candidate_configuration, capture_candidate
from .corpus import build_calibration_corpus
from .evidence import calibration_non_reuse
from .renderer import generate_assets
from .schema import (
    canonical_json_bytes,
    data_root,
    evidence_root,
    load_json,
    tool_root,
    validate_corpus,
    validate_protocol,
    value_sha256,
)
from .scoring import score_capture


def _inputs() -> tuple[dict, dict]:
    protocol = validate_protocol(load_json(data_root() / "protocol.json"))
    corpus = validate_corpus(load_json(data_root() / "corpus" / "calibration.json"))
    if corpus != build_calibration_corpus():
        raise ValueError("tracked title-latency corpus differs from deterministic source")
    return protocol, corpus


def _report(capture: dict, corpus: dict, protocol: dict) -> dict:
    reuse = calibration_non_reuse(corpus)
    if not reuse["passed"]:
        raise ValueError("title-latency calibration reuses prohibited OCR content")
    return {
        "schema_version": "pp1-ocr-title-latency-evidence/v1",
        "protocol_sha256": value_sha256(protocol),
        "corpus_sha256": value_sha256(corpus),
        "capture_sha256": value_sha256(capture),
        "non_reuse": reuse,
        "score": score_capture(capture, corpus, protocol),
        "holdout_permitted": False,
        "production_integration_permitted": False,
    }


def _evidence_pairs(root: Path) -> list[tuple[Path, Path]]:
    pairs = []
    for capture in sorted(root.glob("*-capture.json")):
        report = capture.with_name(capture.name.replace("-capture.json", "-report.json"))
        if report.exists():
            pairs.append((capture, report))
    return pairs


def _complexity_rank(configuration: dict) -> int:
    if configuration["max_input_dimension"] != 1920:
        return 3
    if configuration["fast_region_ratio"] is not None:
        return 2
    if configuration["enable_mkldnn"] and configuration["cpu_threads"] is not None:
        return 1
    return 0


def _selection_eligible(configuration: dict) -> bool:
    return bool(
        configuration["cpu_threads"] is not None
        and (configuration["enable_mkldnn"] or configuration["fast_region_ratio"] is not None)
    )


def _comparison(root: Path, corpus: dict, protocol: dict) -> dict:
    candidates = []
    for capture_path, report_path in _evidence_pairs(root):
        capture, stored = load_json(capture_path), load_json(report_path)
        expected = _report(capture, corpus, protocol)
        if stored != expected:
            raise ValueError(f"stored candidate evidence differs from recomputation: {capture_path.name}")
        score = stored["score"]
        candidates.append({
            "candidate_id": score["candidate_id"],
            "configuration": score["configuration"],
            "complexity_rank": _complexity_rank(score["configuration"]),
            "selection_eligible": _selection_eligible(score["configuration"]),
            "calibration_margin_passed": score["calibration_margin_passed"],
            "exact_title_rate": score["exact_title_rate"],
            "inconsistency_precision": score["inconsistency_detection"]["precision"],
            "inconsistency_recall": score["inconsistency_detection"]["recall"],
            "automatic_agreement_precision": score["automatic_agreement_precision"],
            "material_false_automatic_agreements": score["material_false_automatic_agreements"],
            "false_fast_path_acceptances": score["false_fast_path_acceptances"],
            "p50_ms": score["operational"]["measurements"]["p50_ms"],
            "p95_ms": score["operational"]["measurements"]["p95_ms"],
            "cold_start_ms": score["operational"]["measurements"]["cold_start_ms"],
            "peak_working_set_bytes": score["operational"]["measurements"]["peak_working_set_bytes"],
            "fast_path": score["fast_path"],
            "capture_file": capture_path.name,
            "report_file": report_path.name,
        })
    return {
        "schema_version": "pp1-ocr-title-latency-candidate-comparison/v1",
        "protocol_sha256": value_sha256(protocol),
        "corpus_sha256": value_sha256(corpus),
        "same_calibration_corpus_for_every_candidate": True,
        "candidate_count": len(candidates),
        "candidates": candidates,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="PP1 scoped title-OCR latency optimization")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("write-calibration-corpus")
    sub.add_parser("check-calibration")
    generate = sub.add_parser("generate-calibration")
    generate.add_argument("--output-dir", type=Path, required=True)
    capture = sub.add_parser("capture-candidate")
    capture.add_argument("--candidate-id", required=True)
    capture.add_argument("--enable-mkldnn", choices=("true", "false"), required=True)
    capture.add_argument("--cpu-threads", type=int)
    capture.add_argument("--fast-region-ratio", type=float)
    capture.add_argument("--max-input-dimension", type=int, default=1920)
    capture.add_argument("--run-dir", type=Path, required=True)
    capture.add_argument("--models-dir", type=Path, required=True)
    check_run = sub.add_parser("check-run")
    check_run.add_argument("--run-dir", type=Path, required=True)
    record = sub.add_parser("record-run")
    record.add_argument("--run-dir", type=Path, required=True)
    sub.add_parser("write-comparison")
    select = sub.add_parser("write-selection")
    select.add_argument("--candidate-id", required=True)
    sub.add_parser("check-evidence")
    args = parser.parse_args()

    if args.command == "write-calibration-corpus":
        path = data_root() / "corpus" / "calibration.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(canonical_json_bytes(build_calibration_corpus()))
        print(path)
        return 0

    protocol, corpus = _inputs()
    if args.command == "check-calibration":
        reuse = calibration_non_reuse(corpus)
        if not reuse["passed"]:
            raise ValueError("title-latency calibration reuses prohibited OCR content")
        print(canonical_json_bytes({"protocol_sha256": value_sha256(protocol), "corpus_sha256": value_sha256(corpus), "non_reuse": reuse}).decode(), end="")
        return 0
    if args.command == "generate-calibration":
        print(canonical_json_bytes(generate_assets(corpus, args.output_dir)).decode(), end="")
        return 0
    if args.command == "capture-candidate":
        configuration = candidate_configuration(
            protocol,
            candidate_id=args.candidate_id,
            enable_mkldnn=args.enable_mkldnn == "true",
            cpu_threads=args.cpu_threads,
            fast_region_ratio=args.fast_region_ratio,
            max_input_dimension=args.max_input_dimension,
        )
        args.run_dir.mkdir(parents=True, exist_ok=True)
        captured = capture_candidate(corpus, protocol, configuration, run_dir=args.run_dir, models_dir=args.models_dir)
        report = _report(captured, corpus, protocol)
        (args.run_dir / "capture.json").write_bytes(canonical_json_bytes(captured))
        (args.run_dir / "report.json").write_bytes(canonical_json_bytes(report))
        print(canonical_json_bytes(report).decode(), end="")
        return 0
    if args.command in {"check-run", "record-run"}:
        captured = load_json(args.run_dir / "capture.json")
        stored = load_json(args.run_dir / "report.json")
        expected = _report(captured, corpus, protocol)
        if stored != expected:
            raise ValueError("candidate run report differs from recomputation")
        if args.command == "record-run":
            candidate_id = captured["candidate_id"]
            if not re.fullmatch(r"[a-z0-9-]{1,80}", candidate_id):
                raise ValueError("candidate ID is unsafe for evidence filenames")
            root = evidence_root()
            root.mkdir(parents=True, exist_ok=True)
            (root / f"{candidate_id}-capture.json").write_bytes(canonical_json_bytes(captured))
            (root / f"{candidate_id}-report.json").write_bytes(canonical_json_bytes(expected))
            print(root)
        else:
            print(canonical_json_bytes(expected).decode(), end="")
        return 0
    root = evidence_root()
    comparison = _comparison(root, corpus, protocol)
    if args.command == "write-comparison":
        (root / "candidate-comparison.json").write_bytes(canonical_json_bytes(comparison))
        print(root / "candidate-comparison.json")
        return 0
    if args.command == "write-selection":
        eligible = [
            item for item in comparison["candidates"]
            if item["selection_eligible"] and item["calibration_margin_passed"]
        ]
        if not eligible:
            raise ValueError("no candidate satisfies the prospective calibration margin")
        minimum_rank = min(item["complexity_rank"] for item in eligible)
        same_rank = [item for item in eligible if item["complexity_rank"] == minimum_rank]
        minimum_p50 = min(item["p50_ms"] for item in same_rank)
        stable = [item for item in same_rank if item["p50_ms"] <= minimum_p50 * 1.02]
        preferred = min(
            stable,
            key=lambda item: (
                item["p95_ms"],
                item["configuration"]["cpu_threads"],
                item["p50_ms"],
                item["candidate_id"],
            ),
        )
        if preferred["candidate_id"] != args.candidate_id:
            raise ValueError(f"selected candidate differs from the prospective simplicity/performance rule: {preferred['candidate_id']}")
        selection = {
            "schema_version": "pp1-ocr-title-latency-selection/v1",
            "selection_rule": "lowest eligible complexity rank; within 2% of its best p50, lowest p95 then fewer CPU threads, p50, and candidate ID",
            "selected_candidate_id": preferred["candidate_id"],
            "selected_configuration": preferred["configuration"],
            "selected_report_sha256": value_sha256(load_json(root / preferred["report_file"])),
            "calibration_margin_passed": True,
            "holdout_permitted_after_dedicated_freeze_commit": True,
            "production_integration_permitted": False,
        }
        (root / "candidate-selection.json").write_bytes(canonical_json_bytes(selection))
        print(root / "candidate-selection.json")
        return 0
    stored_comparison = load_json(root / "candidate-comparison.json")
    if stored_comparison != comparison:
        raise ValueError("stored candidate comparison differs from recomputation")
    selection = load_json(root / "candidate-selection.json")
    selected = next((item for item in comparison["candidates"] if item["candidate_id"] == selection["selected_candidate_id"]), None)
    if selected is None or not selected["calibration_margin_passed"]:
        raise ValueError("stored selected candidate is not eligible")
    if selection["selected_configuration"] != selected["configuration"]:
        raise ValueError("stored selected configuration differs from evidence")
    compatibility = load_json(root / "mkldnn-compatibility.json")
    if (
        compatibility.get("decision") != "MKLDNN_NOT_DEPLOYABLE_ON_CURRENT_WINDOWS_RUNTIME"
        or compatibility.get("hpi_decision") != "NOT_EVALUATED_WINDOWS_NATIVE_SUPPORT_INAPPLICABLE"
        or any(attempt.get("scored_cases_executed") != 0 for attempt in compatibility.get("attempts", []))
    ):
        raise ValueError("stored backend compatibility evidence is invalid")
    print(
        canonical_json_bytes({"comparison": comparison, "selection": selection, "compatibility": compatibility}).decode(),
        end="",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
