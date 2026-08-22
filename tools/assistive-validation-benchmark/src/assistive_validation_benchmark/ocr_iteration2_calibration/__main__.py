from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

from .capture import capture_engine
from .corpus import generate_assets
from .report import build_report, recommend_medium_configuration, validate_report
from .schema import (
    canonical_json_bytes,
    check_inputs,
    data_root,
    load_json,
    repository_root,
    tool_root,
    validate_corpus,
    validate_protocol,
)


def _defaults() -> dict[str, Path]:
    root = tool_root()
    return {
        "run": root / "artifacts" / "ocr-iteration2-calibration",
        "models": root / "artifacts" / "ocr-provisioning" / "models",
        "evidence": repository_root() / "docs" / "assistive-validation" / "evidence" / "ocr-productionization-iteration2-calibration.json",
    }


def _parser() -> argparse.ArgumentParser:
    defaults = _defaults()
    parser = argparse.ArgumentParser(description="PP1 OCR Iteration 2 corrected-corpus calibration")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("check", help="run lightweight schema, font, novelty, history and no-holdout checks")

    generate = subparsers.add_parser("generate", help="generate the deterministic corrected corpus")
    generate.add_argument("--output-dir", type=Path, required=True)

    capture = subparsers.add_parser("_capture", help=argparse.SUPPRESS)
    capture.add_argument("--engine", choices=("tesseract", "paddle-tiny", "paddle-small", "paddle-medium"), required=True)
    capture.add_argument("--configuration", choices=("dpi150-edge960", "dpi180-edge1920"), required=True)
    capture.add_argument("--run-dir", type=Path, default=defaults["run"])
    capture.add_argument("--models-dir", type=Path, default=defaults["models"])
    capture.add_argument("--tesseract-executable")

    stage1 = subparsers.add_parser("run-stage1", help="run Tesseract, Tiny and Small across the bounded raster pair")
    stage1.add_argument("--run-dir", type=Path, default=defaults["run"])
    stage1.add_argument("--models-dir", type=Path, default=defaults["models"])
    stage1.add_argument("--tesseract-executable")

    recommend = subparsers.add_parser("recommend-medium", help="select Medium's single justified raster configuration")
    recommend.add_argument("--run-dir", type=Path, default=defaults["run"])

    medium = subparsers.add_parser("run-medium", help="run Medium once at the stage-1-selected raster configuration")
    medium.add_argument("--run-dir", type=Path, default=defaults["run"])
    medium.add_argument("--models-dir", type=Path, default=defaults["models"])

    report = subparsers.add_parser("build-report", help="score captures and write compact calibration evidence")
    report.add_argument("--run-dir", type=Path, default=defaults["run"])
    report.add_argument("--output", type=Path, default=defaults["evidence"])

    check_report = subparsers.add_parser("check-report", help="recompute stored arithmetic and the calibration decision")
    check_report.add_argument("--report", type=Path, default=defaults["evidence"])
    return parser


def _inputs() -> tuple[dict[str, Any], dict[str, Any]]:
    check_inputs()
    protocol = validate_protocol(load_json(data_root() / "protocol.json"))
    corpus = validate_corpus(load_json(data_root() / "corpus" / "calibration.json"))
    return protocol, corpus


def _ensure_assets(run_dir: Path, corpus: dict[str, Any]) -> dict[str, Any]:
    assets = run_dir / "corpus"
    generation = generate_assets(corpus, assets)
    return generation


def _capture(args: argparse.Namespace) -> dict[str, Any]:
    protocol, corpus = _inputs()
    _ensure_assets(args.run_dir, corpus)
    cases = [case for case in corpus["ocr_cases"] if case["split"] == "calibration"]
    warmup = next(case for case in corpus["ocr_cases"] if case["split"] == "warmup")
    configuration = protocol["raster_configurations"][args.configuration]
    result = capture_engine(
        args.engine,
        configuration_id=args.configuration,
        cases=cases,
        warmup_case=warmup,
        assets_dir=args.run_dir / "corpus",
        rendered_dir=args.run_dir / "rendered" / args.configuration,
        models_dir=args.models_dir,
        raster_dpi=configuration["raster_dpi"],
        max_input_dimension=configuration["max_input_dimension"],
        tesseract_executable=getattr(args, "tesseract_executable", None),
    )
    output = args.run_dir / "captures" / f"{args.engine}--{args.configuration}.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(canonical_json_bytes(result))
    return {"capture": str(output), "engine": args.engine, "configuration": args.configuration, "failures": result["failures"]}


def _run_child(engine: str, configuration: str, args: argparse.Namespace) -> None:
    command = [
        sys.executable,
        "-m",
        "assistive_validation_benchmark.ocr_iteration2_calibration",
        "_capture",
        "--engine",
        engine,
        "--configuration",
        configuration,
        "--run-dir",
        str(args.run_dir),
        "--models-dir",
        str(args.models_dir),
    ]
    if getattr(args, "tesseract_executable", None):
        command.extend(["--tesseract-executable", args.tesseract_executable])
    completed = subprocess.run(command, stdin=subprocess.DEVNULL, shell=False, check=False)
    if completed.returncode != 0:
        raise ValueError(f"capture failed: {engine}/{configuration}")


def _run_stage1(args: argparse.Namespace) -> dict[str, Any]:
    protocol, corpus = _inputs()
    _ensure_assets(args.run_dir, corpus)
    executed = []
    for engine in protocol["staged_cost_policy"]["stage_1_engines"]:
        for configuration in protocol["staged_cost_policy"]["stage_1_configurations"]:
            _run_child(engine, configuration, args)
            executed.append(f"{engine}/{configuration}")
    return {"stage": 1, "executed": executed}


def _run_medium(args: argparse.Namespace) -> dict[str, Any]:
    recommendation = recommend_medium_configuration(args.run_dir / "captures")
    child_args = argparse.Namespace(
        run_dir=args.run_dir,
        models_dir=args.models_dir,
        tesseract_executable=None,
    )
    _run_child("paddle-medium", recommendation["configuration_id"], child_args)
    return {"stage": 2, "engine": "paddle-medium", **recommendation}


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "check":
            result = check_inputs()
        elif args.command == "generate":
            _, corpus = _inputs()
            result = generate_assets(corpus, args.output_dir)
        elif args.command == "_capture":
            result = _capture(args)
        elif args.command == "run-stage1":
            result = _run_stage1(args)
        elif args.command == "recommend-medium":
            result = recommend_medium_configuration(args.run_dir / "captures")
        elif args.command == "run-medium":
            result = _run_medium(args)
        elif args.command == "build-report":
            generation = load_json(args.run_dir / "corpus" / "generation.json")
            result = build_report(args.run_dir / "captures", generation)
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_bytes(canonical_json_bytes(result))
        else:
            result = validate_report(load_json(args.report))
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
        print(f"OCR Iteration 2 calibration failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
