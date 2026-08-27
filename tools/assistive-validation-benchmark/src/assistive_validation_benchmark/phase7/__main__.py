from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from .corpus import (
    build_calibration_manifest,
    build_holdout_manifest,
    combined_calibration_cases,
    load_calibration_manifest,
    load_holdout_manifest,
)
from .evidence import load_evidence, validate_calibration_evidence, validate_final_evidence
from .freeze import (
    FREEZE_RECORD_SCHEMA_VERSION,
    load_freeze_manifest,
    validate_freeze_record,
    verify_freeze_commit,
    write_freeze_manifest,
)
from .history import check_calibration_non_reuse, check_fresh_holdout_non_reuse
from .policy import canonical_json_bytes, load_policy, validate_policy, value_sha256
from .runner import (
    build_calibration_report,
    build_final_report,
    claim_one_shot_output,
    complete_one_shot_output,
    preflight_candidate_runtime,
    seal_one_shot_state,
    validate_completed_one_shot_state,
)


def tool_root() -> Path:
    return Path(__file__).resolve().parents[3]


def repository_root() -> Path:
    return tool_root().parents[1]


def defaults() -> dict[str, Path]:
    root = tool_root()
    return {
        "calibration": root / "phase7" / "corpus" / "calibration.json",
        "holdout": root / "phase7" / "corpus" / "holdout.json",
        "policy": root / "phase7" / "policy.json",
        "calibration_evidence": root / "phase7" / "calibration-evidence.json",
        "freeze_manifest": root / "phase7" / "freeze-manifest.json",
        "freeze_record": root / "phase7" / "freeze-record.json",
        "one_shot_state": root / "phase7" / "one-shot-state.json",
        "final_evidence": repository_root() / "docs" / "assistive-validation" / "evidence" / "phase-7-report.json",
    }


def parser() -> argparse.ArgumentParser:
    paths = defaults()
    value = argparse.ArgumentParser(description="PP1 Phase 7 local spelling and grammar recovery benchmark")
    subparsers = value.add_subparsers(dest="command", required=True)
    generate = subparsers.add_parser("generate-calibration")
    generate.add_argument("--output", type=Path, default=paths["calibration"])
    subparsers.add_parser("check-calibration")

    run_calibration = subparsers.add_parser("run-calibration")
    run_calibration.add_argument("--languagetool-archive", type=Path, required=True)
    run_calibration.add_argument("--languagetool-jar", type=Path, required=True)
    run_calibration.add_argument("--output", type=Path, required=True)
    subparsers.add_parser("check-calibration-evidence")
    subparsers.add_parser("write-freeze-manifest")
    subparsers.add_parser("check-freeze-manifest")

    record = subparsers.add_parser("record-freeze")
    record.add_argument("--commit", required=True)
    record.add_argument("--output", type=Path, default=paths["freeze_record"])
    subparsers.add_parser("check-freeze-record")

    holdout = subparsers.add_parser("generate-holdout")
    holdout.add_argument("--seed", required=True)
    holdout.add_argument("--output", type=Path, default=paths["holdout"])

    seal = subparsers.add_parser("seal-holdout")
    seal.add_argument("--freeze-commit", required=True)
    seal.add_argument("--state", type=Path, default=paths["one_shot_state"])

    final = subparsers.add_parser("run-final")
    final.add_argument("--freeze-commit", required=True)
    final.add_argument("--languagetool-archive", type=Path, required=True)
    final.add_argument("--languagetool-jar", type=Path, required=True)
    final.add_argument("--state", type=Path, default=paths["one_shot_state"])
    final.add_argument("--evidence-output", type=Path, default=paths["final_evidence"])
    subparsers.add_parser("check-final-evidence")
    return value


def _load_inputs() -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any]]:
    paths = defaults()
    calibration = load_calibration_manifest(paths["calibration"])
    cases = combined_calibration_cases(tool_root(), calibration)
    policy = load_policy(paths["policy"])
    validate_policy(policy, cases, repository_root())
    return calibration, cases, policy


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(canonical_json_bytes(value))


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    paths = defaults()
    try:
        if args.command == "generate-calibration":
            generated = build_calibration_manifest(tool_root())
            _write_json(args.output, generated)
            result: Any = {"calibration": str(args.output), "case_count": len(generated["cases"])}
        elif args.command == "check-calibration":
            committed = load_calibration_manifest(paths["calibration"])
            generated = build_calibration_manifest(tool_root())
            if canonical_json_bytes(committed) != canonical_json_bytes(generated):
                raise ValueError("Committed Phase 7 calibration differs from deterministic generation")
            _, cases, policy = _load_inputs()
            result = {
                "valid": True,
                "combined_calibration_cases": len(cases),
                "policy": validate_policy(policy, cases, repository_root()),
                "calibration_non_reuse": check_calibration_non_reuse(tool_root(), cases),
                "fresh_holdout_exists": paths["holdout"].is_file(),
            }
        elif args.command == "run-calibration":
            calibration, cases, policy = _load_inputs()
            report = build_calibration_report(
                cases,
                calibration["corpus_version"],
                tool_root=tool_root(),
                repository_root=repository_root(),
                policy=policy,
                languagetool_archive=args.languagetool_archive.resolve(),
                languagetool_jar=args.languagetool_jar.resolve(),
            )
            validate_calibration_evidence(report, cases, calibration["corpus_version"], policy, repository_root())
            _write_json(args.output, report)
            result = {"calibration_evidence": str(args.output), "policy_sha256": value_sha256(policy)}
        elif args.command == "check-calibration-evidence":
            calibration, cases, policy = _load_inputs()
            report = load_evidence(paths["calibration_evidence"])
            validate_calibration_evidence(report, cases, calibration["corpus_version"], policy, repository_root())
            result = {"valid": True, "calibration_evidence": str(paths["calibration_evidence"])}
        elif args.command == "write-freeze-manifest":
            result = {"freeze_manifest": str(write_freeze_manifest(tool_root(), paths["freeze_manifest"]))}
        elif args.command == "check-freeze-manifest":
            freeze = load_freeze_manifest(paths["freeze_manifest"], tool_root())
            result = {"valid": True, "freeze_tree_sha256": freeze["freeze_tree_sha256"], "file_count": len(freeze["entries"])}
        elif args.command == "record-freeze":
            freeze = load_freeze_manifest(paths["freeze_manifest"], tool_root())
            verified = verify_freeze_commit(tool_root(), args.commit, freeze)
            record = {
                "schema_version": FREEZE_RECORD_SCHEMA_VERSION,
                "policy_freeze_commit_sha": verified["policy_freeze_commit_sha"],
                "freeze_tree_sha256": verified["freeze_tree_sha256"],
                "holdout_absent_at_freeze": True,
            }
            _write_json(args.output, record)
            result = record
        elif args.command == "check-freeze-record":
            freeze = load_freeze_manifest(paths["freeze_manifest"], tool_root())
            record = validate_freeze_record(
                json.loads(paths["freeze_record"].read_text(encoding="utf-8")), freeze
            )
            verified = verify_freeze_commit(tool_root(), record["policy_freeze_commit_sha"], freeze)
            result = {"valid": True, **verified}
        elif args.command == "generate-holdout":
            freeze = load_freeze_manifest(paths["freeze_manifest"], tool_root())
            record = validate_freeze_record(
                json.loads(paths["freeze_record"].read_text(encoding="utf-8")), freeze
            )
            verify_freeze_commit(tool_root(), record["policy_freeze_commit_sha"], freeze)
            holdout = build_holdout_manifest(args.seed)
            _write_json(args.output, holdout)
            result = {
                "holdout": str(args.output),
                "case_count": len(holdout["cases"]),
                "seed_sha256": holdout["generation"]["seed_sha256"],
            }
        elif args.command == "seal-holdout":
            calibration, calibration_cases, policy = _load_inputs()
            holdout = load_holdout_manifest(paths["holdout"])
            freeze = load_freeze_manifest(paths["freeze_manifest"], tool_root())
            record = validate_freeze_record(
                json.loads(paths["freeze_record"].read_text(encoding="utf-8")), freeze
            )
            if record["policy_freeze_commit_sha"] != args.freeze_commit:
                raise ValueError("Seal commit argument differs from the recorded policy freeze")
            verify_freeze_commit(tool_root(), args.freeze_commit, freeze)
            check_fresh_holdout_non_reuse(tool_root(), calibration_cases, holdout["cases"])
            calibration_report = load_evidence(paths["calibration_evidence"])
            validate_calibration_evidence(
                calibration_report, calibration_cases, calibration["corpus_version"], policy, repository_root()
            )
            state = seal_one_shot_state(
                args.state, paths["holdout"], value_sha256(policy), args.freeze_commit
            )
            result = {"state": str(state), "status": "SEALED_UNCONSUMED", "run_count": 0}
        elif args.command == "run-final":
            calibration, calibration_cases, policy = _load_inputs()
            holdout = load_holdout_manifest(paths["holdout"])
            freeze = load_freeze_manifest(paths["freeze_manifest"], tool_root())
            record = validate_freeze_record(
                json.loads(paths["freeze_record"].read_text(encoding="utf-8")), freeze
            )
            if record["policy_freeze_commit_sha"] != args.freeze_commit:
                raise ValueError("Final run commit argument differs from the recorded policy freeze")
            verify_freeze_commit(tool_root(), args.freeze_commit, freeze)
            check_fresh_holdout_non_reuse(tool_root(), calibration_cases, holdout["cases"])
            calibration_report = load_evidence(paths["calibration_evidence"])
            validate_calibration_evidence(
                calibration_report, calibration_cases, calibration["corpus_version"], policy, repository_root()
            )
            preflight_candidate_runtime(
                tool_root=tool_root(),
                policy=policy,
                languagetool_archive=args.languagetool_archive.resolve(),
                languagetool_jar=args.languagetool_jar.resolve(),
            )
            state_path = claim_one_shot_output(
                args.state.resolve(), paths["holdout"], value_sha256(policy), args.freeze_commit
            )
            report = build_final_report(
                holdout["cases"],
                holdout["corpus_version"],
                calibration_cases,
                tool_root=tool_root(),
                repository_root=repository_root(),
                policy=policy,
                freeze_commit_sha=args.freeze_commit,
                languagetool_archive=args.languagetool_archive.resolve(),
                languagetool_jar=args.languagetool_jar.resolve(),
            )
            validate_final_evidence(
                report,
                holdout["cases"],
                holdout["corpus_version"],
                calibration_cases,
                calibration_report,
                tool_root=tool_root(),
                repository_root=repository_root(),
                policy=policy,
            )
            _write_json(args.evidence_output, report)
            complete_one_shot_output(state_path, args.evidence_output)
            result = {"final_evidence": str(args.evidence_output), "decisions": report["decisions"]}
        else:
            calibration, calibration_cases, policy = _load_inputs()
            holdout = load_holdout_manifest(paths["holdout"])
            report = load_evidence(paths["final_evidence"])
            calibration_report = load_evidence(paths["calibration_evidence"])
            validate_final_evidence(
                report,
                holdout["cases"],
                holdout["corpus_version"],
                calibration_cases,
                calibration_report,
                tool_root=tool_root(),
                repository_root=repository_root(),
                policy=policy,
            )
            freeze_record = json.loads(paths["freeze_record"].read_text(encoding="utf-8"))
            validate_completed_one_shot_state(
                paths["one_shot_state"],
                paths["holdout"],
                paths["final_evidence"],
                value_sha256(policy),
                freeze_record["policy_freeze_commit_sha"],
            )
            result = {"valid": True, "final_evidence": str(paths["final_evidence"]), "decisions": report["decisions"]}
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    except Exception as error:
        print(f"Phase 7 benchmark failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
