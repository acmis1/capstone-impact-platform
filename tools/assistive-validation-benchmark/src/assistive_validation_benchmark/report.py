from __future__ import annotations

from typing import Any


def _percent(value: float | None) -> str:
    return "NOT EXECUTED" if value is None else f"{value:.1%}"


def _milliseconds(value: float | None) -> str:
    return "n/a" if value is None else f"{value:.1f} ms"


def _mib(value: int | None) -> str:
    return "n/a" if not value else f"{value / (1024 ** 2):.0f} MiB"


def render_markdown(report: dict[str, Any]) -> str:
    environment = report["environment"]
    corpus = report["corpus"]
    results = report["results"]
    context = report.get("command_context", {})
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
        f"{corpus['total_cases']} labelled cases: {corpus['document_cases']} document, {corpus['grammar_cases']} grammar, "
        f"and {corpus['duplicate_cases']} duplicate-query cases.",
        "All content is deterministic and synthetic. Generated assets and model caches are not tracked.",
        "",
    ]
    fonts = corpus.get("generation", {}).get("resolved_fonts")
    if fonts:
        lines.extend([f"Typefaces actually resolved on this machine: {', '.join(sorted(set(fonts.values())))}.", ""])

    native = results.get("native")
    if native:
        lines.extend([
            "## Native PDF extraction",
            "",
            f"- Born-digital title recovery (exact after normalization): {_percent(native['born_digital_title_recovery_rate'])}",
            f"- Same, metadata-blind first-line baseline: {_percent(native.get('born_digital_title_recovery_rate_blind'))}",
            f"- Successful born-digital cases: {native['born_digital_success_count']}/{native['born_digital_case_count']}",
            f"- Raster PDFs indicating OCR from exploratory quality signals: {_percent(native['raster_pdf_quality_gate_indication_rate'])}",
            f"- Runtime p50/p95: {_milliseconds(native['runtime']['p50_ms'])} / {_milliseconds(native['runtime']['p95_ms'])}",
            f"- Failures: {', '.join(native['failures']) if native['failures'] else 'none'}",
            "",
            "> Extraction-quality signals are observations only; no production threshold is established by this report.",
            f"> {native.get('memory_note', '')}",
            "",
        ])

    ocr = results.get("ocr", {}).get("engines", {})
    if ocr:
        lines.extend([
            "## OCR",
            "",
            "All engines consume the identical raster for a given case. Tesseract page segmentation mode: "
            f"`{context.get('tesseract_psm', 'n/a')}` (automatic layout analysis, comparable with PP-OCR detection).",
            "",
            "| Engine | Status | Exact title | Blind exact title | Assistive title | Mean CER | Mean WER | Clean WER | Challenging WER |",
            "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
        ])
        for name, evidence in ocr.items():
            lines.append(
                f"| {name} | {evidence['execution_status']} | {_percent(evidence['title_recovery_rate'])} | "
                f"{_percent(evidence.get('title_recovery_rate_blind'))} | "
                f"{_percent(evidence.get('assistive_title_agreement_rate'))} | {_percent(evidence['mean_cer'])} | "
                f"{_percent(evidence['mean_wer'])} | {_percent(evidence['clean_mean_wer'])} | "
                f"{_percent(evidence['challenging_mean_wer'])} |")
        lines.extend([
            "",
            "\"Exact title\" is equality after the documented title normalization. \"Assistive title\" additionally "
            "counts near matches that a human would still have to confirm, so it must never be read as extraction "
            "accuracy.",
            "",
            "### OCR cost",
            "",
            "| Engine | Cold start | Warm p50 | Warm p95 | Scored-case p50 | Scored-case p95 | Peak memory | Memory attribution |",
            "|---|---:|---:|---:|---:|---:|---:|---|",
        ])
        for name, evidence in ocr.items():
            warm = evidence.get("warm_runtime", {})
            scored = evidence.get("scored_warm_runtime", {})
            lines.append(
                f"| {name} | {_milliseconds(evidence.get('cold_start_ms'))} | {_milliseconds(warm.get('p50_ms'))} | "
                f"{_milliseconds(warm.get('p95_ms'))} | {_milliseconds(scored.get('p50_ms'))} | "
                f"{_milliseconds(scored.get('p95_ms'))} | {_mib(evidence.get('peak_memory_bytes'))} | "
                f"{evidence.get('memory_attribution', 'n/a')} |")
        lines.extend([
            "",
            "Cold start is the first invocation of a variant and includes model loading. Warm columns exclude it. "
            "The scored-case columns additionally exclude the empty and oversized-text controls, which are excluded "
            "from quality scoring as well; whole-run p95 is otherwise dominated by a case that no quality metric "
            "counts.",
            "",
        ])
        for name, evidence in ocr.items():
            if evidence.get("cold_start_included_weight_download"):
                lines.append(f"- `{name}` cold start also downloaded official model weights on this machine, so it is "
                             "not comparable with a cold start that only loaded a cached model.")
        lines.append("")
        for name, evidence in ocr.items():
            if evidence.get("execution_status") == "executed":
                lines.append(f"- `{name}` memory: {evidence.get('memory_note', '')}")
                slow = evidence.get("slowest_cases") or []
                if slow:
                    detail = ", ".join(f"{item['case_id']} {item['runtime_ms']:.0f} ms"
                                       f"{'' if item['scored'] else ' (unscored control)'}" for item in slow)
                    lines.append(f"- `{name}` slowest cases: {detail}")
        lines.extend(["", "| Engine | Worst three cases by WER |", "|---|---|"])
        for name, evidence in ocr.items():
            worst = evidence.get("worst_wer_cases") or []
            if worst:
                detail = ", ".join(f"{item['case_id']} ({item['layout']}) {item['wer']:.0%}"
                                   f"{', title still recovered' if item['title_recovered_exact'] else ''}"
                                   for item in worst)
                lines.append(f"| {name} | {detail} |")
        lines.extend([
            "",
            "Whole-text WER is unbounded above: multi-column reading order and noise-driven insertions can push a "
            "case past 100% while its title is recovered exactly. Read WER as a page-linearisation signal, not as a "
            "recognition score, and use the title metrics for the decision that actually matters here.",
            "",
        ])

    title = results.get("title")
    if title:
        label = title["manifest_label_track"]
        lines.extend([
            "## Deterministic title consistency",
            "",
            f"Calibration-selected fuzzy threshold: `{title['selected_threshold']}`.",
            "",
            f"> {title['calibration_degeneracy_note']}",
            "",
            "| Track | Split | Equality-path P / R | Assistive-path P / R | Review rate |",
            "|---|---|---:|---:|---:|",
        ])
        for split in ("calibration", "holdout"):
            entry = label[split]
            lines.append(
                f"| manifest labels | {split} | {_percent(entry['confident_match']['precision'])} / "
                f"{_percent(entry['confident_match']['recall'])} | {_percent(entry['assistive_match']['precision'])} / "
                f"{_percent(entry['assistive_match']['recall'])} | {_percent(entry['review_rate'])} |")
        for source, track in sorted(title.get("extracted_candidate_tracks", {}).items()):
            entry = track["all"]
            lines.append(
                f"| {source} | all | {_percent(entry['confident_match']['precision'])} / "
                f"{_percent(entry['confident_match']['recall'])} | {_percent(entry['assistive_match']['precision'])} / "
                f"{_percent(entry['assistive_match']['recall'])} | {_percent(entry['review_rate'])} |")
        lines.extend([
            "",
            "The manifest-label track compares the metadata title with the poster title declared in the corpus. It "
            "isolates the matcher and exercises no extraction, so it is an upper bound. The remaining tracks feed the "
            "matcher the title candidate an extractor actually produced.",
            "",
            title["extracted_candidate_note"],
            "",
        ])
        band = title.get("non_equality_score_range")
        if band:
            lines.extend([
                f"Non-equality cases score between {band['min']:.3f} and {band['max']:.3f}. Read that range against the "
                "selected threshold before treating the fuzzy path as calibrated.",
                "",
            ])

    grammar_section = results.get("grammar", {})
    grammar = grammar_section.get("engines", {})
    if grammar:
        lines.extend([
            "## Grammar and spelling",
            "",
            f"Language: `{grammar_section.get('language', 'n/a')}`. {grammar_section.get('language_note', '')}",
            "",
            "| Engine | Version | Status | Precision | Recall | False positives | of which vocabulary | Clean cases fully silent | Runtime |",
            "|---|---|---:|---:|---:|---:|---:|---:|---:|",
        ])
        for name, evidence in grammar.items():
            silent = (f"{evidence.get('clean_cases_fully_silent')}/{evidence.get('clean_case_count')}"
                      if evidence.get("clean_case_count") is not None else "n/a")
            lines.append(
                f"| {name} | {evidence.get('version', 'n/a')} | {evidence['status']} | "
                f"{_percent(evidence.get('precision'))} | {_percent(evidence.get('recall'))} | "
                f"{evidence.get('false_positives', 'n/a')} | {evidence.get('vocabulary_false_positives', 'n/a')} | "
                f"{silent} | {_milliseconds(evidence.get('runtime_ms'))} |")
        lines.extend(["", "| Engine | Non-vocabulary false positives | Projected precision with a domain dictionary |",
                      "|---|---:|---:|"])
        for name, evidence in grammar.items():
            if evidence.get("status") == "ok":
                lines.append(f"| {name} | {evidence.get('non_vocabulary_false_positives')} | "
                             f"{_percent(evidence.get('projected_precision_with_domain_dictionary'))} |")
        lines.append("")
        lines.append("The projected column is arithmetic on the measured findings, not a measured result. No custom "
                     "dictionary was built or tuned; it exists only to show how much of the precision gap is "
                     "vocabulary coverage rather than rule quality.")
        lines.extend(["", "| Engine | Split | Precision | Recall | False positives |", "|---|---|---:|---:|---:|"])
        for name, evidence in grammar.items():
            for split, entry in (evidence.get("by_split") or {}).items():
                lines.append(f"| {name} | {split} | {_percent(entry.get('precision'))} | "
                             f"{_percent(entry.get('recall'))} | {entry.get('false_positives')} |")
        for evidence in grammar.values():
            if evidence.get("note"):
                lines.extend(["", f"> {evidence['note']}"])
                break
        lines.append("")

    duplicate = results.get("duplicates")
    if duplicate:
        lines.extend([
            "## Lexical duplicate baseline",
            "",
            f"Shared candidate pool: {duplicate['candidate_pool_size']} candidates ranked for every query.",
            "",
            "| Split | Exact detection | Recall@1 | Recall@3 | Recall@5 | Queries missed at 5 |",
            "|---|---:|---:|---:|---:|---:|",
        ])
        for split in ("calibration", "holdout"):
            entry = duplicate["by_split"].get(split) or {}
            if entry:
                lines.append(
                    f"| {split} | {_percent(entry.get('exact_duplicate_detection'))} | "
                    f"{_percent(entry.get('recall_at_1'))} | {_percent(entry.get('recall_at_3'))} | "
                    f"{_percent(entry.get('recall_at_5'))} | {entry.get('queries_missed_at_5')} |")
        lines.append(
            f"| all | {_percent(duplicate.get('exact_duplicate_detection'))} | {_percent(duplicate.get('recall_at_1'))} | "
            f"{_percent(duplicate.get('recall_at_3'))} | {_percent(duplicate.get('recall_at_5'))} | "
            f"{duplicate.get('queries_missed_at_5')} |")
        lines.extend([
            "",
            f"Calibration-selected candidate threshold {duplicate['candidate_threshold']}: irrelevant candidate rate "
            f"{_percent(duplicate['irrelevant_candidate_rate'])} ({duplicate['false_candidate_count']} of "
            f"{duplicate['flagged_candidate_count']} flagged). {duplicate['threshold_selection']}",
            "",
            f"> {duplicate['note']}",
            "",
        ])

    lines.extend(["## Decisions", "", "| Candidate | Classification | Evidence |", "|---|---|---|"])
    for candidate, decision in report["decisions"].items():
        lines.append(f"| {candidate.replace('_', ' ')} | **{decision['classification']}** | {decision['reason']} |")
    lines.extend([
        "", "## Limitations", "",
        "- Results are machine-, version-, model-, and corpus-specific; materially changed versions require rerunning the benchmark.",
        "- Unavailable tools are classified as insufficient evidence, never rejected for installation convenience.",
        "- In-process peak memory is cumulative for the whole benchmark process. Attribute it to one engine only when that engine was the sole engine of the run.",
        "- This benchmark is assistive research only. Deterministic production validation and staff authority remain unchanged.",
        "- No cloud AI/OCR, hosted Supabase, publication endpoint, Duda operation, embedding model, LLM, or VLM is used.",
        "",
    ])
    return "\n".join(lines)
