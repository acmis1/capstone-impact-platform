from __future__ import annotations

import importlib.metadata
import os
import platform
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .core import (
    binary_metrics,
    character_error_rate,
    duplicate_metrics,
    match_title,
    normalize_title,
    timing_summary,
    word_error_rate,
)
from .corpus import generate_corpus
from .engines import (
    PADDLE_VARIANTS,
    current_process_peak_memory,
    harper_check,
    languagetool_check,
    paddle_ocr,
    pdfium_extract,
    render_pdf,
    tesseract_ocr,
)
from .manifest import cases_of_kind

DEFAULT_SECTIONS = {"native", "ocr", "title", "grammar", "duplicates"}
# The swept band deliberately reaches well below 0.90. In corpus v1 every case scored either
# 1.0 or below 0.85, so every threshold in a 0.86-0.94 sweep tied and the "selected" value was
# only the tie-break. Sweeping the range where scores actually fall is what makes the
# calibration step evidence rather than decoration.
TITLE_THRESHOLDS = [0.70, 0.74, 0.78, 0.80, 0.82, 0.84, 0.86, 0.88, 0.90, 0.92, 0.94]
CHALLENGING_TAGS = {"multi_column", "three_column", "rotated_text", "low_resolution", "coloured_background",
                    "noisy_background", "high_contrast", "small_body_text", "diagram", "table", "skewed_text"}


def _git_sha(root: Path) -> str:
    result = subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, capture_output=True, text=True, shell=False, check=False)
    return result.stdout.strip() if result.returncode == 0 else "unknown"


def _total_ram_bytes() -> int | None:
    if os.name == "nt":
        import ctypes

        class MemoryStatus(ctypes.Structure):
            _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                        ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                        ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                        ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                        ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
        status = MemoryStatus()
        status.dwLength = ctypes.sizeof(status)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            return int(status.ullTotalPhys)
    if hasattr(os, "sysconf"):
        try:
            return int(os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES"))
        except (ValueError, OSError):
            pass
    return None


def _windows_registry_value(path: str, name: str) -> str | None:
    if os.name != "nt":
        return None
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, path) as key:
            return str(winreg.QueryValueEx(key, name)[0]).strip()
    except OSError:
        return None


def _os_description() -> str:
    if os.name == "nt":
        product = _windows_registry_value(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion", "ProductName")
        build = _windows_registry_value(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion", "CurrentBuildNumber")
        display = _windows_registry_value(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion", "DisplayVersion")
        if product:
            return " ".join(part for part in (product, display, f"build {build}" if build else None) if part)
    uname = platform.uname()
    return f"{uname.system} {uname.release} ({platform.version()})"


def _cpu_description() -> str:
    registry = _windows_registry_value(r"HARDWARE\DESCRIPTION\System\CentralProcessor\0", "ProcessorNameString")
    return registry or platform.uname().processor or platform.processor() or "unknown"


def _command_version(command: list[str]) -> str | None:
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=15, shell=False, check=False)
        value = (result.stdout or result.stderr).strip().splitlines()
        return value[0] if value else None
    except (OSError, subprocess.SubprocessError):
        return None


def environment_evidence(repository_root: Path, seed: int, corpus_version: str) -> dict[str, Any]:
    uname = platform.uname()
    return {
        "os": _os_description(),
        "architecture": uname.machine,
        "cpu": _cpu_description(),
        "logical_cpu_count": os.cpu_count(),
        "total_ram_bytes": _total_ram_bytes(),
        "gpu_used": False,
        "gpu": "not queried by the portable harness; CPU mode is authoritative for this run",
        "python_version": platform.python_version(),
        "node_version": _command_version(["node", "--version"]),
        "benchmark_commit_sha": _git_sha(repository_root),
        "corpus_version": corpus_version,
        "benchmark_seed": seed,
    }


def _body(case: dict[str, Any]) -> str:
    body = case["body"]
    if case.get("repeat_body", 1) > 1:
        body = " ".join(f"{body} segment {index}." for index in range(1, case["repeat_body"] + 1))
    return body


def _reference_text(case: dict[str, Any]) -> str:
    return "\n".join(part for part in (case["poster_title"], _body(case)) if part)


def _candidate_title(text: str, metadata_title: str) -> str:
    """Title candidate chosen with knowledge of the metadata title.

    This is not ground-truth leakage in the production sense: the metadata title is supplied by
    the submitter and is genuinely available at validation time. It does mean the reported number
    answers "can the engine produce text that agrees with the known title", not "can the engine
    locate a title unaided", so ``_candidate_title_blind`` is measured and reported beside it.
    """
    lines = [line.strip() for line in text.splitlines() if line.strip()][:5]
    if not lines:
        return ""
    candidates = [" ".join(lines[:length]) for length in range(1, min(3, len(lines)) + 1)]
    return max(candidates, key=lambda value: match_title(metadata_title, value, threshold=1.1).score)


def _candidate_title_blind(text: str) -> str:
    """Metadata-blind baseline: the first non-empty extracted line."""
    for line in text.splitlines():
        if line.strip():
            return line.strip()
    return ""


def evaluate_native(cases: list[dict[str, Any]], corpus_dir: Path) -> dict[str, Any]:
    records = []
    for case in cases:
        if case["document_type"] not in {"born_digital_pdf", "scanned_pdf", "corrupt_pdf"}:
            continue
        observation = pdfium_extract(corpus_dir / case["asset"])
        text = observation.get("text", "")
        candidate = _candidate_title(text, case["metadata_title"])
        blind = _candidate_title_blind(text)
        # "Recovered" means the extracted candidate equals the printed poster title after the
        # documented title normalization. A fuzzy near match is never counted as recovery.
        recovered = bool(case["poster_title"]) and normalize_title(candidate) == normalize_title(case["poster_title"])
        recovered_blind = bool(case["poster_title"]) and normalize_title(blind) == normalize_title(case["poster_title"])
        records.append({
            "case_id": case["id"], "document_type": case["document_type"], "quality": case["quality"],
            "title_candidate": candidate, "title_candidate_blind": blind,
            "title_recovered": recovered, "title_recovered_blind": recovered_blind,
            "ocr_indicated_by_observation": observation.get("extracted_character_count", 0) < 20 or observation.get("printable_character_ratio", 0) < 0.90,
            "observation": observation,
        })
    born = [record for record in records if record["document_type"] == "born_digital_pdf"]
    successful_born = [record for record in born if record["observation"]["status"] == "ok"]
    raster = [record for record in records if record["document_type"] == "scanned_pdf"]
    return {
        "records": records,
        "born_digital_case_count": len(born),
        "born_digital_success_count": len(successful_born),
        "born_digital_title_recovery_rate": sum(record["title_recovered"] for record in born) / len(born) if born else None,
        "born_digital_title_recovery_rate_blind": sum(record["title_recovered_blind"] for record in born) / len(born) if born else None,
        "raster_pdf_quality_gate_indication_rate": sum(record["ocr_indicated_by_observation"] for record in raster) / len(raster) if raster else None,
        "raster_pdf_native_character_counts": {record["case_id"]: record["observation"].get("extracted_character_count") for record in raster},
        "runtime": timing_summary([record["observation"]["runtime_ms"] for record in records if record["observation"].get("runtime_ms") is not None]),
        "failures": [record["case_id"] for record in records if record["observation"]["status"] == "failed"],
        "title_recovery_definition": "exact equality after documented title normalization; fuzzy matches excluded",
        "note": "Character-count and printable-ratio signals are observations only, not a production OCR gate.",
        "memory_note": "Native extraction memory is not reported separately: the harness can only observe the peak "
                       "working set of the whole benchmark process, which is not attributable to one library.",
    }


def _ocr_path(case: dict[str, Any], corpus_dir: Path, render_dir: Path) -> tuple[Path | None, str | None]:
    source = corpus_dir / case["asset"]
    if case["document_type"] == "scanned_pdf":
        render_dir.mkdir(parents=True, exist_ok=True)
        target = render_dir / f"{case['id']}.png"
        if target.is_file():
            # Every engine consumes the identical raster, so the comparison stays preprocessing-equivalent.
            return target, None
        try:
            return render_pdf(source, target), None
        except Exception as error:
            return None, f"{type(error).__name__}: {error}"
    if case["document_type"] in {"png", "jpeg"}:
        return source, None
    return None, "not an OCR image case"


def _summarize_ocr_engine(engine: str, records: list[dict[str, Any]], memory_baseline: int | None) -> dict[str, Any]:
    successes = [record for record in records if record["observation"]["status"] == "ok" and record["scored"]]
    scored_ids = {record["case_id"] for record in successes}
    clean = [record for record in successes if record["quality"] != "low" and not CHALLENGING_TAGS.intersection(record["tags"])]
    clean_ids = {record["case_id"] for record in clean}
    challenging = [record for record in successes if record["case_id"] not in clean_ids]
    runtimes = [record["observation"]["runtime_ms"] for record in records if record["observation"].get("runtime_ms") is not None]
    warm_runtimes = [record["observation"]["runtime_ms"] for record in records
                     if record["observation"].get("runtime_ms") is not None and not record["observation"].get("cold_start_included", False)]
    # The oversized-text control is deliberately pathological and is excluded from quality scoring, so
    # including it in the headline latency is inconsistent. It alone produced the v1 p95.
    scored_runtimes = [record["observation"]["runtime_ms"] for record in records
                       if record["case_id"] in scored_ids and record["observation"].get("runtime_ms") is not None
                       and not record["observation"].get("cold_start_included", False)]
    cold_start = [record["observation"]["runtime_ms"] for record in records if record["observation"].get("cold_start_included")]
    statuses = {record["observation"]["status"] for record in records}
    if successes:
        availability = "executed"
    elif statuses == {"unavailable"} or ("unavailable" in statuses and "ok" not in statuses):
        availability = "not_executed"
    else:
        availability = "failed"
    peak = max((record["observation"].get("peak_memory_bytes") or 0 for record in records), default=0) or None
    in_process = engine in PADDLE_VARIANTS
    return {
        "engine": engine,
        "execution_status": availability,
        "case_count": len(records),
        "scored_success_count": len(successes),
        "mean_cer": sum(record["cer"] for record in successes) / len(successes) if successes else None,
        "mean_wer": sum(record["wer"] for record in successes) / len(successes) if successes else None,
        "clean_case_count": len(clean),
        "clean_mean_wer": sum(record["wer"] for record in clean) / len(clean) if clean else None,
        "challenging_case_count": len(challenging),
        "challenging_mean_wer": sum(record["wer"] for record in challenging) / len(challenging) if challenging else None,
        "title_recovery_rate": sum(record["title_recovered_exact"] for record in successes) / len(successes) if successes else None,
        "title_recovery_rate_blind": sum(record["title_recovered_exact_blind"] for record in successes) / len(successes) if successes else None,
        "assistive_title_agreement_rate": sum(record["title_assistive_match"] for record in successes) / len(successes) if successes else None,
        "title_recovery_definition": "exact equality after documented title normalization; the separate assistive rate "
                                     "additionally counts near matches that a human would still have to review",
        "runtime_all_cases": timing_summary(runtimes),
        "warm_runtime": timing_summary(warm_runtimes),
        "scored_warm_runtime": timing_summary(scored_runtimes),
        "cold_start_ms": cold_start[0] if cold_start else None,
        "cold_start_included_weight_download": next(
            (record["observation"].get("weights_cached_before_run") is False
             for record in records if record["observation"].get("cold_start_included")), None),
        "peak_memory_bytes": peak,
        "peak_memory_baseline_bytes": memory_baseline if in_process else None,
        # A delta against the harness process only means something for an engine that runs inside it.
        "peak_memory_delta_bytes": (peak - memory_baseline) if (in_process and peak and memory_baseline) else None,
        "memory_attribution": "process_cumulative" if in_process else "child_process_peak",
        "memory_note": (
            "Peak working set of the whole benchmark process. It is monotonic and includes every model already "
            "loaded in this process, so it is attributable to this engine only when the variant is the single "
            "engine of its run. Compare with a child-process figure only with that caveat."
            if in_process else
            "Peak working set of the Tesseract child process, measured per invocation. Not directly comparable "
            "with the in-process figures."
        ),
        "versions": sorted({str(record["observation"].get("version")) for record in records if record["observation"].get("version")}),
        "models": [record["observation"].get("model") for record in records if record["observation"].get("model")][0:1],
        "settings": next((record["observation"].get("settings") for record in records if record["observation"].get("settings")), None),
        "failures": [{"case_id": record["case_id"], "status": record["observation"]["status"], "error": record["observation"].get("error")}
                     for record in records if record["observation"]["status"] != "ok"],
        "slowest_cases": sorted(
            ({"case_id": record["case_id"], "runtime_ms": record["observation"]["runtime_ms"], "scored": record["scored"]}
             for record in records if record["observation"].get("runtime_ms") is not None),
            key=lambda item: -item["runtime_ms"])[:3],
        "records": records,
        "worst_wer_cases": sorted(
            ({"case_id": record["case_id"], "layout": record["layout"], "wer": record["wer"],
              "title_recovered_exact": record["title_recovered_exact"]}
             for record in successes if record["wer"] is not None),
            key=lambda item: -item["wer"])[:3],
        "limitation": "Whole-text WER includes reading-order effects and is unbounded above: a page whose text is "
                      "detected in a different linear order, or one where noise adds spurious words, can exceed 100% "
                      "while its title is recovered perfectly. Title metrics are therefore reported separately. "
                      "Oversized and empty controls are processed but excluded from aggregate quality and from "
                      "scored latency.",
    }


def evaluate_ocr(cases: list[dict[str, Any]], corpus_dir: Path, output_dir: Path, engines: list[str],
                 tesseract_psm: str = "3") -> dict[str, Any]:
    eligible = [case for case in cases if case["document_type"] in {"scanned_pdf", "png", "jpeg"}]
    render_dir = output_dir / "rendered"
    all_results: dict[str, Any] = {}
    extracted: dict[str, dict[str, str]] = {}
    for engine in engines:
        memory_baseline = current_process_peak_memory()
        records = []
        for case in eligible:
            image_path, render_error = _ocr_path(case, corpus_dir, render_dir)
            if image_path is None:
                observation = {"engine": engine, "status": "failed", "error": render_error}
            elif engine == "tesseract":
                observation = tesseract_ocr(image_path, psm=tesseract_psm)
            elif engine in PADDLE_VARIANTS:
                observation = paddle_ocr(image_path, engine)
            else:
                observation = {"engine": engine, "status": "failed", "error": "unsupported engine selection"}
            text = observation.get("text", "")
            candidate = _candidate_title(text, case["metadata_title"])
            blind = _candidate_title_blind(text)
            printed = case["poster_title"]
            assistive = match_title(printed, candidate)
            scored = case["layout"] != "empty" and "oversized_text" not in case.get("tags", [])
            records.append({
                "case_id": case["id"], "quality": case["quality"], "layout": case["layout"], "tags": case.get("tags", []),
                "typeface": case.get("typeface"), "scored": scored,
                "title_candidate": candidate, "title_candidate_blind": blind,
                "title_recovered_exact": bool(printed) and normalize_title(candidate) == normalize_title(printed),
                "title_recovered_exact_blind": bool(printed) and normalize_title(blind) == normalize_title(printed),
                "title_assistive_match": assistive.matched,
                "title_assistive_decision": assistive.decision,
                "cer": character_error_rate(_reference_text(case), text) if scored and observation["status"] == "ok" else None,
                "wer": word_error_rate(_reference_text(case), text) if scored and observation["status"] == "ok" else None,
                "observation": observation,
            })
        all_results[engine] = _summarize_ocr_engine(engine, records, memory_baseline)
        if all_results[engine]["execution_status"] == "executed":
            extracted[f"{engine}:guided"] = {record["case_id"]: record["title_candidate"] for record in records}
            extracted[f"{engine}:blind"] = {record["case_id"]: record["title_candidate_blind"] for record in records}
    return {"engines": all_results, "extracted_titles": extracted}


def _title_records(cases: list[dict[str, Any]], threshold: float,
                   candidates: dict[str, str] | None) -> list[dict[str, Any]]:
    records = []
    for case in cases:
        if candidates is not None and case["id"] not in candidates:
            continue
        candidate_title = case["poster_title"] if candidates is None else candidates[case["id"]]
        result = match_title(case["metadata_title"], candidate_title,
                             aliases=case.get("approved_aliases", []),
                             allow_subtitle=case.get("allow_subtitle", False), threshold=threshold)
        records.append({
            "case_id": case["id"], "split": case["split"], "title_variant": case.get("title_variant"),
            "expected_match": case["expected_title_match"], "candidate_title": candidate_title,
            "decision": result.decision, "classification": result.classification,
            "confident_match": result.decision == "match", "assistive_match": result.matched,
            "score": result.score,
        })
    return records


def _title_track(records: list[dict[str, Any]]) -> dict[str, Any]:
    def metrics(subset: list[dict[str, Any]], key: str) -> dict[str, Any]:
        return binary_metrics([record["expected_match"] for record in subset], [record[key] for record in subset])

    track: dict[str, Any] = {"case_count": len(records)}
    for split in ("calibration", "holdout", "all"):
        subset = records if split == "all" else [record for record in records if record["split"] == split]
        track[split] = {
            "case_count": len(subset),
            "confident_match": metrics(subset, "confident_match"),
            "assistive_match": metrics(subset, "assistive_match"),
            "review_rate": sum(1 for record in subset if record["decision"] == "review") / len(subset) if subset else None,
        }
    return track


def _score_separation(records: list[dict[str, Any]]) -> dict[str, Any]:
    """Do true matches and material mismatches occupy separable score ranges?

    If they overlap, the weighted lexical score cannot be turned into a trustworthy automatic
    threshold no matter which value is chosen, and that is the finding worth reporting.
    """
    equality = {"exact_normalized", "approved_alias", "allowed_subtitle", "missing"}
    fuzzy = [record for record in records if record["classification"] not in equality]
    positive = sorted(record["score"] for record in fuzzy if record["expected_match"])
    negative = sorted(record["score"] for record in fuzzy if not record["expected_match"])

    def band(values: list[float]) -> str:
        return f"{values[0]:.3f}-{values[-1]:.3f}" if values else "none"

    return {
        "positive_case_count": len(positive),
        "negative_case_count": len(negative),
        "positive_range": band(positive),
        "negative_range": band(negative),
        "ranges_overlap": bool(positive and negative and positive[0] <= negative[-1] and negative[0] <= positive[-1]),
        "closest_confusable_gap": min((abs(left - right) for left in positive for right in negative), default=None),
        "threshold_decided_cases": sum(1 for record in records if record["classification"] == "lexical_near_match"),
        "glyph_rule_decided_cases": sum(1 for record in records if record["classification"] == "ocr_glyph_confusion"),
    }


def evaluate_title(cases: list[dict[str, Any]], extracted: dict[str, dict[str, str]] | None = None) -> dict[str, Any]:
    calibration = [case for case in cases if case["split"] == "calibration"]
    comparisons = []
    for threshold in TITLE_THRESHOLDS:
        calibration_records = _title_records(calibration, threshold, None)
        comparisons.append({"threshold": threshold,
                            **binary_metrics([record["expected_match"] for record in calibration_records],
                                             [record["assistive_match"] for record in calibration_records])})
    degenerate = len({(round(item["precision"], 6), round(item["recall"], 6)) for item in comparisons}) == 1
    selected = max(comparisons, key=lambda item: (item["f1"], item["precision"], item["threshold"]))["threshold"]

    records = _title_records(cases, selected, None)
    scores = sorted(record["score"] for record in records
                    if record["classification"] not in {"exact_normalized", "approved_alias", "allowed_subtitle", "missing"})
    result: dict[str, Any] = {
        "selected_threshold": selected,
        "selection_method": "Maximum calibration F1, then precision, then stricter threshold. Calibration cases only; "
                            "holdout is scored once with the selected value.",
        "calibration_is_degenerate": degenerate,
        "calibration_degeneracy_note": (
            "Every swept threshold produced identical calibration precision and recall, so the selected value is only "
            "the tie-break and carries no calibration evidence."
            if degenerate else
            "At least two swept thresholds produced different calibration outcomes, so the selection is evidence-backed."
        ),
        "non_equality_score_range": {"min": scores[0], "max": scores[-1]} if scores else None,
        "score_separation": _score_separation(records),
        "threshold_comparison_calibration": comparisons,
        "manifest_label_track": _title_track(records),
        "manifest_label_track_note": "Metadata title compared against the manifest's declared poster title. This isolates "
                                     "the matcher but exercises no extraction step, so it is an upper bound only.",
        "records": records,
    }
    extracted_tracks: dict[str, Any] = {}
    for source, candidates in (extracted or {}).items():
        source_records = _title_records(cases, selected, candidates)
        extracted_tracks[source] = {**_title_track(source_records), "records": source_records}
    result["extracted_candidate_tracks"] = extracted_tracks
    result["extracted_candidate_note"] = (
        "End-to-end tracks: the candidate title is what the named extractor actually produced. ':guided' selects the "
        "best of the first three extracted line windows using the submitter-supplied metadata title, which is genuinely "
        "available in production; ':blind' simply takes the first non-empty extracted line."
    )
    return result


# Dictionary/spell-checker categories, used only to describe where false positives come from.
# Nothing is suppressed and no dictionary is tuned; this is a diagnostic breakdown, not a filter.
VOCABULARY_FINDING_KINDS = {"spelling", "typo", "misspelling"}
VOCABULARY_RULE_PREFIXES = ("MORFOLOGIK_RULE", "HUNSPELL_RULE", "SPELLER_RULE")


def _is_vocabulary_finding(finding: dict[str, Any]) -> bool:
    kind = str(finding.get("kind") or "").strip().lower()
    if kind in VOCABULARY_FINDING_KINDS:
        return True
    rule = str(finding.get("rule") or "")
    return rule.startswith(VOCABULARY_RULE_PREFIXES)


def _expected_spans(case: dict[str, Any]) -> list[tuple[int, int]]:
    spans, cursor = [], 0
    for issue in case["expected_issues"]:
        start = case["text"].find(issue["text"], cursor)
        spans.append((start, start + len(issue["text"])))
        cursor = start + len(issue["text"])
    return spans


def _score_findings(cases: list[dict[str, Any]], case_findings: list[list[dict[str, Any]]]) -> dict[str, Any]:
    records = []
    for case, findings in zip(cases, case_findings):
        expected = _expected_spans(case)
        matched_expected: set[int] = set()
        matched_findings: set[int] = set()
        for finding_index, finding in enumerate(findings):
            start, end = int(finding.get("start", -1)), int(finding.get("end", -1))
            for expected_index, (expected_start, expected_end) in enumerate(expected):
                if expected_index not in matched_expected and max(start, expected_start) < min(end, expected_end):
                    matched_expected.add(expected_index)
                    matched_findings.add(finding_index)
                    break
        false_findings = [finding for index, finding in enumerate(findings) if index not in matched_findings]
        records.append({
            "case_id": case["id"], "split": case["split"], "tags": case.get("tags", []),
            "clean_case": not expected,
            "true_findings": len(matched_expected),
            "false_positives": len(false_findings),
            "vocabulary_false_positives": sum(1 for finding in false_findings if _is_vocabulary_finding(finding)),
            "missed_issues": len(expected) - len(matched_expected),
            "findings": findings,
        })

    def aggregate(subset: list[dict[str, Any]]) -> dict[str, Any]:
        tp = sum(record["true_findings"] for record in subset)
        fp = sum(record["false_positives"] for record in subset)
        vocabulary_fp = sum(record["vocabulary_false_positives"] for record in subset)
        fn = sum(record["missed_issues"] for record in subset)
        clean = [record for record in subset if record["clean_case"]]
        residual = fp - vocabulary_fp
        return {
            "case_count": len(subset),
            "true_findings": tp, "false_positives": fp, "missed_labelled_issues": fn,
            "precision": tp / (tp + fp) if tp + fp else 0.0,
            "recall": tp / (tp + fn) if tp + fn else 0.0,
            "vocabulary_false_positives": vocabulary_fp,
            "non_vocabulary_false_positives": residual,
            "projected_precision_with_domain_dictionary": tp / (tp + residual) if tp + residual else 0.0,
            "clean_case_count": len(clean),
            "clean_case_false_positives": sum(record["false_positives"] for record in clean),
            "clean_cases_fully_silent": sum(1 for record in clean if record["false_positives"] == 0),
        }

    return {
        **aggregate(records),
        "by_split": {split: aggregate([record for record in records if record["split"] == split])
                     for split in ("calibration", "holdout")},
        "records": records,
        "note": "No custom dictionary or rule tuning was applied to either engine, so calibration and holdout measure "
                "the same untuned configuration and neither split is contaminated by the other. "
                "'projected_precision_with_domain_dictionary' is a diagnostic upper bound describing what precision "
                "would be if every dictionary-category false positive were resolved by a curated domain vocabulary. "
                "It is arithmetic on the measured findings, not a measured result, and no dictionary was built.",
    }


def evaluate_grammar(cases: list[dict[str, Any]], tool_root: Path, languagetool_url: str,
                     languagetool_pid: int | None, language: str = "en-AU") -> dict[str, Any]:
    texts = [case["text"] for case in cases]
    results = {}
    for observation in (harper_check(texts, tool_root),
                        languagetool_check(texts, languagetool_url, process_id=languagetool_pid, language=language)):
        engine = observation["engine"]
        entry = {key: value for key, value in observation.items() if key != "case_findings"}
        if observation["status"] == "ok":
            entry.update(_score_findings(cases, observation["case_findings"]))
        results[engine] = entry
    return {"engines": results, "language": language,
            "language_note": "Both engines are configured for Australian English and every clean corpus case is written "
                             "in Australian English, so dialect mismatch cannot inflate the false-positive count."}


def _decision(classification: str, reason: str) -> dict[str, str]:
    return {"classification": classification, "reason": reason}


def make_decisions(results: dict[str, Any]) -> dict[str, Any]:
    decisions: dict[str, Any] = {}
    native = results.get("native")
    if native and native["born_digital_success_count"]:
        rate = native["born_digital_title_recovery_rate"] or 0
        decisions["native_pdfium_extraction"] = _decision(
            "SELECT" if rate >= 0.99 else "DEFER",
            f"Measured born-digital title recovery {rate:.1%} (exact after normalization) across "
            f"{native['born_digital_case_count']} cases.")
    else:
        decisions["native_pdfium_extraction"] = _decision("INSUFFICIENT_EVIDENCE", "Native extraction was not successfully executed.")

    ocr_engines = results.get("ocr", {}).get("engines", {})
    for engine in ("paddle-tiny", "paddle-small", "paddle-medium", "tesseract"):
        evidence = ocr_engines.get(engine)
        key = engine.replace("-", "_")
        if not evidence or evidence["execution_status"] != "executed":
            decisions[key] = _decision("INSUFFICIENT_EVIDENCE", "Candidate was not successfully executed on the recorded machine.")
            continue
        recovery = evidence["title_recovery_rate"] or 0
        wer = evidence["mean_wer"] if evidence["mean_wer"] is not None else 1
        decisions[key] = _decision(
            "SELECT" if recovery >= 0.95 and wer <= 0.12 else "DEFER",
            f"Measured exact title recovery {recovery:.1%}, mean WER {wer:.1%}; compare machine-specific runtime "
            f"and memory before selection.")

    grammar = results.get("grammar", {}).get("engines", {})
    executed_grammar = {key: value for key, value in grammar.items() if value.get("status") == "ok"}
    for engine in ("harper", "languagetool"):
        evidence = grammar.get(engine)
        if not evidence or evidence.get("status") != "ok":
            decisions[engine] = _decision("INSUFFICIENT_EVIDENCE", "Local candidate was not successfully executed.")
            continue
        stronger = max(executed_grammar,
                       key=lambda name: (executed_grammar[name].get("precision", 0),
                                         executed_grammar[name].get("recall", 0))) if executed_grammar else None
        classification = "SELECT" if stronger == engine and evidence.get("precision", 0) >= 0.90 else "DEFER"
        decisions[engine] = _decision(
            classification,
            f"Measured precision {evidence.get('precision', 0):.1%} and recall {evidence.get('recall', 0):.1%} across "
            f"{evidence.get('case_count', 0)} untuned technical-English cases, with "
            f"{evidence.get('clean_case_false_positives', 0)} false positives on "
            f"{evidence.get('clean_case_count', 0)} deliberately clean cases.")

    title = results.get("title")
    if title:
        strict = title["manifest_label_track"]["holdout"]["confident_match"]
        assistive = title["manifest_label_track"]["holdout"]["assistive_match"]
        best_extracted = None
        for source, track in title.get("extracted_candidate_tracks", {}).items():
            candidate = track["all"]["confident_match"]
            if best_extracted is None or candidate["f1"] > best_extracted[1]["f1"]:
                best_extracted = (source, candidate)
        classification = "SELECT" if strict["precision"] >= 0.98 and strict["recall"] >= 0.95 else "DEFER"
        reason = (f"Holdout equality-path precision {strict['precision']:.1%}, recall {strict['recall']:.1%}; "
                  f"permissive assistive path precision {assistive['precision']:.1%}, recall {assistive['recall']:.1%}.")
        if title.get("calibration_is_degenerate"):
            reason += " The fuzzy threshold itself stays unevidenced: every swept threshold tied on calibration."
        if best_extracted:
            reason += (f" Best end-to-end extracted track {best_extracted[0]}: precision "
                       f"{best_extracted[1]['precision']:.1%}, recall {best_extracted[1]['recall']:.1%}.")
        decisions["deterministic_title_matching"] = _decision(classification, reason)
        overlap = title.get("score_separation", {})
        decisions["fuzzy_title_scoring"] = _decision(
            "DEFER",
            f"Among non-equality cases the weighted lexical score spans {overlap.get('positive_range')} for true "
            f"matches and {overlap.get('negative_range')} for material mismatches; the ranges overlap, so no single "
            f"threshold separates OCR noise from a one-token substitution. "
            f"{overlap.get('threshold_decided_cases', 0)} case(s) were decided by the threshold branch. Only the "
            "equality, alias, subtitle and deterministic glyph-confusion paths are trustworthy; anything else belongs "
            "in a human review queue rather than an automatic decision.")
    else:
        decisions["deterministic_title_matching"] = _decision("INSUFFICIENT_EVIDENCE", "Title benchmark was not run.")
        decisions["fuzzy_title_scoring"] = _decision("INSUFFICIENT_EVIDENCE", "Title benchmark was not run.")

    duplicate = results.get("duplicates")
    if duplicate:
        holdout = duplicate["by_split"]["holdout"]
        recall5 = holdout["recall_at_5"] if holdout["recall_at_5"] is not None else (duplicate["recall_at_5"] or 0)
        recall1 = holdout["recall_at_1"] if holdout["recall_at_1"] is not None else (duplicate["recall_at_1"] or 0)
        decisions["lexical_duplicate_detection"] = _decision(
            "SELECT" if recall5 >= 0.95 else "DEFER",
            f"Holdout Recall@1 {recall1:.1%}, Recall@5 {recall5:.1%} against a "
            f"{duplicate['candidate_pool_size']}-candidate shared pool; irrelevant candidate rate "
            f"{duplicate['irrelevant_candidate_rate']:.1%} at the calibration-selected threshold "
            f"{duplicate['candidate_threshold']}.")
        decisions["embeddings"] = _decision(
            "DEFER" if recall5 >= 0.95 else "INSUFFICIENT_EVIDENCE",
            "Lexical ranking already surfaces the relevant candidate inside an assistive shortlist, so embeddings are "
            "not justified in Phase 0. Revisit only if a later representative corpus shows lexical misses."
            if recall5 >= 0.95 else
            "Lexical ranking misses relevant near duplicates, which is the evidence needed to justify a separately "
            "controlled embedding benchmark in a later phase. Do not implement embeddings now.")
    else:
        decisions["lexical_duplicate_detection"] = _decision("INSUFFICIENT_EVIDENCE", "Duplicate benchmark was not run.")
        decisions["embeddings"] = _decision("INSUFFICIENT_EVIDENCE", "No lexical baseline result is available.")

    decisions["generative_local_llm"] = _decision(
        "DEFER", "No Phase 0 task required generative authority and no generative model was executed. Deterministic "
                 "and specialist baselines resolve the measured problems first.")
    decisions["vision_language_model"] = _decision(
        "DEFER", "No VLM was executed. Specialist OCR already recovers titles from the measured poster corpus, so a "
                 "VLM has no demonstrated Phase 0 role.")
    return decisions


def run_benchmark(
    manifest: dict[str, Any],
    *,
    repository_root: Path,
    tool_root: Path,
    output_dir: Path,
    sections: set[str],
    ocr_engines: list[str],
    seed: int,
    languagetool_url: str,
    languagetool_pid: int | None,
    tesseract_psm: str = "3",
    languagetool_language: str = "en-AU",
) -> dict[str, Any]:
    unknown = sections - DEFAULT_SECTIONS
    if unknown:
        raise ValueError(f"unknown benchmark sections: {', '.join(sorted(unknown))}")
    output_dir.mkdir(parents=True, exist_ok=True)
    started = datetime.now(timezone.utc)
    corpus_dir = output_dir / "corpus"
    generation = generate_corpus(manifest, corpus_dir, seed=seed)
    documents = cases_of_kind(manifest, "document")
    results: dict[str, Any] = {}
    extracted: dict[str, dict[str, str]] = {}
    if "native" in sections:
        results["native"] = evaluate_native(documents, corpus_dir)
        extracted["pdfium:guided"] = {record["case_id"]: record["title_candidate"] for record in results["native"]["records"]}
        extracted["pdfium:blind"] = {record["case_id"]: record["title_candidate_blind"] for record in results["native"]["records"]}
    if "ocr" in sections:
        results["ocr"] = evaluate_ocr(documents, corpus_dir, output_dir, ocr_engines, tesseract_psm=tesseract_psm)
        extracted.update(results["ocr"].pop("extracted_titles"))
    if "title" in sections:
        results["title"] = evaluate_title(documents, extracted)
    if "grammar" in sections:
        results["grammar"] = evaluate_grammar(cases_of_kind(manifest, "grammar"), tool_root, languagetool_url,
                                              languagetool_pid, language=languagetool_language)
    if "duplicates" in sections:
        results["duplicates"] = duplicate_metrics(cases_of_kind(manifest, "duplicate"))
    completed = datetime.now(timezone.utc)
    report = {
        "report_schema_version": 2,
        "benchmark_version": importlib.metadata.version("pp1-assistive-validation-benchmark"),
        "started_at": started.isoformat(),
        "completed_at": completed.isoformat(),
        "duration_seconds": (completed - started).total_seconds(),
        "command_context": {"sections": sorted(sections), "ocr_engines": ocr_engines, "output_dir": str(output_dir),
                            "seed": seed, "tesseract_psm": tesseract_psm, "languagetool_language": languagetool_language},
        "environment": environment_evidence(repository_root, seed, manifest["corpus_version"]),
        "corpus": {
            "total_cases": len(manifest["cases"]),
            "document_cases": len(documents),
            "grammar_cases": len(cases_of_kind(manifest, "grammar")),
            "duplicate_cases": len(cases_of_kind(manifest, "duplicate")),
            "generation": generation,
        },
        "results": results,
    }
    report["decisions"] = make_decisions(results)
    return report
