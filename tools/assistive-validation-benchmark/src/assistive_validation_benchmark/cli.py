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


def _paths() -> tuple[Path, Path, Path]:
    tool_root = Path(__file__).resolve().parents[2]
    repository_root = tool_root.parents[1]
    manifest = tool_root / "corpus" / "manifest.json"
    return tool_root, repository_root, manifest


def _parser() -> argparse.ArgumentParser:
    tool_root, _, manifest = _paths()
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
    return parser


def _csv(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    tool_root, repository_root, _ = _paths()
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
