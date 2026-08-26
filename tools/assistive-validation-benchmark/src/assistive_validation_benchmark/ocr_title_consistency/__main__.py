from __future__ import annotations

import argparse
from pathlib import Path

from .capture import capture_calibration
from .corpus import build_calibration_corpus
from .evidence import non_reuse_evidence
from .freeze import check_freeze_manifest, write_freeze_manifest
from .schema import (
    calibration_data_root,
    calibration_evidence_root,
    canonical_json_bytes,
    load_json,
    tool_root,
    validate_corpus,
    validate_protocol,
    value_sha256,
)
from .renderer import generate_assets
from .scoring import score_capture


def _inputs() -> tuple[dict, dict]:
    protocol = validate_protocol(load_json(calibration_data_root() / "protocol.json"))
    corpus = validate_corpus(
        load_json(calibration_data_root() / "corpus" / "calibration.json"),
        expected_split="calibration",
        expected_count=30,
    )
    if corpus != build_calibration_corpus():
        raise ValueError("tracked title calibration corpus differs from deterministic source")
    return protocol, corpus


def _report(capture: dict, corpus: dict, protocol: dict) -> dict:
    reuse = non_reuse_evidence(corpus, split="calibration")
    if not reuse["passed"]:
        raise ValueError("title calibration reuses exposed OCR content")
    score = score_capture(capture, corpus, protocol)
    return {
        "schema_version": "pp1-ocr-title-consistency-calibration-evidence/v1",
        "protocol_sha256": value_sha256(protocol),
        "corpus_sha256": value_sha256(corpus),
        "capture_sha256": value_sha256(capture),
        "non_reuse": reuse,
        "score": score,
        "holdout_permitted": score["calibration_margin_passed"],
        "production_integration_permitted": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Scoped OCR title-consistency qualification")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("write-calibration-corpus")
    sub.add_parser("check-calibration")
    generate = sub.add_parser("generate-calibration")
    generate.add_argument("--output-dir", type=Path, required=True)
    capture = sub.add_parser("capture-calibration")
    capture.add_argument("--run-dir", type=Path, default=tool_root() / "artifacts" / "ocr-title-consistency-calibration")
    capture.add_argument("--models-dir", type=Path, default=tool_root() / "artifacts" / "ocr-title-provisioning" / "models")
    record = sub.add_parser("record-calibration-evidence")
    record.add_argument("--run-dir", type=Path, default=tool_root() / "artifacts" / "ocr-title-consistency-calibration")
    record.add_argument("--prior-run-dir", type=Path, action="append", default=[])
    sub.add_parser("check-calibration-evidence")
    freeze = sub.add_parser("write-freeze-manifest")
    freeze.add_argument("--calibration-commit", required=True)
    sub.add_parser("check-freeze")
    args = parser.parse_args()

    if args.command == "write-calibration-corpus":
        path = calibration_data_root() / "corpus" / "calibration.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(canonical_json_bytes(build_calibration_corpus()))
        print(path)
        return 0

    protocol, corpus = _inputs()
    if args.command == "write-freeze-manifest":
        print(write_freeze_manifest(args.calibration_commit))
        return 0
    if args.command == "check-freeze":
        print(canonical_json_bytes(check_freeze_manifest()).decode(), end="")
        return 0
    if args.command == "check-calibration":
        reuse = non_reuse_evidence(corpus, split="calibration")
        if not reuse["passed"]:
            raise ValueError("title calibration reuses exposed OCR content")
        print(canonical_json_bytes({"protocol_sha256": value_sha256(protocol), "corpus_sha256": value_sha256(corpus), "non_reuse": reuse}).decode(), end="")
        return 0
    if args.command == "generate-calibration":
        print(canonical_json_bytes(generate_assets(corpus, args.output_dir)).decode(), end="")
        return 0
    if args.command == "capture-calibration":
        args.run_dir.mkdir(parents=True, exist_ok=True)
        captured = capture_calibration(corpus, protocol, run_dir=args.run_dir, models_dir=args.models_dir)
        report = _report(captured, corpus, protocol)
        (args.run_dir / "calibration-capture.json").write_bytes(canonical_json_bytes(captured))
        (args.run_dir / "calibration-report.json").write_bytes(canonical_json_bytes(report))
        print(canonical_json_bytes(report).decode(), end="")
        return 0
    if args.command == "record-calibration-evidence":
        captured = load_json(args.run_dir / "calibration-capture.json")
        expected = _report(captured, corpus, protocol)
        if not expected["holdout_permitted"]:
            raise ValueError("selected title calibration run does not permit a holdout")
        root = calibration_evidence_root()
        root.mkdir(parents=True, exist_ok=True)
        (root / "calibration-capture.json").write_bytes(canonical_json_bytes(captured))
        (root / "calibration-report.json").write_bytes(canonical_json_bytes(expected))
        attempts = []
        for index, prior_dir in enumerate(args.prior_run_dir, start=1):
            prior_capture = load_json(prior_dir / "calibration-capture.json")
            prior_report = _report(prior_capture, corpus, protocol)
            capture_name = f"calibration-attempt-{index}-capture.json"
            report_name = f"calibration-attempt-{index}-report.json"
            (root / capture_name).write_bytes(canonical_json_bytes(prior_capture))
            (root / report_name).write_bytes(canonical_json_bytes(prior_report))
            attempts.append(
                {
                    "attempt": index,
                    "selected": False,
                    "capture_file": capture_name,
                    "capture_sha256": value_sha256(prior_capture),
                    "report_file": report_name,
                    "report_sha256": value_sha256(prior_report),
                    "holdout_permitted": prior_report["holdout_permitted"],
                    "decision": prior_report["score"]["decision"],
                }
            )
        attempts.append(
            {
                "attempt": len(attempts) + 1,
                "selected": True,
                "capture_file": "calibration-capture.json",
                "capture_sha256": value_sha256(captured),
                "report_file": "calibration-report.json",
                "report_sha256": value_sha256(expected),
                "holdout_permitted": True,
                "decision": expected["score"]["decision"],
            }
        )
        decision = {
            "schema_version": "pp1-ocr-title-consistency-calibration-decision/v1",
            "selection_rule": "first untuned fresh-process repeat satisfying every frozen calibration margin and operational gate",
            "attempts": attempts,
            "selected_attempt": len(attempts),
            "holdout_permitted": True,
            "production_integration_permitted": False,
        }
        (root / "calibration-decision.json").write_bytes(canonical_json_bytes(decision))
        print(root)
        return 0
    captured = load_json(calibration_evidence_root() / "calibration-capture.json")
    report = load_json(calibration_evidence_root() / "calibration-report.json")
    if report != _report(captured, corpus, protocol):
        raise ValueError("tracked title calibration evidence differs from recomputation")
    if not report["holdout_permitted"] or report["production_integration_permitted"]:
        raise ValueError("tracked title calibration decision is inconsistent")
    decision = load_json(calibration_evidence_root() / "calibration-decision.json")
    attempts = decision.get("attempts") or []
    if not attempts or sum(attempt.get("selected") is True for attempt in attempts) != 1:
        raise ValueError("tracked title calibration attempt decision is invalid")
    for attempt in attempts:
        attempt_capture = load_json(calibration_evidence_root() / attempt["capture_file"])
        attempt_report = load_json(calibration_evidence_root() / attempt["report_file"])
        if value_sha256(attempt_capture) != attempt["capture_sha256"] or value_sha256(attempt_report) != attempt["report_sha256"]:
            raise ValueError("tracked title calibration attempt hashes differ")
        if attempt_report != _report(attempt_capture, corpus, protocol):
            raise ValueError("tracked title calibration attempt differs from recomputation")
    print(canonical_json_bytes({"decision": decision, "score": report["score"]}).decode(), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
