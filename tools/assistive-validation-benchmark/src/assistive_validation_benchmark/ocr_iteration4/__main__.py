from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from ..ocr_productionization.offline import enable_offline_guard
from .capture import capture_calibration, warmup_timeout_capture
from .corpus import build_calibration_corpus
from .evidence import (
    build_calibration_report,
    calibration_inputs,
    non_reuse_evidence,
    tracked_calibration_evidence,
    validate_calibration_report,
)
from .provider import (
    build_model_manifest,
    load_and_verify_model_manifest,
    make_pipeline,
    run_pipeline,
    runtime_versions,
)
from .renderer import generate_assets, raster_path
from .schema import (
    calibration_data_root,
    calibration_evidence_root,
    canonical_json_bytes,
    load_json,
    tool_root,
    validate_corpus,
)


def _defaults() -> dict[str, Path]:
    cache = tool_root() / "artifacts" / "ocr-iteration4" / "paddlex-cache" / "official_models"
    return {
        "run": tool_root() / "artifacts" / "ocr-iteration4" / "calibration-run",
        "model": cache / "PaddleOCR-VL-1.6",
        "layout": cache / "PP-DocLayoutV3",
        "manifest": calibration_data_root() / "model-manifest.json",
        "capture": calibration_evidence_root() / "calibration-capture.json",
        "report": calibration_evidence_root() / "calibration-report.json",
    }


def _parser() -> argparse.ArgumentParser:
    defaults = _defaults()
    parser = argparse.ArgumentParser(description="PP1 OCR Iteration 4 PaddleOCR-VL qualification")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("write-calibration", help="write the deterministic 27+1 calibration corpus")
    manifest = sub.add_parser("write-model-manifest", help="hash the official local model artifacts")
    manifest.add_argument("--model-dir", type=Path, default=defaults["model"])
    manifest.add_argument("--layout-dir", type=Path, default=defaults["layout"])
    manifest.add_argument("--output", type=Path, default=defaults["manifest"])
    sub.add_parser("check-calibration", help="validate allocation, protocol, artifacts and historical non-reuse")
    render = sub.add_parser("generate-calibration", help="render the deterministic calibration assets")
    render.add_argument("--output-dir", type=Path, required=True)
    warmup = sub.add_parser("smoke-warmup", help="run only the unscored fresh warmup with offline enforcement")
    warmup.add_argument("--run-dir", type=Path, default=defaults["run"] / "warmup")
    warmup.add_argument("--model-dir", type=Path, default=defaults["model"])
    warmup.add_argument("--layout-dir", type=Path, default=defaults["layout"])
    capture = sub.add_parser("capture-calibration", help="run the single scored calibration attempt")
    capture.add_argument("--run-dir", type=Path, default=defaults["run"])
    capture.add_argument("--model-dir", type=Path, default=defaults["model"])
    capture.add_argument("--layout-dir", type=Path, default=defaults["layout"])
    failed = sub.add_parser(
        "record-warmup-timeout",
        help="serialize an already-observed warmup timeout without rerunning inference",
    )
    failed.add_argument("--run-dir", type=Path, default=defaults["run"])
    failed.add_argument("--model-dir", type=Path, default=defaults["model"])
    failed.add_argument("--layout-dir", type=Path, default=defaults["layout"])
    failed.add_argument("--observed-message", required=True)
    build = sub.add_parser("build-calibration-evidence", help="track bounded capture and recomputable score")
    build.add_argument("--run-dir", type=Path, default=defaults["run"])
    build.add_argument("--capture-output", type=Path, default=defaults["capture"])
    build.add_argument("--report-output", type=Path, default=defaults["report"])
    sub.add_parser("check-calibration-evidence", help="recompute calibration evidence without Paddle")
    return parser


def main() -> int:
    defaults = _defaults()
    args = _parser().parse_args()
    if args.command == "write-calibration":
        corpus = build_calibration_corpus()
        validate_corpus(corpus, expected_split="calibration", expected_count=27)
        target = calibration_data_root() / "corpus" / "calibration.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(canonical_json_bytes(corpus))
        result = {"corpus": str(target), "scored_cases": 27, "warmup_cases": 1, "seed": corpus["seed"]}
    elif args.command == "write-model-manifest":
        manifest = build_model_manifest(args.model_dir, args.layout_dir)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_bytes(canonical_json_bytes(manifest))
        result = {"manifest": str(args.output), "artifact_footprint_bytes": manifest["artifact_footprint_bytes"]}
    elif args.command == "check-calibration":
        protocol, corpus = calibration_inputs()
        if corpus != build_calibration_corpus():
            raise ValueError("tracked Iteration 4 calibration differs from deterministic source")
        non_reuse = non_reuse_evidence(corpus, split="calibration")
        if not non_reuse["passed"]:
            raise ValueError("Iteration 4 calibration reuses historical OCR content")
        provisioning = load_and_verify_model_manifest(defaults["manifest"], defaults["model"], defaults["layout"])
        result = {
            "protocol_version": protocol["protocol_version"],
            "non_reuse": non_reuse,
            "provisioning": provisioning,
        }
    elif args.command == "generate-calibration":
        _, corpus = calibration_inputs()
        result = generate_assets(corpus, args.output_dir)
    elif args.command == "smoke-warmup":
        protocol, corpus = calibration_inputs()
        assets = args.run_dir / "corpus"
        generate_assets(corpus, assets)
        load_and_verify_model_manifest(defaults["manifest"], args.model_dir, args.layout_dir)
        offline = enable_offline_guard()
        instance = make_pipeline(args.model_dir, args.layout_dir)
        warmup_case = next(case for case in corpus["ocr_cases"] if case["split"] == "warmup")
        path = raster_path(
            warmup_case,
            assets,
            args.run_dir / "rendered",
            protocol["rendering"]["raster_dpi"],
            protocol["rendering"]["max_input_dimension"],
        )
        observation = run_pipeline(instance, path)
        result = {
            "case_id": warmup_case["id"],
            "runtime_ms": observation["runtime_ms"],
            "block_count": len(observation["blocks"]),
            "blocks": observation["blocks"],
            "offline": offline,
            "versions": runtime_versions(),
        }
    elif args.command == "capture-calibration":
        protocol, corpus = calibration_inputs()
        capture = capture_calibration(
            corpus,
            protocol,
            run_dir=args.run_dir,
            model_dir=args.model_dir,
            layout_dir=args.layout_dir,
        )
        target = args.run_dir / "capture.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(canonical_json_bytes(capture))
        result = {"capture": str(target), "case_count": capture["case_count"], "failures": capture["failures"]}
    elif args.command == "record-warmup-timeout":
        protocol, corpus = calibration_inputs()
        expected_message = "PaddleOCR-VL worker exceeded 180s for ocr4-cal-warmup-001"
        if args.observed_message != expected_message:
            raise ValueError("observed warmup timeout does not match the frozen runner failure")
        capture = warmup_timeout_capture(
            corpus,
            protocol,
            run_dir=args.run_dir,
            model_dir=args.model_dir,
            layout_dir=args.layout_dir,
            manifest_path=defaults["manifest"],
            observed_message=args.observed_message,
        )
        target = args.run_dir / "capture.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(canonical_json_bytes(capture))
        result = {"capture": str(target), "case_count": capture["case_count"], "failures": capture["failures"]}
    elif args.command == "build-calibration-evidence":
        protocol, corpus = calibration_inputs()
        capture = load_json(args.run_dir / "capture.json")
        report = build_calibration_report(capture, corpus, protocol)
        args.capture_output.parent.mkdir(parents=True, exist_ok=True)
        args.capture_output.write_bytes(canonical_json_bytes(capture))
        args.report_output.write_bytes(canonical_json_bytes(report))
        result = {
            "capture": str(args.capture_output),
            "report": str(args.report_output),
            "decision": report["score"]["calibration_decision"],
        }
    else:
        protocol, corpus = calibration_inputs()
        capture, report = tracked_calibration_evidence()
        validate_calibration_report(report, capture, corpus, protocol)
        result = {"valid": True, "decision": report["score"]["calibration_decision"]}
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError, TypeError, RuntimeError, TimeoutError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from error
