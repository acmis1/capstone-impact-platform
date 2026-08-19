from __future__ import annotations

from typing import Any


def _percent(value: float | None) -> str:
    return "NOT EXECUTED" if value is None else f"{value:.1%}"


def _milliseconds(value: float | None) -> str:
    return "n/a" if value is None else f"{value:.1f} ms"


def render_markdown(report: dict[str, Any]) -> str:
    environment = report["environment"]
    corpus = report["corpus"]
    results = report["results"]
    lines = [
        "# PP1 Assistive Validation Phase 0 Benchmark",
        "",
        f"Run: `{report['started_at']}` to `{report['completed_at']}`  ",
        f"Commit: `{environment['benchmark_commit_sha']}`  ",
        f"Seed: `{environment['benchmark_seed']}`  ",
        f"Corpus: `{environment['corpus_version']}`",
        "",
        "## Environment",
        "",
        f"- OS: {environment['os']} ({environment['architecture']})",
        f"- CPU: {environment['cpu']} ({environment['logical_cpu_count']} logical processors)",
        f"- RAM: {environment['total_ram_bytes']} bytes",
        f"- Python: {environment['python_version']}; Node: {environment['node_version'] or 'not available'}",
        "- GPU used: no; this report is a CPU-mode measurement",
        "",
        "## Corpus",
        "",
        f"{corpus['total_cases']} labelled cases: {corpus['document_cases']} document, {corpus['grammar_cases']} grammar, and {corpus['duplicate_cases']} duplicate-query cases.",
        "All content is deterministic and synthetic. Generated assets and model caches are not tracked.",
        "",
    ]
    native = results.get("native")
    if native:
        lines.extend([
            "## Native PDF extraction",
            "",
            f"- Born-digital title recovery: {_percent(native['born_digital_title_recovery_rate'])}",
            f"- Successful born-digital cases: {native['born_digital_success_count']}/{native['born_digital_case_count']}",
            f"- Raster PDFs indicating OCR from exploratory quality signals: {_percent(native['raster_pdf_quality_gate_indication_rate'])}",
            f"- Runtime p50/p95: {_milliseconds(native['runtime']['p50_ms'])} / {_milliseconds(native['runtime']['p95_ms'])}",
            f"- Failures: {', '.join(native['failures']) if native['failures'] else 'none'}",
            "",
            "> Extraction-quality signals are observations only; no production threshold is established by this report.",
            "",
        ])
    ocr = results.get("ocr", {}).get("engines", {})
    if ocr:
        lines.extend(["## OCR", "", "| Engine | Status | Title recovery | Exact normalized title | Mean CER | Mean WER | Clean WER | Challenging WER | Warm p50 | Peak memory |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|"])
        for name, evidence in ocr.items():
            lines.append(f"| {name} | {evidence['execution_status']} | {_percent(evidence['title_recovery_rate'])} | {_percent(evidence['normalized_title_transcription_accuracy'])} | {_percent(evidence['mean_cer'])} | {_percent(evidence['mean_wer'])} | {_percent(evidence['clean_mean_wer'])} | {_percent(evidence['challenging_mean_wer'])} | {_milliseconds(evidence['warm_runtime']['p50_ms'])} | {evidence['peak_memory_bytes'] or 'n/a'} |")
        lines.extend(["", "Whole-text WER is sensitive to multi-column reading order; title metrics remain separately visible.", ""])
    title = results.get("title")
    if title:
        metrics = title["holdout_metrics"]
        lines.extend(["## Deterministic title consistency", "",
                      f"Calibration-selected threshold: `{title['selected_threshold']}`. Holdout precision: {_percent(metrics['precision'])}; recall: {_percent(metrics['recall'])}; F1: {_percent(metrics['f1'])}.",
                      "The calibration/holdout split prevents reporting a threshold tuned and scored on exactly the same cases.", ""])
    grammar = results.get("grammar", {}).get("engines", {})
    if grammar:
        lines.extend(["## Grammar and spelling", "", "| Engine | Status | Precision | Recall | False positives | Runtime |", "|---|---:|---:|---:|---:|---:|"])
        for name, evidence in grammar.items():
            lines.append(f"| {name} | {evidence['status']} | {_percent(evidence.get('precision'))} | {_percent(evidence.get('recall'))} | {evidence.get('false_positives', 'n/a')} | {_milliseconds(evidence.get('runtime_ms'))} |")
        lines.append("")
    duplicate = results.get("duplicates")
    if duplicate:
        lines.extend(["## Lexical duplicate baseline", "",
                      f"Shared candidate pool: {duplicate['candidate_pool_size']}. Exact detection: {_percent(duplicate['exact_duplicate_detection'])}; Recall@1: {_percent(duplicate['recall_at_1'])}; Recall@3: {_percent(duplicate['recall_at_3'])}; Recall@5: {_percent(duplicate['recall_at_5'])}.",
                      f"Irrelevant candidate rate at score >= {duplicate['candidate_threshold']}: {_percent(duplicate['irrelevant_candidate_rate'])} ({duplicate['false_candidate_count']} candidates).", ""])
    lines.extend(["## Decisions", "", "| Candidate | Classification | Evidence |", "|---|---|---|"])
    for candidate, decision in report["decisions"].items():
        lines.append(f"| {candidate.replace('_', ' ')} | **{decision['classification']}** | {decision['reason']} |")
    lines.extend(["", "## Limitations", "",
                  "- Results are machine-, version-, model-, and corpus-specific; materially changed versions require rerunning the benchmark.",
                  "- Unavailable tools are classified as insufficient evidence, never rejected for installation convenience.",
                  "- This benchmark is assistive research only. Deterministic production validation and staff authority remain unchanged.",
                  "- No cloud AI/OCR, hosted Supabase, publication endpoint, Duda operation, embedding model, LLM, or VLM is used.", ""])
    return "\n".join(lines)
