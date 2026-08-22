"""Command surface for the Iteration 2 holdout protocol freeze.

The development commands operate only on exposed ``ocr2-dev-*`` calibration derivatives.
No command downloads a model, creates a fresh holdout case, runs fresh holdout OCR or
authorises a production selection. ``verify-freeze`` remains the gate the future Iteration
2B3 branch must pass before it is allowed to create anything.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from ..ocr_iteration2_calibration.capture import capture_engine
from .distractor_calibration import (
    build_development_evidence,
    development_cases,
    development_warmup,
    generate_development_assets,
    load_calibration_corpus,
    validate_development_evidence,
)
from .fingerprint import (
    compute_fingerprint,
    environment_path,
    require_verification_environment,
    validate_environment,
)
from .manifest import (
    build_freeze_commit_record,
    manifest_path,
    validate_freeze_commit_record,
    verify_candidate_artifacts,
    verify_freeze_manifest,
    write_freeze_manifest,
)
from .report import build_freeze_evidence, validate_freeze_evidence
from .schema import (
    canonical_json_bytes,
    check_inputs,
    data_root,
    load_json,
    repository_root,
    tool_root,
    validate_protocol,
)


def _defaults() -> dict[str, Path]:
    return {
        "evidence": repository_root()
        / "docs"
        / "assistive-validation"
        / "evidence"
        / "ocr-productionization-iteration2-holdout-protocol.json",
        "freeze_commit": data_root() / "freeze-commit.json",
        "models": tool_root() / "artifacts" / "ocr-provisioning" / "models",
        "development_run": tool_root() / "artifacts" / "ocr-iteration2-distractor-calibration",
        "original_capture": tool_root()
        / "artifacts"
        / "ocr-iteration2-calibration"
        / "captures"
        / "paddle-small--dpi180-edge1920.json",
        "development_evidence": repository_root()
        / "docs"
        / "assistive-validation"
        / "evidence"
        / "ocr-productionization-iteration2-distractor-calibration.json",
    }


def _parser() -> argparse.ArgumentParser:
    defaults = _defaults()
    parser = argparse.ArgumentParser(description="PP1 OCR Iteration 2 holdout protocol freeze")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("check", help="validate the frozen protocol, historical evidence and the no-holdout guard")
    subparsers.add_parser("fingerprint", help="print the measured canonical renderer fingerprint")
    subparsers.add_parser("verify-freeze", help="verify the freeze manifest and the canonical renderer fingerprint")
    subparsers.add_parser("write-manifest", help="regenerate the freeze manifest from the frozen components")

    evidence = subparsers.add_parser("build-evidence", help="write the machine-readable protocol-freeze evidence")
    evidence.add_argument("--output", type=Path, default=defaults["evidence"])

    check_evidence = subparsers.add_parser("check-evidence", help="recompute the stored protocol-freeze evidence")
    check_evidence.add_argument("--report", type=Path, default=defaults["evidence"])

    record = subparsers.add_parser("record-freeze-commit", help="record the protocol-freeze commit identity")
    record.add_argument("--commit", required=True, help="the full protocol-freeze commit SHA")
    record.add_argument("--output", type=Path, default=defaults["freeze_commit"])
    record.add_argument(
        "--supersedes-record",
        type=Path,
        default=defaults["freeze_commit"],
        help="the preserved v1 chronology record superseded by the corrected freeze",
    )

    check_commit = subparsers.add_parser("check-freeze-commit", help="verify the stored freeze commit record")
    check_commit.add_argument("--record", type=Path, default=defaults["freeze_commit"])

    candidate = subparsers.add_parser("verify-candidate", help="verify the frozen PP-OCRv6 Small model trees offline")
    candidate.add_argument("--models-dir", type=Path, default=defaults["models"])

    generate_development = subparsers.add_parser(
        "generate-development", help="generate exposed ocr2-dev distractor variants"
    )
    generate_development.add_argument("--run-dir", type=Path, default=defaults["development_run"])

    capture_development = subparsers.add_parser(
        "capture-development", help="run PP-OCRv6 Small on exposed ocr2-dev distractor variants"
    )
    capture_development.add_argument("--run-dir", type=Path, default=defaults["development_run"])
    capture_development.add_argument("--models-dir", type=Path, default=defaults["models"])

    build_development = subparsers.add_parser(
        "build-development-evidence", help="score and store the exposed distractor correction evidence"
    )
    build_development.add_argument("--run-dir", type=Path, default=defaults["development_run"])
    build_development.add_argument("--original-capture", type=Path, default=defaults["original_capture"])
    build_development.add_argument("--output", type=Path, default=defaults["development_evidence"])

    check_development = subparsers.add_parser(
        "check-development-evidence", help="recompute the exposed distractor correction evidence"
    )
    check_development.add_argument("--report", type=Path, default=defaults["development_evidence"])
    return parser


def _verify_freeze() -> dict[str, Any]:
    protocol = validate_protocol(load_json(data_root() / "protocol.json"))
    manifest = verify_freeze_manifest(load_json(manifest_path()))
    environment = validate_environment(load_json(environment_path()))
    fingerprint = require_verification_environment(environment)
    record_path = _defaults()["freeze_commit"]
    freeze_commit = validate_freeze_commit_record(load_json(record_path)) if record_path.is_file() else None
    return {
        "protocol_version": protocol["protocol_version"],
        "freeze_manifest": manifest,
        "canonical_renderer": fingerprint,
        "freeze_commit": freeze_commit,
        "holdout_created": False,
        "ocr_executed": False,
    }


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "check":
            result = check_inputs()
        elif args.command == "fingerprint":
            result = compute_fingerprint()
        elif args.command == "verify-freeze":
            result = _verify_freeze()
        elif args.command == "write-manifest":
            result = {"freeze_manifest": str(write_freeze_manifest())}
        elif args.command == "build-evidence":
            report = build_freeze_evidence()
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_bytes(canonical_json_bytes(report))
            result = {"evidence": str(args.output), "protocol_version": report["protocol_version"]}
        elif args.command == "check-evidence":
            result = validate_freeze_evidence(load_json(args.report))
        elif args.command == "record-freeze-commit":
            record = build_freeze_commit_record(args.commit, load_json(args.supersedes_record))
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_bytes(canonical_json_bytes(record))
            result = {"freeze_commit_record": str(args.output), **record}
        elif args.command == "check-freeze-commit":
            result = validate_freeze_commit_record(load_json(args.record))
        elif args.command == "verify-candidate":
            protocol = validate_protocol(load_json(data_root() / "protocol.json"))
            result = verify_candidate_artifacts(protocol, args.models_dir)
        elif args.command == "generate-development":
            corpus = load_calibration_corpus()
            result = generate_development_assets(corpus, args.run_dir / "corpus")
        elif args.command == "capture-development":
            corpus = load_calibration_corpus()
            cases = development_cases(corpus)
            warmup = development_warmup(corpus)
            generate_development_assets(corpus, args.run_dir / "corpus")
            capture = capture_engine(
                "paddle-small",
                configuration_id="dpi180-edge1920",
                cases=cases,
                warmup_case=warmup,
                assets_dir=args.run_dir / "corpus",
                rendered_dir=args.run_dir / "rendered" / "dpi180-edge1920",
                models_dir=args.models_dir,
                raster_dpi=180,
                max_input_dimension=1920,
                tesseract_executable=None,
            )
            output = args.run_dir / "captures" / "paddle-small--dpi180-edge1920.json"
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(canonical_json_bytes(capture))
            result = {"capture": str(output), "case_count": capture["case_count"], "failures": capture["failures"]}
        elif args.command == "build-development-evidence":
            capture_path = args.run_dir / "captures" / "paddle-small--dpi180-edge1920.json"
            report = build_development_evidence(load_json(args.original_capture), load_json(capture_path))
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_bytes(canonical_json_bytes(report))
            result = {
                "evidence": str(args.output),
                "selected_selector": report["selector_gate"]["selected_selector"],
                "development_primary_wer": report["development_wer_check"]["primary_mean_wer"],
            }
        else:
            result = validate_development_evidence(load_json(args.report))
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
        print(f"OCR Iteration 2 holdout protocol freeze failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
