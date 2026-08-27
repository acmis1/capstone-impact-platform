from __future__ import annotations

import json
import re
import shutil
import statistics
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from ..engines import _process_memory_bytes, run_command_measured
from ..phase6.grammar import (
    MATCHER_CONTRACT,
    _finding_matches_issue,
    _is_spelling,
    _percentile,
    _score,
    local_languagetool_server,
)

OFFSET_UNIT = "UNICODE_CODE_POINTS"
PROVIDER_OFFSET_UNIT = "UTF16_CODE_UNITS"
MASK_PATTERN_CONTRACT = (
    ("fenced_code", r"```.*?```", "DOTALL"),
    ("inline_code_or_database_identifier", r"`[^`\r\n]+`", ""),
    ("url", r"https?://[^\s]+", ""),
    ("email", r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b", ""),
    ("rfc4122_uuid", r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\b", ""),
    ("prefixed_or_bare_hash", r"\b(?:sha(?:1|224|256|384|512):)?[0-9a-fA-F]{32,128}\b", "IGNORECASE"),
    ("filesystem_path", r'(?<!\w)(?:[A-Za-z]:[\\/]|\.?\.?[\\/])(?:[^\s<>:"|?*]+[\\/])*[^\s<>:"|?*]*', ""),
    ("relative_slash_path", r"\b[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)+\b", ""),
    ("dotted_filename_or_database_identifier", r"\b[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+\b", ""),
    ("semantic_version", r"\bv?\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z.-]+)?\b", ""),
    ("environment_or_snake_identifier", r"\b(?:[A-Z][A-Z0-9]*|[a-z][a-z0-9]*)(?:_[A-Za-z0-9]+)+\b", ""),
    ("camel_case_identifier", r"\b[a-z]+(?:[A-Z][A-Za-z0-9]*)+\b", ""),
)


def _flags(flag: str) -> int:
    if flag == "DOTALL":
        return re.DOTALL
    if flag == "IGNORECASE":
        return re.IGNORECASE
    return 0


_MASK_PATTERNS = [re.compile(pattern, _flags(flag)) for _, pattern, flag in MASK_PATTERN_CONTRACT]


def utf16_length(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def utf16_offset_to_codepoint(text: str, offset: int) -> int:
    if not isinstance(offset, int) or offset < 0:
        raise ValueError("Provider offset must be a non-negative integer")
    consumed = 0
    for index, character in enumerate(text):
        if consumed == offset:
            return index
        consumed += utf16_length(character)
        if consumed > offset:
            raise ValueError("Provider UTF-16 offset splits a surrogate pair")
    if consumed == offset:
        return len(text)
    raise ValueError("Provider UTF-16 offset exceeds the source field")


def grammar_mask_contract() -> dict[str, Any]:
    return {
        "canonical_offset_unit": OFFSET_UNIT,
        "provider_offset_unit": PROVIDER_OFFSET_UNIT,
        "preserve_offsets": True,
        "preserve_provider_utf16_length": True,
        "replacement": "spaces_per_utf16_code_unit_except_existing_line_breaks",
        "patterns": [
            {"id": identifier, "pattern": pattern, "flag": flag}
            for identifier, pattern, flag in MASK_PATTERN_CONTRACT
        ],
        "exclude_overlapping_findings": True,
    }


def grammar_matcher_contract() -> dict[str, Any]:
    return dict(MATCHER_CONTRACT)


def prepare_grammar_text(text: str) -> tuple[str, list[tuple[int, int]]]:
    """Mask machine data and preserve both source code-point and provider UTF-16 offsets."""
    masked = list(text)
    spans: list[tuple[int, int]] = []
    for pattern in _MASK_PATTERNS:
        for match in pattern.finditer(text):
            if any(start < match.end() and match.start() < end for start, end in spans):
                continue
            spans.append((match.start(), match.end()))
            for index in range(match.start(), match.end()):
                if masked[index] not in "\r\n":
                    masked[index] = " " * utf16_length(masked[index])
    prepared = "".join(masked)
    if utf16_length(prepared) != utf16_length(text):
        raise ValueError("Offset-preserving masking changed provider UTF-16 length")
    return prepared, sorted(spans)


def _exclude_non_prose_findings(
    case: dict[str, Any], findings: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], int]:
    _, excluded_spans = prepare_grammar_text(case["source_text"])
    retained = [
        finding for finding in findings
        if not any(start < finding["end"] and finding["start"] < end for start, end in excluded_spans)
    ]
    return retained, len(findings) - len(retained)


def _provider_findings_to_codepoints(
    source_text: str, findings: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    converted: list[dict[str, Any]] = []
    for finding in findings:
        start = utf16_offset_to_codepoint(source_text, int(finding["start"]))
        end = utf16_offset_to_codepoint(source_text, int(finding["end"]))
        converted.append({**finding, "start": start, "end": end})
    return converted


def run_harper(cases: list[dict[str, Any]], tool_root: Path) -> dict[str, Any]:
    node = shutil.which("node")
    package = tool_root / "node_modules" / "harper.js" / "package.json"
    runner = tool_root / "phase6" / "harper_runner.mjs"
    if not node or not package.is_file():
        return {"engine": "harper", "status": "unavailable", "error": "Pinned local Harper dependency is unavailable"}
    texts = [prepare_grammar_text(case["source_text"])[0] for case in cases]
    with tempfile.TemporaryDirectory(prefix="pp1-phase7-harper-") as temp_dir:
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
        converted = _provider_findings_to_codepoints(case["source_text"], entry["findings"])
        retained, excluded = _exclude_non_prose_findings(case, converted)
        case_findings.append(retained)
        excluded_count += excluded
    return {
        "engine": "harper", "status": "ok", "version": version,
        "dependency_source": "npm package harper.js pinned by package-lock.json",
        "license": "Apache-2.0", "backend": "harper.js WASM/local",
        "configuration": {"dialect": "Australian", "language": "plaintext"},
        "cold_start_ms": payload["setup_ms"], "process_runtime_ms": result["runtime_ms"],
        "latency_p50_ms": statistics.median(runtimes), "latency_p95_ms": _percentile(runtimes, 0.95),
        "peak_memory_bytes": result["peak_memory_bytes"],
        "excluded_non_prose_finding_count": excluded_count, "case_findings": case_findings,
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
    peak = excluded_non_prose = 0
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
            raw = [{
                "start": int(match["offset"]), "end": int(match["offset"] + match["length"]),
                "message": match.get("message", ""), "rule": match.get("rule", {}).get("id", "unknown"),
                "category": match.get("rule", {}).get("category", {}).get("id", "unknown"),
                "replacements": [item.get("value", "") for item in match.get("replacements", [])[:20]],
            } for match in data.get("matches", [])]
            converted = _provider_findings_to_codepoints(case["source_text"], raw)
            retained, excluded = _exclude_non_prose_findings(case, converted)
            findings_by_case.append(retained)
            excluded_non_prose += excluded
    except Exception as error:
        return {"engine": "languagetool", "status": "failed", "error": f"{type(error).__name__}: {error}"}
    return {
        "engine": "languagetool", "status": "ok", "version": version,
        "dependency_source": "official numbered local LanguageTool distribution",
        "license": "LGPL-2.1-or-later; distribution third-party notices apply",
        "backend": "bounded local loopback Java server",
        "configuration": {"language": "en-AU", "max_text_length": 25000, "max_check_time_ms": 10000},
        "latency_p50_ms": statistics.median(runtimes), "latency_p95_ms": _percentile(runtimes, 0.95),
        "peak_memory_bytes": peak or None, "excluded_non_prose_finding_count": excluded_non_prose,
        "case_findings": findings_by_case,
    }


__all__ = [
    "_finding_matches_issue", "_is_spelling", "_score", "grammar_mask_contract",
    "grammar_matcher_contract", "local_languagetool_server", "prepare_grammar_text",
    "run_harper", "run_languagetool", "utf16_length", "utf16_offset_to_codepoint",
]
