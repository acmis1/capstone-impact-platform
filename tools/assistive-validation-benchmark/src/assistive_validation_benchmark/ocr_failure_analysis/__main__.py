from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from ..ocr_productionization.boundary import check_production_boundary
from ..ocr_productionization.corpus import generate_assets
from ..ocr_productionization.schema import (
    canonical_json_bytes,
    data_root,
    load_json,
    repository_root,
    tool_root,
    validate_combined_corpus,
)
from .analysis import analyse_capture, development_gate
from .capture import capture_engine, configuration_id, exposed_development_cases
from .report import (
    BASELINE_CONFIGURATION,
    BASELINE_VARIANT,
    build_report,
    capture_reproduction,
    rank_finalists,
    validate_report,
)


DEFAULT_REPORT = (
    repository_root() / "docs" / "assistive-validation" / "evidence" / "ocr-productionization-diagnostic-report.json"
)


def _defaults() -> dict[str, Path]:
    root = tool_root()
    return {
        "models": root / "artifacts" / "ocr-provisioning" / "models",
        "workspace": root / "artifacts" / "ocr-diagnostic",
    }


def _parser() -> argparse.ArgumentParser:
    defaults = _defaults()
    parser = argparse.ArgumentParser(
        description="PP1 assistive OCR failure decomposition and calibration diagnostics (Iteration 2A)"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    capture = subparsers.add_parser("capture", help="capture bounded raw OCR blocks at one raster configuration")
    capture.add_argument("--engine", required=True)
    capture.add_argument("--raster-dpi", type=int, default=150)
    capture.add_argument("--max-input-dimension", type=int, default=960)
    capture.add_argument("--workspace", type=Path, default=defaults["workspace"])
    capture.add_argument("--models-dir", type=Path, default=defaults["models"])
    capture.add_argument("--tesseract-executable")
    capture.add_argument("--case-ids", help="optional comma-separated subset for staged sensitivity runs")

    probe = subparsers.add_parser(
        "probe", help="controlled single-variable title stroke probe (corpus instrument validity)"
    )
    probe.add_argument("--engine", required=True)
    probe.add_argument("--raster-dpi", type=int, default=150)
    probe.add_argument("--max-input-dimension", type=int, default=960)
    probe.add_argument("--workspace", type=Path, default=defaults["workspace"])
    probe.add_argument("--models-dir", type=Path, default=defaults["models"])

    analyse = subparsers.add_parser("analyse", help="summarize one capture without running OCR")
    analyse.add_argument("--capture", type=Path, required=True)
    analyse.add_argument("--full", action="store_true")

    build = subparsers.add_parser("build-report", help="assemble the compact machine diagnostic report")
    build.add_argument("--workspace", type=Path, default=defaults["workspace"])
    build.add_argument("--output", type=Path, default=DEFAULT_REPORT)
    build.add_argument("--stages", type=Path, required=True, help="JSON file describing staged promotion")

    check = subparsers.add_parser("check-report", help="recompute stored diagnostic arithmetic and boundary")
    check.add_argument("--report", type=Path, default=DEFAULT_REPORT)

    subparsers.add_parser("check-boundary", help="re-prove the production OCR boundary")
    return parser


def _corpus_assets(workspace: Path) -> Path:
    """Regenerate the deterministic corpus assets once per workspace."""
    assets = workspace / "corpus"
    if not (assets / "generation.json").is_file():
        calibration = load_json(data_root() / "corpus" / "calibration.json")
        holdout = load_json(data_root() / "corpus" / "holdout.json")
        generate_assets(validate_combined_corpus(calibration, holdout), assets)
    return assets


def _capture(args: argparse.Namespace) -> dict[str, Any]:
    cases = exposed_development_cases()
    if args.case_ids:
        wanted = {value.strip() for value in args.case_ids.split(",") if value.strip()}
        cases = [case for case in cases if case["id"] in wanted]
        if not cases:
            raise ValueError("no exposed development case matched --case-ids")
    config = configuration_id(args.raster_dpi, args.max_input_dimension)
    assets = _corpus_assets(args.workspace)
    observation = capture_engine(
        args.engine,
        cases=cases,
        assets_dir=assets,
        rendered_dir=args.workspace / "rendered" / config,
        models_dir=args.models_dir,
        raster_dpi=args.raster_dpi,
        max_input_dimension=args.max_input_dimension,
        tesseract_executable=args.tesseract_executable,
    )
    suffix = "" if len(cases) == len(exposed_development_cases()) else f"-subset{len(cases)}"
    target = args.workspace / "captures" / f"{args.engine}--{config}{suffix}.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(canonical_json_bytes(observation))
    return {
        "capture": str(target.relative_to(tool_root())),
        "engine": observation["engine"],
        "configuration_id": config,
        "case_count": observation["case_count"],
        "scored": len(observation["records"]),
        "failures": observation["failures"],
        "cold_start_ms": observation["cold_start_ms"],
        "peak_working_set_bytes": observation["peak_working_set_bytes"],
    }


def _probe(args: argparse.Namespace) -> dict[str, Any]:
    from ..ocr_productionization.engine import PADDLE_MODELS, _make_paddle, _run_paddle
    from ..ocr_productionization.offline import enable_offline_guard
    from .stroke_probe import run_probe

    if args.engine not in PADDLE_MODELS:
        raise ValueError("the stroke probe covers the provisioned PP-OCRv6 candidates")
    enable_offline_guard()
    instance, _ = _make_paddle(args.engine, args.models_dir)
    result = run_probe(
        lambda path: _run_paddle(instance, path),
        workspace=args.workspace / "stroke-probe" / str(args.max_input_dimension),
        seed=load_json(data_root() / "corpus" / "calibration.json")["seed"],
        raster_dpi=args.raster_dpi,
        max_input_dimension=args.max_input_dimension,
    )
    target = args.workspace / "probes" / f"stroke-probe-{args.engine}-{args.max_input_dimension}.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(canonical_json_bytes(result))
    return {
        "probe": str(target.relative_to(tool_root())),
        "engine": args.engine,
        "case_count": result["case_count"],
        "stroke_exact_count": result["stroke_exact_count"],
        "no_stroke_exact_count": result["no_stroke_exact_count"],
        "recovered_only_without_stroke": result["recovered_only_without_stroke"],
        "by_selector": result["by_selector"],
        "stroke_variant_matches_corpus_cases": result["stroke_variant_matches_corpus_cases"],
    }


def _summary_digest(summary: dict[str, Any]) -> dict[str, Any]:
    return {
        "engine": summary["engine"],
        "configuration_id": summary["configuration_id"],
        "scored_case_count": summary["scored_case_count"],
        "exact_title_count": summary["exact_title_count"],
        "exact_title_rate": summary["exact_title_rate"],
        "mean_raw_wer": summary["mean_raw_wer"],
        "mean_geometry_wer": summary["mean_geometry_wer"],
        "mean_column_wer": summary["mean_column_wer"],
        "mean_best_wer": summary["mean_best_wer"],
        "failure_taxonomy": summary["failure_taxonomy"],
        "title_oracle": summary["title_oracle"],
        "selector_study": {
            key: {
                "exact_title_count": value["exact_title_count"],
                "exact_title_rate": value["exact_title_rate"],
                "material_false_agreements": value["material_false_agreements"],
            }
            for key, value in summary["selector_study"].items()
        },
        "latency": summary["latency"],
        "cold_start_ms": summary["cold_start_ms"],
        "peak_working_set_bytes": summary["peak_working_set_bytes"],
    }


def best_variant(summary: dict[str, Any]) -> str:
    """Pick the strongest safe selector/ordering pair for this engine and configuration.

    Zero material false agreements is a hard constraint, never traded for exact-title rate.
    This choice is made on the exposed development corpus, which the report records.
    """
    candidates = [
        (key, value)
        for key, value in summary["selector_study"].items()
        if value["material_false_agreements"] == 0
    ] or list(summary["selector_study"].items())
    key, _ = max(
        candidates,
        key=lambda item: (
            item[1]["exact_title_rate"] or 0.0,
            -item[1]["material_false_agreements"],
            item[0] == BASELINE_VARIANT,
            item[0],
        ),
    )
    return key


def _build_report(args: argparse.Namespace) -> dict[str, Any]:
    captures = sorted((args.workspace / "captures").glob("*.json"))
    if not captures:
        raise ValueError("no captures found; run the capture command first")
    summaries: dict[str, dict[str, dict[str, Any]]] = {}
    partial: list[str] = []
    for path in captures:
        capture = load_json(path)
        if capture.get("schema_version") != "pp1-ocr-diagnostic-capture/v1":
            raise ValueError(f"unsupported capture schema in {path.name}")
        summary = analyse_capture(capture)
        if summary["scored_case_count"] != len(exposed_development_cases()):
            # Staged subset sensitivity runs inform promotion but never enter the gate.
            partial.append(f"{summary['engine']}@{summary['configuration_id']}:{summary['scored_case_count']}")
            continue
        summaries.setdefault(summary["engine"], {})[summary["configuration_id"]] = summary
    if not summaries:
        raise ValueError("no full-corpus capture found; the development gate needs all exposed cases")

    scored_variants = {
        f"{engine}@{config}": best_variant(summary)
        for engine, configurations in summaries.items()
        for config, summary in configurations.items()
    }
    gates = [
        development_gate(summaries[engine][config], scored_variants[f"{engine}@{config}"])
        for engine in summaries
        for config in summaries[engine]
    ]
    finalists = rank_finalists(gates)

    leader = finalists[0]
    leader_summary = summaries[leader["engine"]][leader["configuration_id"]]
    unrecoverable = sum(
        not record["oracle"]["recoverable"] for record in leader_summary["records"] if not record["title_exact"]
    )
    residual = leader_summary["scored_case_count"] - leader["exact_title_count"]
    recognition_dominant = residual > 0 and unrecoverable / residual > 0.5

    reproduction = next(
        (
            capture_reproduction(summaries[engine][BASELINE_CONFIGURATION])
            for engine in ("paddle-medium", "paddle-small", "paddle-tiny", "tesseract")
            if engine in summaries and BASELINE_CONFIGURATION in summaries[engine]
        ),
        {"comparable": False},
    )
    conflicting = bool(
        any(summary["failures"] for configurations in summaries.values() for summary in configurations.values())
        or (reproduction.get("comparable") and (reproduction.get("title_exact_agreement_rate") or 0.0) < 0.9)
    )

    probes = {}
    for path in sorted((args.workspace / "probes").glob("stroke-probe-*.json")):
        probe = load_json(path)
        if probe.get("schema_version") != "pp1-ocr-stroke-probe/v2":
            raise ValueError(f"unsupported probe schema in {path.name}")
        probes[path.stem.replace("stroke-probe-", "").rsplit("-", 1)[0]] = probe

    notes = [
        "All numbers are development evidence measured on the exposed v1 corpus; none is independent holdout evidence.",
        f"Selector and reading order were chosen on the exposed corpus: {json.dumps(scored_variants, sort_keys=True)}",
        f"Leader residual title failures: {residual}, of which {unrecoverable} are absent from OCR output entirely.",
    ]
    if partial:
        notes.append(f"Staged subset sensitivity captures excluded from the gate: {', '.join(sorted(partial))}")

    report = build_report(
        summaries=summaries,
        stages=load_json(args.stages)["stages"],
        scored_variants=scored_variants,
        probes=probes,
        recognition_dominant=recognition_dominant,
        conflicting=conflicting,
        notes=notes,
    )
    validate_report(report)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(canonical_json_bytes(report))
    return {
        "output": str(args.output.relative_to(repository_root())),
        "decision": report["decision"],
        "finalists": [
            {
                "engine": gate["engine"],
                "configuration_id": gate["configuration_id"],
                "selector": gate["selector"],
                "exact_title_rate": gate["exact_title_rate"],
                "mean_wer": gate["mean_wer"],
                "holdout_worthy": gate["holdout_worthy"],
            }
            for gate in report["finalists"]
        ],
    }


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "capture":
            result: Any = _capture(args)
        elif args.command == "analyse":
            summary = analyse_capture(load_json(args.capture))
            result = summary if args.full else _summary_digest(summary)
        elif args.command == "probe":
            result = _probe(args)
        elif args.command == "build-report":
            result = _build_report(args)
        elif args.command == "check-report":
            report = validate_report(load_json(args.report))
            result = {
                "schema_version": report["schema_version"],
                "decision": report["decision"],
                "development_corpus": report["development_corpus"],
                "merged_evidence_unchanged": True,
                "production_boundary": report["production_boundary"],
            }
        else:
            result = check_production_boundary(repository_root())
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
        print(f"OCR failure analysis failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
