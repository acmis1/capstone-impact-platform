from __future__ import annotations

import json
import re
import shutil
import socket
import statistics
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from ..engines import _process_memory_bytes, run_command_measured

_MASK_PATTERNS = [
    re.compile(r"```.*?```", re.DOTALL),
    re.compile(r"`[^`\r\n]+`"),
    re.compile(r"https?://[^\s]+"),
    re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),
    re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\b"),
    re.compile(r"\b[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+\b"),
]


def prepare_grammar_text(text: str) -> tuple[str, list[tuple[int, int]]]:
    """Mask non-prose spans with spaces while preserving every source offset."""
    masked = list(text)
    spans: list[tuple[int, int]] = []
    for pattern in _MASK_PATTERNS:
        for match in pattern.finditer(text):
            if any(start < match.end() and match.start() < end for start, end in spans):
                continue
            spans.append((match.start(), match.end()))
            for index in range(match.start(), match.end()):
                if masked[index] not in "\r\n":
                    masked[index] = " "
    return "".join(masked), sorted(spans)


def _percentile(values: list[float], percentile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = (len(ordered) - 1) * percentile
    lower = int(index)
    upper = min(lower + 1, len(ordered) - 1)
    fraction = index - lower
    return ordered[lower] * (1 - fraction) + ordered[upper] * fraction


def _is_spelling(finding: dict[str, Any]) -> bool:
    evidence = " ".join(str(finding.get(key, "")) for key in ("kind", "rule", "category")).casefold()
    return (
        any(marker in evidence for marker in ("spell", "morfologik", "dictionary", "numbers_in_words"))
        or str(finding.get("category", "")).upper() == "TYPOS"
    )


def _exclude_non_prose_findings(
    case: dict[str, Any], findings: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], int]:
    _, excluded_spans = prepare_grammar_text(case["source_text"])
    retained = [
        finding for finding in findings
        if not any(start < finding["end"] and finding["start"] < end for start, end in excluded_spans)
    ]
    return retained, len(findings) - len(retained)


def apply_vocabulary_policy(
    case: dict[str, Any], findings: list[dict[str, Any]], approved_terms: set[str]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    retained: list[dict[str, Any]] = []
    filtered: list[dict[str, Any]] = []
    text = case["source_text"]
    for finding in findings:
        start, end = finding["start"], finding["end"]
        token = text[start:end]
        title_non_spelling = case["field"] == "title" and not _is_spelling(finding)
        exact_approved_spelling = _is_spelling(finding) and token in approved_terms
        if title_non_spelling or exact_approved_spelling:
            filtered.append({**finding, "policy_reason": "title_spelling_only" if title_non_spelling else "approved_exact_term"})
        else:
            retained.append(finding)
    return retained, filtered


def _normalise_correction(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip().casefold()


def _finding_matches_issue(finding: dict[str, Any], issue: dict[str, Any]) -> bool:
    start, end = int(finding["start"]), int(finding["end"])
    issue_start, issue_end = issue["start"], issue["end"]
    if start == end:
        span_matches = issue_start - 1 <= start <= issue_end + 1
    else:
        overlap = max(0, min(end, issue_end) - max(start, issue_start))
        span_matches = overlap / max(1, min(end - start, issue_end - issue_start)) >= 0.5
    if not span_matches:
        return False
    replacements = {_normalise_correction(value) for value in finding.get("replacements", []) if value is not None}
    accepted = {_normalise_correction(value) for value in issue["accepted_corrections"]}
    return not replacements or bool(replacements & accepted)


def _score(cases: list[dict[str, Any]], findings_by_case: list[list[dict[str, Any]]]) -> dict[str, Any]:
    records: list[dict[str, Any]] = []
    tp = fp = fn = vocabulary_fp = 0
    for case, findings in zip(cases, findings_by_case, strict=True):
        unmatched = set(range(len(case["issues"])))
        matched_indices: set[int] = set()
        matched_findings = 0
        redundant_findings = 0
        case_fp = 0
        case_vocabulary_fp = 0
        false_positive_findings: list[dict[str, Any]] = []
        for finding in findings:
            matched_index = next((index for index in sorted(unmatched)
                                  if _finding_matches_issue(finding, case["issues"][index])), None)
            if matched_index is None:
                if any(_finding_matches_issue(finding, case["issues"][index]) for index in matched_indices):
                    redundant_findings += 1
                else:
                    case_fp += 1
                    false_positive_findings.append(finding)
                    token = case["source_text"][finding["start"]:finding["end"]]
                    if _is_spelling(finding) and token in case["legitimate_technical_terms"]:
                        case_vocabulary_fp += 1
            else:
                unmatched.remove(matched_index)
                matched_indices.add(matched_index)
                matched_findings += 1
        tp += matched_findings
        fp += case_fp
        fn += len(unmatched)
        vocabulary_fp += case_vocabulary_fp
        records.append({
            "case_id": case["id"],
            "split": case["split"],
            "intentionally_clean": case["intentionally_clean"],
            "true_positives": matched_findings,
            "false_positives": case_fp,
            "missed_issues": len(unmatched),
            "vocabulary_false_positives": case_vocabulary_fp,
            "false_positive_findings": false_positive_findings,
            "missed_issue_categories": [case["issues"][index]["category"] for index in sorted(unmatched)],
            "redundant_findings": redundant_findings,
        })
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    clean = [record for record in records if record["intentionally_clean"]]
    return {
        "issue_count": tp + fn,
        "true_positives": tp,
        "false_positives": fp,
        "missed_issues": fn,
        "precision": precision,
        "recall": recall,
        "f1": 2 * precision * recall / (precision + recall) if precision + recall else 0.0,
        "false_positive_rate": fp / (tp + fp) if tp + fp else 0.0,
        "vocabulary_false_positives": vocabulary_fp,
        "non_vocabulary_false_positives": fp - vocabulary_fp,
        "clean_case_count": len(clean),
        "clean_cases_fully_silent": sum(record["false_positives"] == 0 for record in clean),
        "clean_case_silence_rate": sum(record["false_positives"] == 0 for record in clean) / len(clean) if clean else 0.0,
        "records": records,
    }


def score_grammar_engine(
    cases: list[dict[str, Any]], raw_findings: list[list[dict[str, Any]]], approved_terms: set[str]
) -> dict[str, Any]:
    policy_findings: list[list[dict[str, Any]]] = []
    filtered_records: list[dict[str, Any]] = []
    for case, findings in zip(cases, raw_findings, strict=True):
        retained, filtered = apply_vocabulary_policy(case, findings, approved_terms)
        policy_findings.append(retained)
        filtered_records.append({"case_id": case["id"], "filtered_count": len(filtered), "filtered": filtered})
    return {
        "raw": _score(cases, raw_findings),
        "vocabulary_policy": _score(cases, policy_findings),
        "policy_filter_records": filtered_records,
    }


def run_harper(cases: list[dict[str, Any]], tool_root: Path) -> dict[str, Any]:
    node = shutil.which("node")
    package = tool_root / "node_modules" / "harper.js" / "package.json"
    runner = tool_root / "phase6" / "harper_runner.mjs"
    if not node or not package.is_file():
        return {"engine": "harper", "status": "unavailable", "error": "Pinned local Harper dependency is unavailable"}
    texts = [prepare_grammar_text(case["source_text"])[0] for case in cases]
    with tempfile.TemporaryDirectory(prefix="pp1-phase6-harper-") as temp_dir:
        input_path = Path(temp_dir) / "input.json"
        input_path.write_text(json.dumps({"texts": texts}), encoding="utf-8")
        result = run_command_measured([node, str(runner), str(input_path)], timeout=180)
    version = json.loads(package.read_text(encoding="utf-8"))["version"]
    if result["returncode"] != 0:
        return {"engine": "harper", "status": "failed", "version": version, "error": result["stderr"][:4096]}
    payload = json.loads(result["stdout"])
    runtimes = [entry["runtime_ms"] for entry in payload["cases"]]
    case_findings: list[list[dict[str, Any]]] = []
    excluded_count = 0
    for case, entry in zip(cases, payload["cases"], strict=True):
        retained, excluded = _exclude_non_prose_findings(case, entry["findings"])
        case_findings.append(retained)
        excluded_count += excluded
    return {
        "engine": "harper",
        "status": "ok",
        "version": version,
        "dependency_source": "npm package harper.js pinned by package-lock.json",
        "license": "Apache-2.0",
        "backend": "harper.js WASM/local",
        "configuration": {"dialect": "Australian", "language": "plaintext"},
        "cold_start_ms": payload["setup_ms"],
        "process_runtime_ms": result["runtime_ms"],
        "latency_p50_ms": statistics.median(runtimes),
        "latency_p95_ms": _percentile(runtimes, 0.95),
        "peak_memory_bytes": result["peak_memory_bytes"],
        "excluded_non_prose_finding_count": excluded_count,
        "case_findings": case_findings,
    }


def _languagetool_endpoint(base_url: str) -> str:
    parsed = urllib.parse.urlparse(base_url)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("LanguageTool URL must be loopback HTTP")
    return base_url.rstrip("/") + "/v2/check"


def run_languagetool(cases: list[dict[str, Any]], base_url: str, process_id: int | None = None) -> dict[str, Any]:
    endpoint = _languagetool_endpoint(base_url)
    findings_by_case: list[list[dict[str, Any]]] = []
    runtimes: list[float] = []
    version = "unknown"
    peak = 0
    excluded_non_prose = 0
    try:
        for case in cases:
            text = prepare_grammar_text(case["source_text"])[0]
            payload = urllib.parse.urlencode({"language": "en-AU", "text": text}).encode("utf-8")
            request = urllib.request.Request(endpoint, data=payload, method="POST")
            started = time.perf_counter()
            with urllib.request.urlopen(request, timeout=30) as response:
                data = json.loads(response.read(1_000_001).decode("utf-8"))
            runtimes.append((time.perf_counter() - started) * 1000)
            version = data.get("software", {}).get("version", version)
            if process_id is not None:
                peak = max(peak, _process_memory_bytes(process_id) or 0)
            raw_findings = [{
                "start": int(match["offset"]),
                "end": int(match["offset"] + match["length"]),
                "message": match.get("message", ""),
                "rule": match.get("rule", {}).get("id", "unknown"),
                "category": match.get("rule", {}).get("category", {}).get("id", "unknown"),
                "replacements": [item.get("value", "") for item in match.get("replacements", [])[:20]],
            } for match in data.get("matches", [])]
            retained, excluded = _exclude_non_prose_findings(case, raw_findings)
            findings_by_case.append(retained)
            excluded_non_prose += excluded
    except Exception as error:
        return {"engine": "languagetool", "status": "failed", "error": f"{type(error).__name__}: {error}"}
    return {
        "engine": "languagetool",
        "status": "ok",
        "version": version,
        "dependency_source": "official numbered local LanguageTool distribution",
        "license": "LGPL-2.1-or-later; distribution third-party notices apply",
        "backend": "bounded local loopback Java server",
        "configuration": {"language": "en-AU", "max_text_length": 25000, "max_check_time_ms": 10000},
        "latency_p50_ms": statistics.median(runtimes),
        "latency_p95_ms": _percentile(runtimes, 0.95),
        "peak_memory_bytes": peak or None,
        "excluded_non_prose_finding_count": excluded_non_prose,
        "case_findings": findings_by_case,
    }


def _free_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


@contextmanager
def local_languagetool_server(jar_path: Path, timeout_seconds: float = 45.0) -> Iterator[dict[str, Any]]:
    if not jar_path.is_file() or jar_path.name != "languagetool-server.jar":
        raise ValueError("LanguageTool jar must be the local numbered distribution server jar")
    java = shutil.which("java")
    if not java:
        raise RuntimeError("Java executable is unavailable")
    port = _free_loopback_port()
    with tempfile.TemporaryDirectory(prefix="pp1-phase6-lt-") as temp_dir:
        config_path = Path(temp_dir) / "server.properties"
        config_path.write_text("maxTextLength=25000\nmaxTextHardLength=25000\nmaxCheckTimeMillis=10000\nmaxCheckThreads=1\n", encoding="utf-8")
        started = time.perf_counter()
        process = subprocess.Popen(
            [java, "-cp", str(jar_path), "org.languagetool.server.HTTPServer", "--config", str(config_path), "--port", str(port)],
            cwd=jar_path.parent,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            shell=False,
        )
        endpoint = f"http://127.0.0.1:{port}"
        try:
            while True:
                if process.poll() is not None:
                    raise RuntimeError("LanguageTool exited during startup")
                try:
                    request = urllib.request.Request(
                        _languagetool_endpoint(endpoint),
                        data=urllib.parse.urlencode({"language": "en-AU", "text": "Startup probe."}).encode("utf-8"),
                        method="POST",
                    )
                    with urllib.request.urlopen(request, timeout=2) as response:
                        response.read(1_000_001)
                    break
                except Exception:
                    if time.perf_counter() - started > timeout_seconds:
                        raise TimeoutError("LanguageTool startup exceeded the bounded timeout")
                    time.sleep(0.1)
            yield {"base_url": endpoint, "pid": process.pid, "cold_start_ms": (time.perf_counter() - started) * 1000}
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
