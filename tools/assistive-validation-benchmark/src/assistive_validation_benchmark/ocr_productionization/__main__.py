from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

from .boundary import check_production_boundary
from .corpus import generate_assets
from .engine import run_engine
from .evidence import ALL_ENGINES, build_evidence, summarize_engine, validate_evidence
from .provision import prepare_models
from .schema import (
    canonical_json_bytes,
    data_root,
    load_json,
    prove_phase0_holdout_independence,
    repository_root,
    tool_root,
    validate_artifact_manifest,
    validate_combined_corpus,
    validate_protocol,
    value_sha256,
)


def _default_paths() -> dict[str, Path]:
    root = tool_root()
    return {
        "protocol": data_root() / "protocol.json",
        "artifacts": data_root() / "artifact-manifest.json",
        "calibration": data_root() / "corpus" / "calibration.json",
        "holdout": data_root() / "corpus" / "holdout.json",
        "archives": root / "artifacts" / "ocr-provisioning" / "archives",
        "models": root / "artifacts" / "ocr-provisioning" / "models",
    }


def _parser() -> argparse.ArgumentParser:
    defaults = _default_paths()
    parser = argparse.ArgumentParser(description="PP1 assistive OCR productionization decision benchmark")
    subparsers = parser.add_subparsers(dest="command", required=True)

    check = subparsers.add_parser("check", help="run lightweight protocol, corpus, artifact and production-boundary gates")
    check.add_argument("--allow-missing-holdout", action="store_true")

    generate = subparsers.add_parser("generate", help="generate the deterministic OCR corpus")
    generate.add_argument("--output-dir", type=Path, required=True)
    generate.add_argument("--allow-missing-holdout", action="store_true")

    provision = subparsers.add_parser("provision", help="fetch/prepare or offline-verify frozen PP-OCRv6 artifacts")
    provision.add_argument("--archives-dir", type=Path, default=defaults["archives"])
    provision.add_argument("--models-dir", type=Path, default=defaults["models"])
    provision.add_argument("--download", action="store_true", help="allow official HTTPS artifact download")
    provision.add_argument("--allow-unfrozen-trees", action="store_true", help=argparse.SUPPRESS)

    run = subparsers.add_parser("run", help="run all frozen candidates in isolated processes")
    run.add_argument("--measurement", choices=("calibration", "final"), required=True)
    run.add_argument("--output-dir", type=Path, required=True)
    run.add_argument("--archives-dir", type=Path, default=defaults["archives"])
    run.add_argument("--models-dir", type=Path, default=defaults["models"])
    run.add_argument("--tesseract-executable")
    run.add_argument("--protocol-freeze-sha")
    run.add_argument("--evidence-output", type=Path)

    engine = subparsers.add_parser("_engine-run", help=argparse.SUPPRESS)
    engine.add_argument("--engine", choices=ALL_ENGINES, required=True)
    engine.add_argument("--measurement", choices=("calibration", "final"), required=True)
    engine.add_argument("--assets-dir", type=Path, required=True)
    engine.add_argument("--rendered-dir", type=Path, required=True)
    engine.add_argument("--models-dir", type=Path, required=True)
    engine.add_argument("--output", type=Path, required=True)
    engine.add_argument("--tesseract-executable")
    engine.add_argument("--offline", action="store_true")

    export_calibration = subparsers.add_parser("export-calibration", help="export compact pre-freeze calibration evidence")
    export_calibration.add_argument("--input-dir", type=Path, required=True)
    export_calibration.add_argument("--output", type=Path, required=True)

    evidence = subparsers.add_parser("check-evidence", help="recompute stored OCR evidence arithmetic and decision")
    evidence.add_argument(
        "--report",
        type=Path,
        default=repository_root() / "docs" / "assistive-validation" / "evidence" / "ocr-productionization-report.json",
    )
    return parser


def _load_inputs(require_holdout: bool) -> tuple[dict[str, Any], dict[str, Any] | None, dict[str, Any], dict[str, Any]]:
    defaults = _default_paths()
    calibration = load_json(defaults["calibration"])
    holdout = load_json(defaults["holdout"]) if defaults["holdout"].is_file() else None
    if require_holdout and holdout is None:
        raise ValueError("fresh holdout has not been added after the protocol freeze")
    protocol = validate_protocol(load_json(defaults["protocol"]))
    artifact_manifest = load_json(defaults["artifacts"])
    return calibration, holdout, protocol, artifact_manifest


def _check(allow_missing_holdout: bool) -> dict[str, Any]:
    calibration, holdout, protocol, artifacts = _load_inputs(require_holdout=not allow_missing_holdout)
    validate_artifact_manifest(artifacts, allow_unfrozen_trees=allow_missing_holdout)
    manifest = validate_combined_corpus(calibration, holdout)
    independence = prove_phase0_holdout_independence(manifest)
    boundary = check_production_boundary(repository_root())
    return {
        "protocol_sha256": value_sha256(protocol),
        "artifact_manifest_sha256": value_sha256(artifacts),
        "corpus_manifest_sha256": value_sha256(manifest),
        "holdout_present": holdout is not None,
        "phase0_independence": independence,
        "production_boundary": boundary,
    }


def _engine_command(args: argparse.Namespace) -> int:
    calibration, holdout, protocol, _ = _load_inputs(require_holdout=args.measurement == "final")
    part = calibration if args.measurement == "calibration" else holdout
    assert part is not None
    target_split = "calibration" if args.measurement == "calibration" else "holdout"
    cases = [case for case in part["ocr_cases"] if case["split"] == target_split]
    warmup = next(case for case in calibration["ocr_cases"] if case["split"] == "warmup")
    observation = run_engine(
        args.engine,
        cases=cases,
        warmup_case=warmup,
        assets_dir=args.assets_dir,
        rendered_dir=args.rendered_dir,
        models_dir=args.models_dir,
        raster_dpi=protocol["configuration"]["raster_dpi"],
        max_input_dimension=protocol["configuration"]["max_input_dimension"],
        tesseract_psm=protocol["configuration"]["tesseract"]["page_segmentation_mode"],
        tesseract_executable=args.tesseract_executable,
        offline=args.offline,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(canonical_json_bytes(observation))
    return 0


def _run_suite(args: argparse.Namespace) -> dict[str, Any]:
    calibration, holdout, protocol, artifact_manifest = _load_inputs(require_holdout=args.measurement == "final")
    validate_artifact_manifest(artifact_manifest)
    manifest = validate_combined_corpus(calibration, holdout)
    if args.measurement == "final" and not args.protocol_freeze_sha:
        raise ValueError("final measurement requires the exact protocol freeze commit SHA")
    state_path = args.output_dir / f"{args.measurement}-run-state.json"
    if args.measurement == "final" and state_path.exists():
        raise ValueError("final holdout already started; preserve it and use a new benchmark/holdout rather than rerunning")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    assets_dir = args.output_dir / "corpus"
    rendered_dir = args.output_dir / "rendered"
    generation = generate_assets(manifest, assets_dir)
    state = {
        "schema_version": "pp1-ocr-run-state/v1",
        "measurement": args.measurement,
        "protocol_freeze_sha": args.protocol_freeze_sha,
        "corpus_manifest_sha256": value_sha256(manifest),
        "engines": {},
        "status": "running",
    }
    state_path.write_bytes(canonical_json_bytes(state))
    observations = {}
    for engine in ALL_ENGINES:
        raw_path = args.output_dir / "engines" / f"{engine}.json"
        command = [
            sys.executable,
            "-m",
            "assistive_validation_benchmark.ocr_productionization",
            "_engine-run",
            "--engine",
            engine,
            "--measurement",
            args.measurement,
            "--assets-dir",
            str(assets_dir),
            "--rendered-dir",
            str(rendered_dir),
            "--models-dir",
            str(args.models_dir),
            "--output",
            str(raw_path),
            "--offline",
        ]
        if args.tesseract_executable:
            command.extend(["--tesseract-executable", args.tesseract_executable])
        state["engines"][engine] = "running"
        state_path.write_bytes(canonical_json_bytes(state))
        completed = subprocess.run(command, stdin=subprocess.DEVNULL, shell=False, check=False)
        if completed.returncode != 0 or not raw_path.is_file():
            state["engines"][engine] = "failed"
            state["status"] = "failed"
            state_path.write_bytes(canonical_json_bytes(state))
            raise ValueError(f"{engine} process failed; final holdout is exposed and must not be rerun")
        observations[engine] = load_json(raw_path)
        state["engines"][engine] = "completed"
        state_path.write_bytes(canonical_json_bytes(state))
    state["status"] = "completed"
    state_path.write_bytes(canonical_json_bytes(state))
    if args.measurement == "calibration":
        summary = {
            "schema_version": "pp1-ocr-calibration-run/v1",
            "corpus_manifest_sha256": value_sha256(manifest),
            "generated_corpus_asset_sha256": generation["corpus_asset_sha256"],
            "engines": {name: summarize_engine(observations[name], protocol) for name in ALL_ENGINES},
        }
        (args.output_dir / "calibration-report.json").write_bytes(canonical_json_bytes(summary))
        return summary
    assert holdout is not None and args.protocol_freeze_sha
    report = build_evidence(
        tool_root=tool_root(),
        freeze_sha=args.protocol_freeze_sha,
        calibration=calibration,
        holdout=holdout,
        protocol=protocol,
        artifact_manifest=artifact_manifest,
        engine_observations=observations,
        generation=generation,
        assets_dir=assets_dir,
        archives_dir=args.archives_dir,
        models_dir=args.models_dir,
    )
    (args.output_dir / "report.json").write_bytes(canonical_json_bytes(report))
    if args.evidence_output:
        args.evidence_output.parent.mkdir(parents=True, exist_ok=True)
        args.evidence_output.write_bytes(canonical_json_bytes(report))
    return report


def _export_calibration(input_dir: Path, output: Path) -> dict[str, Any]:
    report = load_json(input_dir / "calibration-report.json")
    compact = {
        "schema_version": "pp1-ocr-calibration-evidence/v1",
        "corpus_manifest_sha256": report["corpus_manifest_sha256"],
        "generated_corpus_asset_sha256": report["generated_corpus_asset_sha256"],
        "configuration_frozen_after_calibration": True,
        "engines": {
            name: {
                key: value
                for key, value in report["engines"][name].items()
                if key not in {"records", "failures"}
            }
            for name in ALL_ENGINES
        },
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(canonical_json_bytes(compact))
    return compact


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "check":
            result = _check(args.allow_missing_holdout)
        elif args.command == "generate":
            calibration, holdout, _, _ = _load_inputs(require_holdout=not args.allow_missing_holdout)
            manifest = validate_combined_corpus(calibration, holdout)
            result = generate_assets(manifest, args.output_dir)
        elif args.command == "provision":
            result = prepare_models(
                _default_paths()["artifacts"],
                archives_dir=args.archives_dir,
                models_dir=args.models_dir,
                allow_download=args.download,
                allow_unfrozen_trees=args.allow_unfrozen_trees,
            )
        elif args.command == "_engine-run":
            return _engine_command(args)
        elif args.command == "run":
            result = _run_suite(args)
        elif args.command == "export-calibration":
            result = _export_calibration(args.input_dir, args.output)
        else:
            calibration, holdout, protocol, artifacts = _load_inputs(require_holdout=True)
            assert holdout is not None
            result = validate_evidence(
                load_json(args.report),
                protocol=protocol,
                artifact_manifest=validate_artifact_manifest(artifacts),
                calibration=calibration,
                holdout=holdout,
            )
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
        print(f"OCR productionization benchmark failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
