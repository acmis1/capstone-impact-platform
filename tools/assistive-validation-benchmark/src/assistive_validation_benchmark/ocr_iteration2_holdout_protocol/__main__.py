"""Command surface for the Iteration 2 holdout protocol freeze.

Every command here is read-only with respect to measurement: nothing runs OCR, downloads a
model, creates a holdout case or authorises a production selection. ``verify-freeze`` is the
gate the future Iteration 2B3 branch must pass before it is allowed to create anything.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from .fingerprint import (
    RendererFingerprintMismatch,
    compute_fingerprint,
    environment_path,
    validate_environment,
    verify_fingerprint,
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

    check_commit = subparsers.add_parser("check-freeze-commit", help="verify the stored freeze commit record")
    check_commit.add_argument("--record", type=Path, default=defaults["freeze_commit"])

    candidate = subparsers.add_parser("verify-candidate", help="verify the frozen PP-OCRv6 Small model trees offline")
    candidate.add_argument("--models-dir", type=Path, default=defaults["models"])
    return parser


def _verify_freeze() -> dict[str, Any]:
    protocol = validate_protocol(load_json(data_root() / "protocol.json"))
    manifest = verify_freeze_manifest(load_json(manifest_path()))
    environment = validate_environment(load_json(environment_path()))
    fingerprint = verify_fingerprint(environment)
    if not fingerprint["matches_canonical_renderer"]:
        raise RendererFingerprintMismatch(
            "renderer environment does not match the frozen canonical renderer; divergent components: "
            + ", ".join(fingerprint["divergent_binding_components"])
        )
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
            record = build_freeze_commit_record(args.commit)
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_bytes(canonical_json_bytes(record))
            result = {"freeze_commit_record": str(args.output), **record}
        elif args.command == "check-freeze-commit":
            result = validate_freeze_commit_record(load_json(args.record))
        else:
            protocol = validate_protocol(load_json(data_root() / "protocol.json"))
            result = verify_candidate_artifacts(protocol, args.models_dir)
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
        print(f"OCR Iteration 2 holdout protocol freeze failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
