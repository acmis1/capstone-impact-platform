from __future__ import annotations

import importlib.metadata
import json
import os
import platform
import subprocess
import sys
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
from .engines import PADDLE_VARIANTS, harper_check, languagetool_check, paddle_ocr, pdfium_extract, render_pdf, tesseract_ocr
from .manifest import cases_of_kind

DEFAULT_SECTIONS = {"native", "ocr", "title", "grammar", "duplicates"}


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


def _command_version(command: list[str]) -> str | None:
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=15, shell=False, check=False)
        value = (result.stdout or result.stderr).strip().splitlines()
        return value[0] if value else None
    except (OSError, subprocess.SubprocessError):
        return None


def _body(case: dict[str, Any]) -> str:
    body = case["body"]
    if case.get("repeat_body", 1) > 1:
        body = " ".join(f"{body} segment {index}." for index in range(1, case["repeat_body"] + 1))
    return body


def _reference_text(case: dict[str, Any]) -> str:
    return "\n".join(part for part in (case["poster_title"], _body(case)) if part)


def _candidate_title(text: str, metadata_title: str) -> str:
    lines = [line.strip() for line in text.splitlines() if line.strip()][:5]
    if not lines:
        return ""
    candidates = [" ".join(lines[:length]) for length in range(1, min(3, len(lines)) + 1)]
    return max(candidates, key=lambda value: match_title(metadata_title, value, threshold=1.1).score)


def evaluate_native(cases: list[dict[str, Any]], corpus_dir: Path) -> dict[str, Any]:
    records = []
    for case in cases:
        if case["document_type"] not in {"born_digital_pdf", "scanned_pdf", "corrupt_pdf"}:
            continue
        observation = pdfium_extract(corpus_dir / case["asset"])
        text = observation.get("text", "")
        candidate = _candidate_title(text, case["metadata_title"])
        recovered = bool(case["poster_title"]) and normalize_title(candidate) == normalize_title(case["poster_title"])
        records.append({
            "case_id": case["id"], "document_type": case["document_type"], "quality": case["quality"],
            "title_candidate": candidate, "title_recovered": recovered,
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
        "raster_pdf_quality_gate_indication_rate": sum(record["ocr_indicated_by_observation"] for record in raster) / len(raster) if raster else None,
        "runtime": timing_summary([record["observation"]["runtime_ms"] for record in records if record["observation"].get("runtime_ms") is not None]),
        "failures": [record["case_id"] for record in records if record["observation"]["status"] == "failed"],
        "note": "Character-count and printable-ratio signals are observations only, not a production OCR gate.",
    }


def _ocr_path(case: dict[str, Any], corpus_dir: Path, render_dir: Path) -> tuple[Path | None, str | None]:
    source = corpus_dir / case["asset"]
    if case["document_type"] == "scanned_pdf":
        render_dir.mkdir(parents=True, exist_ok=True)
        try:
            return render_pdf(source, render_dir / f"{case['id']}.png"), None
        except Exception as error:
            return None, f"{type(error).__name__}: {error}"
    if case["document_type"] in {"png", "jpeg"}:
        return source, None
    return None, "not an OCR image case"


def _summarize_ocr_engine(engine: str, records: list[dict[str, Any]]) -> dict[str, Any]:
    successes = [record for record in records if record["observation"]["status"] == "ok" and record["scored"]]
    challenging_tags = {"multi_column", "rotated_text", "low_resolution", "coloured_background", "noisy_background",
                        "high_contrast", "small_body_text", "diagram", "table", "skewed_text"}
    clean = [record for record in successes if record["quality"] != "low" and not challenging_tags.intersection(record["tags"])]
    challenging = [record for record in successes if record not in clean]
    warm_runtime = [record["observation"]["runtime_ms"] for record in records
                    if record["observation"].get("runtime_ms") is not None and not record["observation"].get("cold_start_included", False)]
    statuses = {record["observation"]["status"] for record in records}
    if successes:
        availability = "executed"
    elif statuses == {"unavailable"} or ("unavailable" in statuses and "ok" not in statuses):
        availability = "not_executed"
    else:
        availability = "failed"
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
        "title_recovery_rate": sum(record["title_recovered"] for record in successes) / len(successes) if successes else None,
        "normalized_title_transcription_accuracy": sum(record["normalized_title_accurate"] for record in successes) / len(successes) if successes else None,
        "runtime": timing_summary([record["observation"]["runtime_ms"] for record in records if record["observation"].get("runtime_ms") is not None]),
        "warm_runtime": timing_summary(warm_runtime),
        "peak_memory_bytes": max((record["observation"].get("peak_memory_bytes") or 0 for record in records), default=0) or None,
        "versions": sorted({str(record["observation"].get("version")) for record in records if record["observation"].get("version")}),
        "models": [record["observation"].get("model") for record in records if record["observation"].get("model")][0:1],
        "failures": [{"case_id": record["case_id"], "status": record["observation"]["status"], "error": record["observation"].get("error")}
                     for record in records if record["observation"]["status"] != "ok"],
        "records": records,
        "limitation": "Whole-text WER includes reading-order effects; title metrics are reported separately. Oversized and empty controls are processed but excluded from aggregate OCR quality scores.",
    }


def evaluate_ocr(cases: list[dict[str, Any]], corpus_dir: Path, output_dir: Path, engines: list[str]) -> dict[str, Any]:
    eligible = [case for case in cases if case["document_type"] in {"scanned_pdf", "png", "jpeg"}]
    render_dir = output_dir / "rendered"
    all_results: dict[str, Any] = {}
    for engine in engines:
        records = []
        for case in eligible:
            image_path, render_error = _ocr_path(case, corpus_dir, render_dir)
            if image_path is None:
                observation = {"engine": engine, "status": "failed", "error": render_error}
            elif engine == "tesseract":
                observation = tesseract_ocr(image_path)
            elif engine in PADDLE_VARIANTS:
                observation = paddle_ocr(image_path, engine)
            else:
                observation = {"engine": engine, "status": "failed", "error": "unsupported engine selection"}
            text = observation.get("text", "")
            candidate = _candidate_title(text, case["metadata_title"])
            title_match = match_title(case["poster_title"], candidate)
            scored = case["layout"] != "empty" and "oversized_text" not in case.get("tags", [])
            records.append({
                "case_id": case["id"], "quality": case["quality"], "layout": case["layout"], "tags": case.get("tags", []),
                "scored": scored, "title_candidate": candidate,
                "title_recovered": title_match.matched, "normalized_title_accurate": normalize_title(candidate) == normalize_title(case["poster_title"]),
                "cer": character_error_rate(_reference_text(case), text) if scored and observation["status"] == "ok" else None,
                "wer": word_error_rate(_reference_text(case), text) if scored and observation["status"] == "ok" else None,
                "observation": observation,
            })
        all_results[engine] = _summarize_ocr_engine(engine, records)
    return {"engines": all_results}


def evaluate_title(cases: list[dict[str, Any]]) -> dict[str, Any]:
    thresholds = [0.86, 0.88, 0.90, 0.92, 0.94]
    comparisons = []
    for threshold in thresholds:
        calibration = [case for case in cases if case["split"] == "calibration"]
        guesses = [match_title(case["metadata_title"], case["poster_title"], aliases=case.get("approved_aliases", []),
                               allow_subtitle=case.get("allow_subtitle", False), threshold=threshold).matched for case in calibration]
        comparisons.append({"threshold": threshold, **binary_metrics([case["expected_title_match"] for case in calibration], guesses)})
    selected = max(comparisons, key=lambda item: (item["f1"], item["precision"], item["threshold"]))["threshold"]
    records = []
    for case in cases:
        result = match_title(case["metadata_title"], case["poster_title"], aliases=case.get("approved_aliases", []),
                             allow_subtitle=case.get("allow_subtitle", False), threshold=selected)
        records.append({"case_id": case["id"], "split": case["split"], "expected_match": case["expected_title_match"],
                        "predicted_match": result.matched, "classification": result.classification, "score": result.score})
    holdout = [record for record in records if record["split"] == "holdout"]
    return {
        "selected_threshold": selected,
        "selection_method": "Maximum calibration F1, then precision, then stricter-threshold tie-break; holdout is evaluated once.",
        "threshold_comparison_calibration": comparisons,
        "holdout_metrics": binary_metrics([record["expected_match"] for record in holdout], [record["predicted_match"] for record in holdout]),
        "all_metrics": binary_metrics([record["expected_match"] for record in records], [record["predicted_match"] for record in records]),
        "records": records,
    }


def _expected_spans(case: dict[str, Any]) -> list[tuple[int, int]]:
    spans, cursor = [], 0
    for issue in case["expected_issues"]:
        start = case["text"].find(issue["text"], cursor)
        spans.append((start, start + len(issue["text"])))
        cursor = start + len(issue["text"])
    return spans


def _score_findings(cases: list[dict[str, Any]], case_findings: list[list[dict[str, Any]]]) -> dict[str, Any]:
    true_findings = false_findings = missed = 0
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
        tp = len(matched_expected)
        fp = len(findings) - len(matched_findings)
        fn = len(expected) - len(matched_expected)
        true_findings += tp
        false_findings += fp
        missed += fn
        records.append({"case_id": case["id"], "true_findings": tp, "false_positives": fp, "missed_issues": fn, "findings": findings})
    precision = true_findings / (true_findings + false_findings) if true_findings + false_findings else 0.0
    recall = true_findings / (true_findings + missed) if true_findings + missed else 0.0
    return {"true_findings": true_findings, "false_positives": false_findings, "missed_labelled_issues": missed,
            "precision": precision, "recall": recall, "records": records}


def evaluate_grammar(cases: list[dict[str, Any]], tool_root: Path, languagetool_url: str, languagetool_pid: int | None) -> dict[str, Any]:
    texts = [case["text"] for case in cases]
    results = {}
    for observation in (harper_check(texts, tool_root), languagetool_check(texts, languagetool_url, process_id=languagetool_pid)):
        engine = observation["engine"]
        entry = {key: value for key, value in observation.items() if key != "case_findings"}
        if observation["status"] == "ok":
            entry.update(_score_findings(cases, observation["case_findings"]))
        results[engine] = entry
    return {"engines": results}


def _decision(classification: str, reason: str) -> dict[str, str]:
    return {"classification": classification, "reason": reason}


def make_decisions(results: dict[str, Any]) -> dict[str, Any]:
    decisions: dict[str, Any] = {}
    native = results.get("native")
    if native and native["born_digital_success_count"]:
        rate = native["born_digital_title_recovery_rate"] or 0
        decisions["native_pdfium_extraction"] = _decision("SELECT" if rate >= 0.99 else "DEFER", f"Measured born-digital title recovery {rate:.1%}.")
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
        decisions[key] = _decision("SELECT" if recovery >= 0.95 and wer <= 0.12 else "DEFER",
                                   f"Measured title recovery {recovery:.1%}, mean WER {wer:.1%}; compare machine-specific runtime and memory before selection.")

    grammar = results.get("grammar", {}).get("engines", {})
    executed_grammar = {key: value for key, value in grammar.items() if value.get("status") == "ok"}
    for engine in ("harper", "languagetool"):
        evidence = grammar.get(engine)
        if not evidence or evidence.get("status") != "ok":
            decisions[engine] = _decision("INSUFFICIENT_EVIDENCE", "Local candidate was not successfully executed.")
        else:
            stronger = max(executed_grammar, key=lambda name: (executed_grammar[name].get("precision", 0), executed_grammar[name].get("recall", 0))) if executed_grammar else None
            classification = "SELECT" if stronger == engine and evidence.get("precision", 0) >= 0.90 else "DEFER"
            decisions[engine] = _decision(classification, f"Measured precision {evidence.get('precision', 0):.1%} and recall {evidence.get('recall', 0):.1%} on the shared technical-English cases.")

    title = results.get("title")
    if title:
        metrics = title["holdout_metrics"]
        classification = "SELECT" if metrics["precision"] >= 0.98 and metrics["recall"] >= 0.95 else "DEFER"
        decisions["deterministic_title_matching"] = _decision(classification, f"Holdout precision {metrics['precision']:.1%}, recall {metrics['recall']:.1%}.")
    else:
        decisions["deterministic_title_matching"] = _decision("INSUFFICIENT_EVIDENCE", "Title benchmark was not run.")

    duplicate = results.get("duplicates")
    if duplicate:
        recall5 = duplicate["recall_at_5"] or 0
        decisions["lexical_duplicate_detection"] = _decision("SELECT" if recall5 >= 0.95 else "DEFER", f"Measured Recall@5 {recall5:.1%} with irrelevant candidate rate {duplicate['irrelevant_candidate_rate']:.1%}.")
        decisions["embeddings_for_phase_6"] = _decision("DEFER" if recall5 >= 0.95 else "INSUFFICIENT_EVIDENCE",
                                                        "Embeddings remain out of scope; lexical evidence does not justify implementation yet." if recall5 >= 0.95 else "Lexical misses justify a later, separately controlled embedding benchmark, not implementation in Phase 0.")
    else:
        decisions["lexical_duplicate_detection"] = _decision("INSUFFICIENT_EVIDENCE", "Duplicate benchmark was not run.")
        decisions["embeddings_for_phase_6"] = _decision("INSUFFICIENT_EVIDENCE", "No lexical baseline result is available.")
    decisions["local_llm_or_vlm"] = _decision("DEFER", "Phase 0 demonstrates no task that requires generative authority; deterministic and specialist baselines must be resolved first.")
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
    if "native" in sections:
        results["native"] = evaluate_native(documents, corpus_dir)
    if "ocr" in sections:
        results["ocr"] = evaluate_ocr(documents, corpus_dir, output_dir, ocr_engines)
    if "title" in sections:
        results["title"] = evaluate_title(documents)
    if "grammar" in sections:
        results["grammar"] = evaluate_grammar(cases_of_kind(manifest, "grammar"), tool_root, languagetool_url, languagetool_pid)
    if "duplicates" in sections:
        results["duplicates"] = duplicate_metrics(cases_of_kind(manifest, "duplicate"))
    completed = datetime.now(timezone.utc)
    report = {
        "report_schema_version": 1,
        "benchmark_version": importlib.metadata.version("pp1-assistive-validation-benchmark"),
        "started_at": started.isoformat(),
        "completed_at": completed.isoformat(),
        "duration_seconds": (completed - started).total_seconds(),
        "command_context": {"sections": sorted(sections), "ocr_engines": ocr_engines, "output_dir": str(output_dir), "seed": seed},
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
