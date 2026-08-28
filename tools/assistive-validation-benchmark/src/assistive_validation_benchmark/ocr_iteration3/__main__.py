from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .candidate_b import capture_candidate_b
from .capture import capture_calibration
from .corpus import build_calibration_corpus
from .evidence import (
    build_calibration_report,
    build_calibration_decision,
    build_candidate_b_report,
    calibration_inputs,
    non_reuse_evidence,
    validate_calibration_report,
    validate_calibration_decision,
    validate_candidate_b_report,
)
from .holdout import (
    build_holdout_corpus,
    holdout_evidence_root,
    run_holdout_once,
    validate_holdout_result,
    validate_seal,
    write_seal,
)
from .renderer import generate_assets
from .schema import (
    calibration_data_root,
    canonical_json_bytes,
    evidence_root,
    holdout_data_root,
    load_json,
    tool_root,
    validate_corpus,
)


def _defaults() -> dict[str, Path]:
    return {
        "run": tool_root() / "artifacts" / "ocr-iteration3-calibration",
        "models": tool_root() / "artifacts" / "ocr-provisioning" / "models",
        "capture": evidence_root() / "calibration-capture.json",
        "report": evidence_root() / "calibration-report.json",
        "candidate_b_run": tool_root() / "artifacts" / "ocr-iteration3-candidate-b-calibration",
        "candidate_b_capture": evidence_root() / "candidate-b-calibration-capture.json",
        "candidate_b_report": evidence_root() / "candidate-b-calibration-report.json",
        "layout_model": tool_root() / "artifacts" / "ocr3-provisioning" / "PP-DocLayout-S_infer",
        "candidate_a_repeat_capture": evidence_root() / "candidate-a-repeat-capture.json",
        "candidate_a_repeat_report": evidence_root() / "candidate-a-repeat-report.json",
        "calibration_decision": evidence_root() / "calibration-decision.json",
        "holdout_run": tool_root() / "artifacts" / "ocr-iteration3-fresh-holdout",
    }


def _parser() -> argparse.ArgumentParser:
    defaults = _defaults()
    parser = argparse.ArgumentParser(description="PP1 OCR Iteration 3 reading-order benchmark")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("write-calibration", help="write the deterministic tracked calibration corpus")
    sub.add_parser("check-calibration", help="validate corpus allocation, coverage and exposed-data non-reuse")
    generate = sub.add_parser("generate-calibration", help="render the deterministic calibration corpus")
    generate.add_argument("--output-dir", type=Path, required=True)
    capture = sub.add_parser("capture-calibration", help="run Candidate A on the new calibration corpus")
    capture.add_argument("--run-dir", type=Path, default=defaults["run"])
    capture.add_argument("--models-dir", type=Path, default=defaults["models"])
    build = sub.add_parser("build-calibration-evidence", help="store bounded capture and recomputable calibration result")
    build.add_argument("--run-dir", type=Path, default=defaults["run"])
    build.add_argument("--capture-output", type=Path, default=defaults["capture"])
    build.add_argument("--report-output", type=Path, default=defaults["report"])
    check = sub.add_parser("check-calibration-evidence", help="recompute the tracked calibration result without OCR")
    check.add_argument("--capture", type=Path, default=defaults["capture"])
    check.add_argument("--report", type=Path, default=defaults["report"])
    capture_b = sub.add_parser("capture-candidate-b", help="run PP-StructureV3 Candidate B offline")
    capture_b.add_argument("--run-dir", type=Path, default=defaults["candidate_b_run"])
    capture_b.add_argument("--models-dir", type=Path, default=defaults["models"])
    capture_b.add_argument("--layout-model-dir", type=Path, default=defaults["layout_model"])
    build_b = sub.add_parser("build-candidate-b-evidence", help="store and score Candidate B calibration")
    build_b.add_argument("--run-dir", type=Path, default=defaults["candidate_b_run"])
    build_b.add_argument("--capture-output", type=Path, default=defaults["candidate_b_capture"])
    build_b.add_argument("--report-output", type=Path, default=defaults["candidate_b_report"])
    check_b = sub.add_parser("check-candidate-b-evidence", help="recompute Candidate B evidence without inference")
    check_b.add_argument("--capture", type=Path, default=defaults["candidate_b_capture"])
    check_b.add_argument("--report", type=Path, default=defaults["candidate_b_report"])
    decision = sub.add_parser("build-calibration-decision", help="bind the complete candidate selection chronology")
    decision.add_argument("--output", type=Path, default=defaults["calibration_decision"])
    check_decision = sub.add_parser("check-calibration-decision", help="recompute the candidate selection chronology")
    check_decision.add_argument("--decision", type=Path, default=defaults["calibration_decision"])
    sub.add_parser("write-holdout", help="write the deterministic post-freeze fresh holdout corpus")
    generate_h = sub.add_parser("generate-holdout", help="render the sealed fresh holdout assets")
    generate_h.add_argument("--output-dir", type=Path, default=defaults["holdout_run"] / "corpus")
    seal_h = sub.add_parser("seal-holdout", help="seal corpus and asset hashes before candidate output")
    seal_h.add_argument("--run-dir", type=Path, default=defaults["holdout_run"])
    sub.add_parser("check-holdout-seal", help="recompute the holdout seal without OCR")
    run_h = sub.add_parser("run-holdout-once", help="consume the sealed holdout exactly once")
    run_h.add_argument("--run-dir", type=Path, default=defaults["holdout_run"])
    run_h.add_argument("--models-dir", type=Path, default=defaults["models"])
    sub.add_parser("check-holdout-result", help="recompute the consumed one-shot result without OCR")
    return parser


def main() -> int:
    defaults = _defaults()
    args = _parser().parse_args()
    if args.command == "write-calibration":
        corpus = build_calibration_corpus()
        validate_corpus(corpus, expected_split="calibration", expected_count=18)
        target = calibration_data_root() / "corpus" / "calibration.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(canonical_json_bytes(corpus))
        result = {"corpus": str(target), "case_count": 18}
    elif args.command == "check-calibration":
        protocol, corpus = calibration_inputs()
        expected = build_calibration_corpus()
        if corpus != expected:
            raise ValueError("tracked calibration corpus differs from its deterministic source")
        reuse = non_reuse_evidence(corpus, split="calibration")
        if not reuse["passed"]:
            raise ValueError("calibration corpus reuses exposed OCR content")
        result = {"protocol_version": protocol["protocol_version"], "non_reuse": reuse}
    elif args.command == "generate-calibration":
        _, corpus = calibration_inputs()
        result = generate_assets(corpus, args.output_dir)
    elif args.command == "capture-calibration":
        protocol, corpus = calibration_inputs()
        capture = capture_calibration(corpus, protocol, run_dir=args.run_dir, models_dir=args.models_dir)
        target = args.run_dir / "capture.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(canonical_json_bytes(capture))
        result = {"capture": str(target), "failures": capture["failures"], "case_count": capture["case_count"]}
    elif args.command == "build-calibration-evidence":
        protocol, corpus = calibration_inputs()
        capture = load_json(args.run_dir / "capture.json")
        report = build_calibration_report(capture, corpus, protocol)
        args.capture_output.parent.mkdir(parents=True, exist_ok=True)
        args.capture_output.write_bytes(canonical_json_bytes(capture))
        args.report_output.write_bytes(canonical_json_bytes(report))
        result = {"capture": str(args.capture_output), "report": str(args.report_output), "selection": report["selection"]}
    elif args.command == "check-calibration-evidence":
        protocol, corpus = calibration_inputs()
        capture = load_json(args.capture)
        report = load_json(args.report)
        validate_calibration_report(report, capture, corpus, protocol)
        result = {"valid": True, "selection": report["selection"]}
    elif args.command == "capture-candidate-b":
        protocol, corpus = calibration_inputs()
        capture = capture_candidate_b(
            corpus,
            protocol,
            run_dir=args.run_dir,
            models_dir=args.models_dir,
            layout_model_dir=args.layout_model_dir,
        )
        target = args.run_dir / "capture.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(canonical_json_bytes(capture))
        result = {"capture": str(target), "failures": capture["failures"], "case_count": capture["case_count"]}
    elif args.command == "build-candidate-b-evidence":
        protocol, corpus = calibration_inputs()
        capture = load_json(args.run_dir / "capture.json")
        report = build_candidate_b_report(capture, corpus, protocol)
        args.capture_output.parent.mkdir(parents=True, exist_ok=True)
        args.capture_output.write_bytes(canonical_json_bytes(capture))
        args.report_output.write_bytes(canonical_json_bytes(report))
        result = {
            "capture": str(args.capture_output),
            "report": str(args.report_output),
            "selection": report["candidate_b"]["selection"],
        }
    elif args.command == "check-candidate-b-evidence":
        protocol, corpus = calibration_inputs()
        capture = load_json(args.capture)
        report = load_json(args.report)
        validate_candidate_b_report(report, capture, corpus, protocol)
        result = {"valid": True, "selection": report["candidate_b"]["selection"]}
    elif args.command in {"build-calibration-decision", "check-calibration-decision"}:
        protocol, corpus = calibration_inputs()
        values = {
            "initial_capture": load_json(defaults["capture"]),
            "initial_report": load_json(defaults["report"]),
            "repeat_capture": load_json(defaults["candidate_a_repeat_capture"]),
            "repeat_report": load_json(defaults["candidate_a_repeat_report"]),
            "candidate_b_capture": load_json(defaults["candidate_b_capture"]),
            "candidate_b_report": load_json(defaults["candidate_b_report"]),
            "corpus": corpus,
            "protocol": protocol,
        }
        if args.command == "build-calibration-decision":
            decision = build_calibration_decision(**values)
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_bytes(canonical_json_bytes(decision))
            result = {"decision": str(args.output), "selected_candidate": decision["selected_candidate"]}
        else:
            validate_calibration_decision(load_json(args.decision), **values)
            result = {"valid": True, "selected_candidate": "CANDIDATE_A"}
    elif args.command == "write-holdout":
        corpus = build_holdout_corpus()
        validate_corpus(corpus, expected_split="holdout", expected_count=45)
        target = holdout_data_root() / "corpus" / "holdout.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(canonical_json_bytes(corpus))
        result = {"corpus": str(target), "case_count": 45, "seed": corpus["seed"]}
    elif args.command == "generate-holdout":
        corpus = validate_corpus(
            load_json(holdout_data_root() / "corpus" / "holdout.json"),
            expected_split="holdout",
            expected_count=45,
        )
        result = generate_assets(corpus, args.output_dir)
    elif args.command == "seal-holdout":
        corpus = validate_corpus(
            load_json(holdout_data_root() / "corpus" / "holdout.json"),
            expected_split="holdout",
            expected_count=45,
        )
        sealed = write_seal(corpus, load_json(args.run_dir / "corpus" / "generation.json"))
        result = {
            "seal": str(holdout_evidence_root() / "seal.json"),
            "state": sealed["state"]["status"],
            "case_count": sealed["seal"]["case_count"],
        }
    elif args.command == "check-holdout-seal":
        sealed = validate_seal()
        result = {
            "valid": True,
            "state": sealed["state"]["status"],
            "case_count": sealed["seal"]["case_count"],
        }
    elif args.command == "run-holdout-once":
        completed = run_holdout_once(run_dir=args.run_dir, models_dir=args.models_dir)
        result = {
            "state": completed["state"]["status"],
            "decision": completed["report"]["final_decision"],
            "failures": completed["capture"]["failures"],
        }
    else:
        checked = validate_holdout_result()
        result = {"valid": True, "decision": checked["decision"], "state": checked["state"]["status"]}
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from error
