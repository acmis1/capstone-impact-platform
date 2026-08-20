from __future__ import annotations

from typing import Any


def _percent(value: float | None) -> str:
    return "NOT EXECUTED" if value is None else f"{value:.1%}"


def _milliseconds(value: float | None) -> str:
    return "n/a" if value is None else f"{value:.1f} ms"


def _mib(value: int | None) -> str:
    return "n/a" if not value else f"{value / (1024 ** 2):.0f} MiB"


def _pick(value: dict[str, Any], keys: tuple[str, ...]) -> dict[str, Any]:
    return {key: value[key] for key in keys if key in value}


def export_review_evidence(report: dict[str, Any], *, decisions: dict[str, Any] | None = None) -> dict[str, Any]:
    """Return a deterministic, compact, path-free audit export of a benchmark report.

    The runnable report keeps full OCR and grammar output for local diagnosis. The checked-in
    evidence keeps the aggregate and per-case values needed to audit those aggregates without
    retaining local output paths or redundant synthetic OCR transcripts.
    """
    results = report.get("results", {})
    source_environment = report.get("environment", {})
    context = report.get("command_context", {})
    evidence: dict[str, Any] = {
        "evidence_schema_version": 1,
        "source": {
            "kind": "sanitized_machine_report",
            "report_schema_version": report.get("report_schema_version"),
            "measurement_benchmark_commit_sha": source_environment.get("benchmark_commit_sha"),
        },
        "environment": _pick(source_environment, (
            "architecture", "benchmark_commit_sha", "benchmark_seed", "corpus_version", "cpu", "gpu",
            "gpu_used", "logical_cpu_count", "node_version", "os", "python_version", "total_ram_bytes",
        )),
        "command_context": {
            **_pick(context, ("languagetool_language", "ocr_engines", "sections", "seed", "tesseract_psm")),
            "output_dir": "<local output directory omitted>",
        },
        "corpus": _pick(report.get("corpus", {}), ("total_cases", "document_cases", "grammar_cases", "duplicate_cases")),
        "results": {},
        "decisions": decisions if decisions is not None else report.get("decisions", {}),
    }
    generation = report.get("corpus", {}).get("generation", {})
    if generation.get("resolved_fonts"):
        evidence["corpus"]["resolved_fonts"] = generation["resolved_fonts"]

    native = results.get("native")
    if native:
        native_evidence = _pick(native, (
            "born_digital_case_count", "born_digital_success_count", "born_digital_title_recovery_rate",
            "born_digital_title_recovery_rate_blind", "raster_pdf_quality_gate_indication_rate",
            "raster_pdf_native_character_counts", "runtime", "failures", "title_recovery_definition", "note",
        ))
        native_evidence["records"] = []
        for record in native.get("records", []):
            observation = record.get("observation", {})
            native_evidence["records"].append({
                **_pick(record, ("case_id", "document_type", "quality", "title_candidate", "title_candidate_blind",
                                 "title_recovered", "title_recovered_blind", "ocr_indicated_by_observation")),
                "observation": _pick(observation, (
                    "engine", "status", "version", "runtime_ms", "extracted_character_count",
                    "printable_character_ratio", "error",
                )),
            })
        evidence["results"]["native"] = native_evidence

    ocr = results.get("ocr", {}).get("engines", {})
    if ocr:
        ocr_evidence: dict[str, Any] = {"engines": {}}
        for name, engine in ocr.items():
            entry = _pick(engine, (
                "engine", "execution_status", "case_count", "scored_success_count", "mean_cer", "mean_wer",
                "clean_case_count", "clean_mean_wer", "challenging_case_count", "challenging_mean_wer",
                "title_recovery_rate", "title_recovery_rate_blind", "assistive_title_agreement_rate",
                "title_recovery_definition", "runtime_all_cases", "warm_runtime", "scored_warm_runtime",
                "cold_start_ms", "cold_start_included_weight_download", "peak_memory_bytes",
                "peak_memory_baseline_bytes", "peak_memory_delta_bytes", "memory_attribution", "memory_note",
                "versions", "models", "failures", "slowest_cases", "worst_wer_cases", "limitation",
            ))
            settings = dict(engine.get("settings") or {})
            if "executable" in settings:
                settings["executable"] = "<local executable omitted>"
            if settings:
                entry["settings"] = settings
            entry["records"] = []
            for record in engine.get("records", []):
                observation = record.get("observation", {})
                entry["records"].append({
                    **_pick(record, (
                        "case_id", "quality", "layout", "tags", "typeface", "scored", "title_candidate",
                        "title_candidate_blind", "title_recovered_exact", "title_recovered_exact_blind",
                        "title_assistive_match", "title_assistive_decision", "cer", "wer",
                    )),
                    "observation": _pick(observation, (
                        "engine", "status", "version", "framework_version", "model", "device", "backend",
                        "cold_start_included", "weights_cached_before_run", "runtime_ms", "peak_memory_bytes",
                        "mean_confidence", "geometry_count", "error",
                    )),
                })
            ocr_evidence["engines"][name] = entry
        evidence["results"]["ocr"] = ocr_evidence

    title = results.get("title")
    if title:
        title_evidence = _pick(title, (
            "selected_threshold", "selection_method", "calibration_is_degenerate", "calibration_degeneracy_note",
            "non_equality_score_range", "score_separation", "threshold_comparison_calibration",
            "manifest_label_track", "manifest_label_track_note", "extracted_candidate_note",
        ))
        title_evidence["records"] = [_pick(record, (
            "case_id", "split", "title_variant", "expected_match", "candidate_title", "decision", "classification",
            "confident_match", "assistive_match", "score",
        )) for record in title.get("records", [])]
        title_evidence["extracted_candidate_tracks"] = {}
        for name, track in title.get("extracted_candidate_tracks", {}).items():
            # OCR per-case candidates are already retained in the OCR section. Keeping this second copy for every
            # guided/blind track would inflate the checked-in evidence without adding audit information.
            title_evidence["extracted_candidate_tracks"][name] = _pick(track, ("case_count", "calibration", "holdout", "all"))
        evidence["results"]["title"] = title_evidence

    grammar = results.get("grammar")
    if grammar:
        grammar_evidence: dict[str, Any] = {"language": grammar.get("language"), "language_note": grammar.get("language_note"), "engines": {}}
        for name, engine in grammar.get("engines", {}).items():
            entry = _pick(engine, (
                "engine", "status", "version", "backend", "device", "runtime_ms", "peak_memory_bytes", "memory_note",
                "case_count", "true_findings", "false_positives", "missed_labelled_issues", "precision", "recall",
                "vocabulary_false_positives", "non_vocabulary_false_positives", "projected_precision_with_domain_dictionary",
                "clean_case_count", "clean_case_false_positives", "clean_cases_fully_silent", "by_split", "note",
            ))
            entry["records"] = [_pick(record, (
                "case_id", "split", "tags", "clean_case", "true_findings", "false_positives",
                "vocabulary_false_positives", "missed_issues",
            )) for record in engine.get("records", [])]
            grammar_evidence["engines"][name] = entry
        evidence["results"]["grammar"] = grammar_evidence

    duplicate = results.get("duplicates")
    if duplicate:
        duplicate_evidence = _pick(duplicate, (
            "candidate_pool_size", "candidate_threshold", "threshold_selection", "threshold_at_sweep_boundary",
            "threshold_sweep_calibration", "exact_duplicate_detection", "recall_at_1", "recall_at_3", "recall_at_5",
            "queries_missed_at_5", "false_candidate_count", "flagged_candidate_count", "irrelevant_candidate_rate",
            "threshold_precision", "threshold_recall", "by_split", "note",
        ))
        duplicate_evidence["rankings"] = []
        for ranking in duplicate.get("rankings", []):
            duplicate_evidence["rankings"].append({
                "case_id": ranking["case_id"], "split": ranking["split"],
                "ranking": [_pick(item, (
                    "id", "score", "exact_hash", "normalized_title_equal", "relevant", "relation",
                )) for item in ranking.get("ranking", [])],
            })
        evidence["results"]["duplicates"] = duplicate_evidence
    return evidence


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
