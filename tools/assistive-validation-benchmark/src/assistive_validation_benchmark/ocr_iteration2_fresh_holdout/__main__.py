"""Command surface for fresh candidate creation, sealing, and the later one-shot run."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from ..ocr_iteration2_holdout_protocol.fingerprint import require_verification_environment
from ..ocr_iteration2_holdout_protocol.manifest import (
    manifest_path,
    validate_freeze_commit_record,
    verify_freeze_manifest,
)
from ..ocr_iteration2_holdout_protocol.schema import (
    data_root as protocol_data_root,
    load_json,
    tool_root,
    validate_protocol,
)
from .corpus import (
    FIXTURE_PREFIX,
    build_candidate,
    create_and_lock_candidate,
    preapproval_path,
    validate_fixture_allocation,
)
from .runner import run_one_shot
from .seal import seal_approved_candidate, validate_seal


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="PP1 OCR Iteration 2 fresh holdout")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("check-tooling", help="validate the fixture-only allocation and frozen imports")
    subparsers.add_parser("create-candidate", help="create and lock the one fresh candidate without rendering or OCR")
    subparsers.add_parser("show-review", help="show the pending semantic human-review pairs")
    seal = subparsers.add_parser("seal", help="apply explicit human approval and seal canonical generation evidence")
    seal.add_argument("--approval-file", type=Path, required=True)
    subparsers.add_parser("check-seal", help="validate the committed seal without model loading or asset generation")
    run = subparsers.add_parser("run-one-shot", help="perform the separately authorised one-shot OCR run")
    run.add_argument("--models-dir", type=Path, default=tool_root() / "artifacts" / "ocr-provisioning" / "models")
    return parser


def _check_tooling() -> dict[str, object]:
    protocol = validate_protocol(load_json(protocol_data_root() / "protocol.json"))
    freeze = verify_freeze_manifest(load_json(manifest_path()))
    commit = validate_freeze_commit_record(load_json(protocol_data_root() / "freeze-commit.json"))
    renderer = require_verification_environment()
    fixture = build_candidate(prefix=FIXTURE_PREFIX)
    allocation = validate_fixture_allocation(fixture, protocol)
    return {
        "protocol_version": protocol["protocol_version"],
        "freeze_tree_sha256": freeze["freeze_tree_sha256"],
        "freeze_manifest_sha256": freeze["freeze_manifest_sha256"],
        "freeze_commit_sha": commit["protocol_freeze_commit_sha"],
        "renderer_fingerprint_sha256": renderer["expected_fingerprint_sha256"],
        "fixture_namespace": FIXTURE_PREFIX,
        "allocation": allocation,
        "real_holdout_created": False,
        "ocr_executed": False,
    }


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "check-tooling":
            result = _check_tooling()
        elif args.command == "create-candidate":
            result = create_and_lock_candidate()
        elif args.command == "show-review":
            result = load_json(preapproval_path())
        elif args.command == "seal":
            result = seal_approved_candidate(args.approval_file)
        elif args.command == "check-seal":
            result = validate_seal()
        else:
            result = run_one_shot(args.models_dir)
        print(json.dumps(result, indent=2, sort_keys=True, ensure_ascii=False))
        return 0
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
        print(f"OCR Iteration 2 fresh holdout failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
