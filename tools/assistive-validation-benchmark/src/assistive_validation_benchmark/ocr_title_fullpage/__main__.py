from __future__ import annotations

import argparse
import re
from pathlib import Path
from typing import Any

from .capture import candidate_configuration, capture_repeat
from .corpus import build_calibration_corpus
from .evidence import calibration_non_reuse
from .freeze import check_freeze_manifest, write_freeze_manifest
from .renderer import generate_assets
from .schema import (
    canonical_json_bytes,
    data_root,
    evidence_root,
    load_json,
    validate_corpus,
    validate_protocol,
    value_sha256,
)
from .scoring import score_capture
from .selection import aggregate_candidate, preferred_candidate
from .selectors import SELECTORS
from .selector_diagnostic import build_selector_decision, selector_diagnostic


CANDIDATE_ID_PATTERN = re.compile(r"[a-z0-9-]{1,80}")


def _inputs() -> tuple[dict[str, Any], dict[str, Any]]:
    protocol = validate_protocol(load_json(data_root() / "protocol.json"))
    corpus = validate_corpus(load_json(data_root() / "corpus" / "calibration.json"))
    if corpus != build_calibration_corpus():
        raise ValueError("tracked title-fullpage corpus differs from deterministic source")
    return protocol, corpus


def _report(capture: dict[str, Any], corpus: dict[str, Any], protocol: dict[str, Any]) -> dict[str, Any]:
    reuse = calibration_non_reuse(corpus)
    if not reuse["passed"]:
        raise ValueError("title-fullpage calibration reuses prohibited OCR content")
    return {
        "schema_version": "pp1-ocr-title-fullpage-evidence/v1",
        "protocol_sha256": value_sha256(protocol),
        "corpus_sha256": value_sha256(corpus),
        "capture_sha256": value_sha256(capture),
        "non_reuse": reuse,
        "score": score_capture(capture, corpus, protocol),
        "holdout_permitted": False,
        "production_integration_permitted": False,
    }


def _decided_selector_id() -> str:
    return load_json(evidence_root() / "selector-decision.json")["selected_selector_id"]


REJECTED_ATTEMPTS_NAME = "rejected-measurement-attempts.json"
MEASUREMENT_CONTROLS = ("host_load_control",)


def _rejection_reasons(capture: dict[str, Any]) -> list[str]:
    """Which measurement control invalidated this capture. Never a candidate metric."""
    reasons = []
    if capture["host_load"]["quiescent"] is not True:
        reasons.append("host_load_control")
    return reasons


def _rejected_attempt(capture: dict[str, Any], report: dict[str, Any], attempt: int) -> dict[str, Any]:
    """A bounded, auditable record of a measurement the host-load control rejected."""
    score = report["score"]
    measurements = score["operational"]["measurements"]
    return {
        "candidate_id": capture["candidate_id"],
        "repeat": capture["repeat"],
        "attempt": attempt,
        "rejected_by": _rejection_reasons(capture),
        "mean_external_cpu_percent": capture["host_load"]["mean_external_cpu_percent"],
        "maximum_external_cpu_percent": capture["host_load"]["maximum_external_cpu_percent"],
        "precondition_external_cpu_percent": capture["host_load"]["precondition"]["observed_external_cpu_percent"],
        "exact_title_count": score["exact_title_count"],
        "visible_title_case_count": score["visible_title_case_count"],
        "p50_ms": measurements["p50_ms"],
        "p95_ms": measurements["p95_ms"],
        "cold_start_ms": measurements["cold_start_ms"],
        "capture_sha256": report["capture_sha256"],
    }


def _check_rejected_attempts(root: Path, protocol: dict[str, Any]) -> dict[str, Any]:
    """Every re-measured repeat must be attributable to the host-load control alone."""
    path = root / REJECTED_ATTEMPTS_NAME
    bound = protocol["repeatability"]["host_load_control"]["maximum_attempts_per_repeat"]
    ceiling = protocol["repeatability"]["host_load_control"]["maximum_external_cpu_percent"]
    if not path.exists():
        return {"attempt_count": 0, "attempts": []}
    stored = load_json(path)
    attempts = stored["attempts"]
    if stored.get("measurement_controls") != list(MEASUREMENT_CONTROLS) or stored.get("maximum_attempts_per_repeat") != bound:
        raise ValueError("rejected attempt evidence contract differs")
    if stored.get("attempt_count") != len(attempts):
        raise ValueError("rejected attempt count differs from the recorded attempts")
    for attempt in attempts:
        reasons = attempt["rejected_by"]
        if not reasons or any(reason not in MEASUREMENT_CONTROLS for reason in reasons):
            raise ValueError("a repeat was re-measured for a reason other than a measurement control")
        outside_host = (
            "host_load_control" in reasons
            and attempt["mean_external_cpu_percent"] is not None
            and attempt["mean_external_cpu_percent"] > ceiling
        )
        if not outside_host:
            raise ValueError("a rejected attempt was inside every measurement control")
    for candidate_id in {attempt["candidate_id"] for attempt in attempts}:
        for repeat in {a["repeat"] for a in attempts if a["candidate_id"] == candidate_id}:
            same = [a for a in attempts if a["candidate_id"] == candidate_id and a["repeat"] == repeat]
            if len(same) > bound:
                raise ValueError("a repeat exceeded its bounded measurement attempts")
    return {"attempt_count": len(attempts), "attempts": attempts}


def _repeat_pairs(root: Path, candidate_id: str) -> list[tuple[Path, Path]]:
    pairs = []
    for capture in sorted(root.glob(f"{candidate_id}-repeat-*-capture.json")):
        report = capture.with_name(capture.name.replace("-capture.json", "-report.json"))
        if report.exists():
            pairs.append((capture, report))
    return pairs


def _candidate_ids(root: Path) -> list[str]:
    ids = set()
    for path in root.glob("*-repeat-*-capture.json"):
        ids.add(path.name.split("-repeat-")[0])
    return sorted(ids)


def _aggregate(root: Path, candidate_id: str, corpus: dict[str, Any], protocol: dict[str, Any]) -> dict[str, Any]:
    reports = []
    for capture_path, report_path in _repeat_pairs(root, candidate_id):
        capture, stored = load_json(capture_path), load_json(report_path)
        expected = _report(capture, corpus, protocol)
        if stored != expected:
            raise ValueError(f"stored repeat evidence differs from recomputation: {capture_path.name}")
        reports.append(stored)
    if not reports:
        raise ValueError(f"no recorded repeats for candidate: {candidate_id}")
    return aggregate_candidate(candidate_id, reports, protocol)


def _comparison(root: Path, corpus: dict[str, Any], protocol: dict[str, Any]) -> dict[str, Any]:
    candidates = [_aggregate(root, candidate_id, corpus, protocol) for candidate_id in _candidate_ids(root)]
    return {
        "schema_version": "pp1-ocr-title-fullpage-candidate-comparison/v1",
        "protocol_sha256": value_sha256(protocol),
        "corpus_sha256": value_sha256(corpus),
        "selector_id": _decided_selector_id(),
        "same_calibration_corpus_for_every_candidate": True,
        "same_selector_for_every_candidate": len({item["selector_id"] for item in candidates}) <= 1,
        "candidate_count": len(candidates),
        "candidates": candidates,
    }


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="PP1 simple full-page title-OCR qualification")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("write-calibration-corpus")
    sub.add_parser("check-calibration")
    generate = sub.add_parser("generate-calibration")
    generate.add_argument("--output-dir", type=Path, required=True)
    diagnostic = sub.add_parser("capture-selector-diagnostic")
    diagnostic.add_argument("--run-dir", type=Path, required=True)
    diagnostic.add_argument("--models-dir", type=Path, required=True)
    decide = sub.add_parser("write-selector-decision")
    decide.add_argument("--run-dir", type=Path, required=True)
    sub.add_parser("check-selector-decision")
    capture = sub.add_parser("capture-repeat")
    capture.add_argument("--candidate-id", required=True)
    capture.add_argument("--repeat", type=int, required=True)
    capture.add_argument("--cpu-threads", type=int)
    capture.add_argument("--run-dir", type=Path, required=True)
    capture.add_argument("--models-dir", type=Path, required=True)
    record = sub.add_parser("record-repeat")
    record.add_argument("--run-dir", type=Path, required=True)
    rejected = sub.add_parser("record-rejected-attempt")
    rejected.add_argument("--run-dir", type=Path, required=True)
    rejected.add_argument("--attempt", type=int, required=True)
    check_run = sub.add_parser("check-repeat")
    check_run.add_argument("--run-dir", type=Path, required=True)
    sub.add_parser("write-comparison")
    select = sub.add_parser("write-selection")
    select.add_argument("--candidate-id", required=True)
    sub.add_parser("check-evidence")
    freeze = sub.add_parser("write-freeze")
    freeze.add_argument("--calibration-commit", required=True)
    sub.add_parser("check-freeze")
    return parser


def main() -> int:
    args = _build_parser().parse_args()

    if args.command == "write-calibration-corpus":
        path = data_root() / "corpus" / "calibration.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(canonical_json_bytes(build_calibration_corpus()))
        print(path)
        return 0

    protocol, corpus = _inputs()
    root = evidence_root()

    if args.command == "write-freeze":
        print(write_freeze_manifest(args.calibration_commit))
        return 0
    if args.command == "check-freeze":
        print(canonical_json_bytes(check_freeze_manifest()).decode(), end="")
        return 0
    if args.command == "check-calibration":
        reuse = calibration_non_reuse(corpus)
        if not reuse["passed"]:
            raise ValueError("title-fullpage calibration reuses prohibited OCR content")
        print(
            canonical_json_bytes(
                {
                    "protocol_sha256": value_sha256(protocol),
                    "corpus_sha256": value_sha256(corpus),
                    "available_selectors": sorted(SELECTORS),
                    "non_reuse": reuse,
                }
            ).decode(),
            end="",
        )
        return 0
    if args.command == "generate-calibration":
        print(canonical_json_bytes(generate_assets(corpus, args.output_dir)).decode(), end="")
        return 0
    if args.command == "capture-selector-diagnostic":
        args.run_dir.mkdir(parents=True, exist_ok=True)
        diagnostic = selector_diagnostic(corpus, protocol, run_dir=args.run_dir, models_dir=args.models_dir)
        (args.run_dir / "selector-diagnostic.json").write_bytes(canonical_json_bytes(diagnostic))
        print(canonical_json_bytes(diagnostic).decode(), end="")
        return 0
    if args.command == "write-selector-decision":
        decision = build_selector_decision(load_json(args.run_dir / "selector-diagnostic.json"), protocol)
        root.mkdir(parents=True, exist_ok=True)
        (root / "selector-decision.json").write_bytes(canonical_json_bytes(decision))
        print(root / "selector-decision.json")
        return 0
    if args.command == "check-selector-decision":
        stored = load_json(root / "selector-decision.json")
        expected = build_selector_decision(stored["diagnostic"], protocol)
        if stored != expected:
            raise ValueError("stored selector decision differs from recomputation")
        print(canonical_json_bytes(stored).decode(), end="")
        return 0
    if args.command == "capture-repeat":
        if not CANDIDATE_ID_PATTERN.fullmatch(args.candidate_id):
            raise ValueError("candidate ID is unsafe for evidence filenames")
        configuration = candidate_configuration(
            protocol, candidate_id=args.candidate_id, cpu_threads=args.cpu_threads
        )
        args.run_dir.mkdir(parents=True, exist_ok=True)
        captured = capture_repeat(
            corpus,
            protocol,
            configuration,
            repeat=args.repeat,
            selector_id=_decided_selector_id(),
            run_dir=args.run_dir,
            models_dir=args.models_dir,
        )
        report = _report(captured, corpus, protocol)
        (args.run_dir / "capture.json").write_bytes(canonical_json_bytes(captured))
        (args.run_dir / "report.json").write_bytes(canonical_json_bytes(report))
        print(canonical_json_bytes(report["score"]["calibration_margin_checks"]).decode(), end="")
        return 0
    if args.command == "record-rejected-attempt":
        captured = load_json(args.run_dir / "capture.json")
        # The capture is the measurement; the report is derived from it and is always recomputed
        # here under the current protocol, so a protocol amendment made between measuring and
        # recording never silently invalidates a raw capture.
        stored = _report(captured, corpus, protocol)
        if not _rejection_reasons(captured):
            raise ValueError("only a measurement a control rejected may be recorded as an attempt")
        bound = protocol["repeatability"]["host_load_control"]["maximum_attempts_per_repeat"]
        path = root / REJECTED_ATTEMPTS_NAME
        root.mkdir(parents=True, exist_ok=True)
        existing = load_json(path)["attempts"] if path.exists() else []
        entry = _rejected_attempt(captured, stored, args.attempt)
        same_repeat = [
            item for item in existing
            if item["candidate_id"] == entry["candidate_id"] and item["repeat"] == entry["repeat"]
        ]
        if len(same_repeat) >= bound:
            raise ValueError("this repeat exhausted its bounded measurement attempts")
        attempts = sorted(
            [item for item in existing if item["capture_sha256"] != entry["capture_sha256"]] + [entry],
            key=lambda item: (item["candidate_id"], item["repeat"], item["attempt"]),
        )
        path.write_bytes(canonical_json_bytes({
            "schema_version": "pp1-ocr-title-fullpage-rejected-attempts/v1",
            "measurement_controls": list(MEASUREMENT_CONTROLS),
            "maximum_attempts_per_repeat": bound,
            "attempt_count": len(attempts),
            "attempts": attempts,
        }))
        print(path)
        return 0
    if args.command in {"check-repeat", "record-repeat"}:
        captured = load_json(args.run_dir / "capture.json")
        expected = _report(captured, corpus, protocol)
        if args.command == "check-repeat" and load_json(args.run_dir / "report.json") != expected:
            raise ValueError("candidate repeat report differs from recomputation")
        if args.command == "record-repeat":
            candidate_id = captured["candidate_id"]
            if not CANDIDATE_ID_PATTERN.fullmatch(candidate_id):
                raise ValueError("candidate ID is unsafe for evidence filenames")
            prefix = f"{candidate_id}-repeat-{int(captured['repeat']):02d}"
            root.mkdir(parents=True, exist_ok=True)
            (root / f"{prefix}-capture.json").write_bytes(canonical_json_bytes(captured))
            (root / f"{prefix}-report.json").write_bytes(canonical_json_bytes(expected))
            print(root / f"{prefix}-report.json")
        else:
            print(canonical_json_bytes(expected["score"]).decode(), end="")
        return 0

    comparison = _comparison(root, corpus, protocol)
    if args.command == "write-comparison":
        for candidate in comparison["candidates"]:
            (root / f"{candidate['candidate_id']}-aggregate.json").write_bytes(canonical_json_bytes(candidate))
        (root / "candidate-comparison.json").write_bytes(canonical_json_bytes(comparison))
        print(root / "candidate-comparison.json")
        return 0
    if args.command == "write-selection":
        preferred = preferred_candidate(comparison["candidates"])
        if preferred["candidate_id"] != args.candidate_id:
            raise ValueError(
                f"selected candidate differs from the prospective latency/thread rule: {preferred['candidate_id']}"
            )
        selection = {
            "schema_version": "pp1-ocr-title-fullpage-selection/v1",
            "selection_rule": protocol["selection_rule"],
            "selected_candidate_id": preferred["candidate_id"],
            "selected_configuration": preferred["configuration"],
            "selected_architecture": preferred["architecture"],
            "selected_complexity_rank": preferred["complexity_rank"],
            "selected_selector_id": preferred["selector_id"],
            "selected_aggregate_sha256": value_sha256(load_json(root / f"{preferred['candidate_id']}-aggregate.json")),
            "eligible_candidate_ids": sorted(
                item["candidate_id"] for item in comparison["candidates"] if item["selection_eligible"]
            ),
            "every_repeat_satisfied_calibration_margin": True,
            "holdout_permitted_after_dedicated_freeze_commit": True,
            "production_integration_permitted": False,
        }
        (root / "candidate-selection.json").write_bytes(canonical_json_bytes(selection))
        print(root / "candidate-selection.json")
        return 0

    stored_comparison = load_json(root / "candidate-comparison.json")
    if stored_comparison != comparison:
        raise ValueError("stored candidate comparison differs from recomputation")
    for candidate in comparison["candidates"]:
        if load_json(root / f"{candidate['candidate_id']}-aggregate.json") != candidate:
            raise ValueError(f"stored candidate aggregate differs from recomputation: {candidate['candidate_id']}")
    selection = load_json(root / "candidate-selection.json")
    selected = next(
        (item for item in comparison["candidates"] if item["candidate_id"] == selection["selected_candidate_id"]),
        None,
    )
    if selected is None or not selected["selection_eligible"]:
        raise ValueError("stored selected candidate is not eligible")
    if selection["selected_configuration"] != selected["configuration"]:
        raise ValueError("stored selected configuration differs from evidence")
    if selection["selected_candidate_id"] != preferred_candidate(comparison["candidates"])["candidate_id"]:
        raise ValueError("stored selection differs from the prospective selection rule")
    decision = load_json(root / "selector-decision.json")
    if decision != build_selector_decision(decision["diagnostic"], protocol):
        raise ValueError("stored selector decision differs from recomputation")
    rejected = _check_rejected_attempts(root, protocol)
    print(
        canonical_json_bytes({
            "comparison": comparison,
            "selection": selection,
            "selector_decision": decision,
            "rejected_measurement_attempts": rejected,
        }).decode(),
        end="",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
