from __future__ import annotations

import argparse
import json
import shlex
import sys
from pathlib import Path

from .corpus import generate_corpus
from .manifest import cases_of_kind, load_manifest
from .report import export_review_evidence, render_markdown
from .runner import DEFAULT_SECTIONS, make_decisions, run_benchmark
from .phase6.corpus import (
    build_phase6_manifest,
    canonical_json_bytes,
    load_phase6_manifest,
    manifest_sha256,
    validate_phase6_manifest,
)
from .phase6.history import (
    check_holdout_independence,
    load_benchmark_history,
    load_exposed_holdout_texts,
    load_policy_freeze,
)
from .phase6.provenance import validate_vocabulary_policy
from .phase6.runner import compact_phase6_evidence, run_phase6_benchmark, validate_phase6_evidence


def _paths() -> tuple[Path, Path, Path]:
    tool_root = Path(__file__).resolve().parents[2]
    repository_root = tool_root.parents[1]
    manifest = tool_root / "corpus" / "manifest.json"
    return tool_root, repository_root, manifest


def _parser() -> argparse.ArgumentParser:
    tool_root, repository_root, manifest = _paths()
    parser = argparse.ArgumentParser(description="PP1 local assistive-validation Phase 0 benchmark")
    parser.add_argument("--manifest", type=Path, default=manifest)
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("validate", help="validate the machine-readable corpus manifest")
    generate = subparsers.add_parser("generate", help="generate deterministic document fixtures")
    generate.add_argument("--output-dir", type=Path, default=tool_root / "artifacts" / "corpus")
    generate.add_argument("--seed", type=int)

    evidence = subparsers.add_parser("export-evidence", help="sanitize an existing machine report for review")
    evidence.add_argument("--input-report", type=Path, required=True)
    evidence.add_argument("--output", type=Path, required=True)

    run = subparsers.add_parser("run", help="generate the corpus and run selected benchmark sections")
    run.add_argument("--output-dir", type=Path, default=tool_root / "artifacts" / "latest")
    run.add_argument("--seed", type=int)
    run.add_argument("--sections", default="all", help="all or comma-separated native,ocr,title,grammar,duplicates")
    run.add_argument("--ocr-engines", default="tesseract,paddle-small,paddle-medium",
                     help="comma-separated tesseract,paddle-tiny,paddle-small,paddle-medium")
    run.add_argument("--languagetool-url", default="http://127.0.0.1:8081",
                     help="loopback-only local LanguageTool base URL")
    run.add_argument("--languagetool-pid", type=int, help="optional local server PID for process-memory measurement")
    run.add_argument("--languagetool-language", default="en-AU", help="language code sent to the local LanguageTool server")
    run.add_argument("--tesseract-psm", default="3",
                     help="Tesseract page segmentation mode; 3 (automatic) keeps layout analysis comparable with PP-OCR detection")

    phase6_manifest = tool_root / "phase6" / "corpus" / "manifest.json"
    phase6_generate = subparsers.add_parser("phase6-generate", help="generate the frozen deterministic Phase 6A corpus manifest")
    phase6_generate.add_argument("--output", type=Path, default=phase6_manifest)
    phase6_validate = subparsers.add_parser("phase6-validate", help="validate and reproduce the committed Phase 6A corpus")
    phase6_validate.add_argument("--phase6-manifest", type=Path, default=phase6_manifest)
    phase6_run = subparsers.add_parser("phase6-run", help="run calibration-only or first-final Phase 6A evidence")
    phase6_run.add_argument("--phase6-manifest", type=Path, default=phase6_manifest)
    phase6_run.add_argument("--measurement", choices=("calibration", "final"), required=True)
    phase6_run.add_argument("--languagetool-jar", type=Path, required=True)
    phase6_run.add_argument("--output", type=Path, required=True)
    phase6_policy = subparsers.add_parser("phase6-check-policy", help="prove Phase 6A vocabulary provenance and holdout independence")
    phase6_policy.add_argument("--phase6-manifest", type=Path, default=phase6_manifest)
    phase6_evidence = subparsers.add_parser("phase6-check-evidence", help="verify stored Phase 6A evidence and decisions")
    phase6_evidence.add_argument("--phase6-manifest", type=Path, default=phase6_manifest)
    phase6_evidence.add_argument("--evidence", type=Path, default=repository_root / "docs" / "assistive-validation" / "evidence" / "phase-6a-report.json")
    phase6_export = subparsers.add_parser("phase6-export-evidence", help="compact a final Phase 6A machine report for review")
    phase6_export.add_argument("--phase6-manifest", type=Path, default=phase6_manifest)
    phase6_export.add_argument("--input-report", type=Path, required=True)
    phase6_export.add_argument("--output", type=Path, required=True)
    return parser


def _csv(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    tool_root, repository_root, _ = _paths()
    if args.command == "phase6-generate":
        phase6_manifest = validate_phase6_manifest(build_phase6_manifest())
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_bytes(canonical_json_bytes(phase6_manifest))
        print(json.dumps({"generated": str(args.output), "sha256": manifest_sha256(phase6_manifest)}, indent=2))
        return 0
    if args.command in {"phase6-validate", "phase6-run", "phase6-check-evidence", "phase6-export-evidence", "phase6-check-policy"}:
        phase6_manifest = load_phase6_manifest(args.phase6_manifest.resolve())
        generated = validate_phase6_manifest(build_phase6_manifest())
        if canonical_json_bytes(phase6_manifest) != canonical_json_bytes(generated):
            raise SystemExit("committed Phase 6 manifest does not match deterministic generation")
        if args.command == "phase6-validate":
            hash_path = tool_root / "phase6" / "corpus" / "manifest.sha256"
            locked_hash = hash_path.read_text(encoding="utf-8").strip()
            if manifest_sha256(phase6_manifest) != locked_hash:
                raise SystemExit("committed Phase 6 manifest hash lock is stale")
            independence = check_holdout_independence(phase6_manifest, load_exposed_holdout_texts(tool_root))
            print(json.dumps({
                "valid": True,
                "deterministic": True,
                "corpus_version": phase6_manifest["corpus_version"],
                "seed": phase6_manifest["seed"],
                "sha256": manifest_sha256(phase6_manifest),
                "grammar_cases": len(phase6_manifest["grammar_cases"]),
                "duplicate_candidates": len(phase6_manifest["duplicate_candidates"]),
                "duplicate_queries": len(phase6_manifest["duplicate_queries"]),
                "holdout_independence": independence,
            }, indent=2))
            return 0
        if args.command == "phase6-check-policy":
            policy_path = tool_root / "phase6" / "grammar" / "vocabulary-policy.json"
            policy = json.loads(policy_path.read_text(encoding="utf-8"))
            provenance = validate_vocabulary_policy(policy, phase6_manifest, repository_root)
            freeze = load_policy_freeze(tool_root)
            print(json.dumps({
                "valid": True,
                "vocabulary_provenance": provenance,
                "holdout_independence": check_holdout_independence(
                    phase6_manifest, load_exposed_holdout_texts(tool_root)
                ),
                "policy_freeze_commit_sha": (freeze or {}).get("policy_freeze_commit_sha"),
                "superseded_iterations": [
                    entry["corpus_version"] for entry in load_benchmark_history(tool_root)["superseded"]
                ],
            }, indent=2))
            return 0
        if args.command == "phase6-run":
            phase6_report = run_phase6_benchmark(
                phase6_manifest,
                tool_root=tool_root,
                measurement=args.measurement,
                languagetool_jar=args.languagetool_jar.resolve(),
            )
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(phase6_report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
            print(f"Phase 6 report: {args.output}")
            return 0
        policy_path = tool_root / "phase6" / "grammar" / "vocabulary-policy.json"
        if args.command == "phase6-export-evidence":
            source_report = json.loads(args.input_report.read_text(encoding="utf-8"))
            compact_report = compact_phase6_evidence(source_report)
            validate_phase6_evidence(
                compact_report, phase6_manifest, policy_path,
                tool_root=tool_root, repository_root=repository_root,
            )
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(compact_report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
            print(f"Compact Phase 6 evidence: {args.output}")
            return 0
        evidence = json.loads(args.evidence.read_text(encoding="utf-8"))
        validate_phase6_evidence(
            evidence, phase6_manifest, policy_path,
            tool_root=tool_root, repository_root=repository_root,
        )
        print(json.dumps({"valid": True, "evidence": str(args.evidence), "decisions": evidence["decisions"]}, indent=2))
        return 0

    manifest = load_manifest(args.manifest.resolve())
    if args.command == "validate":
        counts = {kind: len(cases_of_kind(manifest, kind)) for kind in ("document", "grammar", "duplicate")}
        splits: dict[str, int] = {}
        for case in manifest["cases"]:
            key = f"{case['kind']}/{case['split']}"
            splits[key] = splits.get(key, 0) + 1
        print(json.dumps({"valid": True, "corpus_version": manifest["corpus_version"],
                          "total_cases": len(manifest["cases"]), "counts": counts,
                          "splits": dict(sorted(splits.items()))}, indent=2))
        return 0
    if args.command == "export-evidence":
        source = json.loads(args.input_report.read_text(encoding="utf-8"))
        evidence = export_review_evidence(source, decisions=make_decisions(source.get("results", {})))
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(f"Sanitized evidence: {args.output}")
        return 0
    seed = manifest["seed"] if args.seed is None else args.seed
    output_dir = args.output_dir.resolve()
    if args.command == "generate":
        print(json.dumps(generate_corpus(manifest, output_dir, seed=seed), indent=2))
        return 0
    sections = DEFAULT_SECTIONS if args.sections == "all" else set(_csv(args.sections))
    engines = _csv(args.ocr_engines)
    allowed_engines = {"tesseract", "paddle-tiny", "paddle-small", "paddle-medium"}
    unknown_engines = set(engines) - allowed_engines
    if unknown_engines:
        raise SystemExit(f"unknown OCR engines: {', '.join(sorted(unknown_engines))}")
    report = run_benchmark(
        manifest,
        repository_root=repository_root,
        tool_root=tool_root,
        output_dir=output_dir,
        sections=sections,
        ocr_engines=engines,
        seed=seed,
        languagetool_url=args.languagetool_url,
        languagetool_pid=args.languagetool_pid,
        tesseract_psm=args.tesseract_psm,
        languagetool_language=args.languagetool_language,
    )
    report["exact_command"] = " ".join(shlex.quote(value) for value in ([sys.executable, "-m", "assistive_validation_benchmark"] + (argv if argv is not None else sys.argv[1:])))
    json_path = output_dir / "report.json"
    markdown_path = output_dir / "summary.md"
    json_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    markdown_path.write_text(render_markdown(report), encoding="utf-8")
    print(f"JSON report: {json_path}")
    print(f"Markdown summary: {markdown_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
