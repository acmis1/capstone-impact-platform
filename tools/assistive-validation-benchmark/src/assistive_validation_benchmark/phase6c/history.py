from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ..phase6.corpus import load_phase6_manifest
from ..phase6.history import holdout_text_digest, load_exposed_holdout_texts


def _phase0_holdout_digests(tool_root: Path) -> set[str]:
    manifest = json.loads((tool_root / "corpus" / "manifest.json").read_text(encoding="utf-8"))
    return {
        holdout_text_digest(case["text"])
        for case in manifest["cases"]
        if case.get("kind") == "grammar" and case.get("split") == "holdout"
    }


def _phase6a_current_holdout_digests(tool_root: Path) -> set[str]:
    manifest = load_phase6_manifest(tool_root / "phase6" / "corpus" / "manifest.json")
    return {
        holdout_text_digest(case["source_text"])
        for case in manifest["grammar_cases"]
        if case["split"] == "holdout"
    }


def exposed_prior_holdout_summary(tool_root: Path) -> tuple[set[str], dict[str, int]]:
    phase0 = _phase0_holdout_digests(tool_root)
    superseded = set(load_exposed_holdout_texts(tool_root))
    phase6a = _phase6a_current_holdout_digests(tool_root)
    combined = phase0 | superseded | phase6a
    return combined, {
        "phase0_grammar_holdout": len(phase0),
        "phase6a_superseded_lock": len(superseded),
        "phase6a_v4_holdout": len(phase6a),
        "unique_prior_exposed_texts": len(combined),
    }


def check_fresh_holdout_non_reuse(
    tool_root: Path,
    calibration_cases: list[dict[str, Any]],
    holdout_cases: list[dict[str, Any]],
) -> dict[str, Any]:
    prior, sources = exposed_prior_holdout_summary(tool_root)
    calibration = {holdout_text_digest(case["source_text"]) for case in calibration_cases}
    holdout = [holdout_text_digest(case["source_text"]) for case in holdout_cases]
    prior_matches = [case["id"] for case, digest in zip(holdout_cases, holdout, strict=True) if digest in prior]
    calibration_matches = [
        case["id"] for case, digest in zip(holdout_cases, holdout, strict=True) if digest in calibration
    ]
    if prior_matches:
        raise ValueError("Fresh Phase 6C holdout reuses prior exposed text: " + ", ".join(prior_matches))
    if calibration_matches:
        raise ValueError("Fresh Phase 6C holdout reuses calibration text: " + ", ".join(calibration_matches))
    if len(holdout) != len(set(holdout)):
        raise ValueError("Fresh Phase 6C holdout contains duplicate normalised text")
    return {
        "normalisation": "unicode_preserved_whitespace_collapsed_casefolded_sha256",
        "prior_source_counts": sources,
        "prior_exposed_texts_checked": len(prior),
        "calibration_texts_checked": len(calibration),
        "fresh_holdout_texts_checked": len(holdout),
        "prior_text_matches": 0,
        "calibration_text_matches": 0,
        "within_holdout_duplicates": 0,
    }
