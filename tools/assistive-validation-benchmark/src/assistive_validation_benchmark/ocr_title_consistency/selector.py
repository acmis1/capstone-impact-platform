"""Metadata-blind title selection and frozen three-outcome decision."""

from __future__ import annotations

import re
import unicodedata
from typing import Any

from ..ocr_failure_analysis.ordering import apply_order
from ..ocr_failure_analysis.selectors import bounded_groups
from ..ocr_productionization.title_safety import (
    Candidate,
    evaluate_title_safety,
    lexical_score,
    normalize_metric_title,
)


SELECTOR_ID = "top-band-group-prominence-v3@geometry"
TOP_BAND_RATIO = 0.34
GROUP_BONUS = 0.12
MAX_CANDIDATES = 8
_HARMLESS_PUNCTUATION = re.compile(r'''[.,;:!?()\[\]{}"'/\\-]''')


def normalize_title(value: str) -> str:
    value = unicodedata.normalize("NFKC", value).casefold()
    value = re.sub("[\u2018\u2019\u201B]", "'", value)
    value = re.sub("[\u201C\u201D\u201F]", '"', value)
    value = re.sub("[\u2010-\u2015\u2212]", "-", value)
    return " ".join(_HARMLESS_PUNCTUATION.sub(" ", value).split())


def _box(block: dict[str, Any]) -> dict[str, float] | None:
    value = block.get("box")
    if not isinstance(value, dict):
        return None
    try:
        return {key: float(value[key]) for key in ("left", "top", "right", "bottom")}
    except (KeyError, TypeError, ValueError):
        return None


def select_title_candidates(blocks: list[dict[str, Any]]) -> list[Candidate]:
    """Rank at most three joined top-band lines using geometry only."""

    ordered = apply_order(blocks, "geometry")
    boxes = [box for box in (_box(block) for block in ordered) if box is not None]
    if not boxes:
        return []
    top = min(box["top"] for box in boxes)
    bottom = max(box["bottom"] for box in boxes)
    limit = top + TOP_BAND_RATIO * max(1.0, bottom - top)
    groups = [
        group
        for group in bounded_groups(ordered)
        if group["box"] is not None and group["box"]["top"] <= limit
    ]
    groups.sort(
        key=lambda group: (
            -round(group["mean_line_height"] * (1 + GROUP_BONUS * (group["line_count"] - 1)), 3),
            -group["line_count"],
            group["box"]["top"],
            group["first_index"],
        )
    )
    result: list[Candidate] = []
    seen: set[str] = set()
    for group in groups:
        normalized = normalize_metric_title(group["text"])
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        prominence = group["mean_line_height"] * (1 + GROUP_BONUS * (group["line_count"] - 1))
        result.append(
            Candidate(
                text=group["text"],
                page_number=1,
                box=group["box"],
                block_indexes=tuple(range(group["first_index"], group["first_index"] + group["line_count"])),
                prominence=round(prominence, 3),
                rank=len(result) + 1,
            )
        )
        if len(result) == MAX_CANDIDATES:
            break
    return result


def evaluate_title_outcome(metadata_title: str, candidates: list[Candidate]) -> dict[str, Any]:
    if not candidates:
        return {
            "outcome": "REVIEW",
            "reason": "NO_CREDIBLE_TITLE_CANDIDATE",
            "score": None,
            "candidate": "",
        }
    if normalize_title(metadata_title) == normalize_title(candidates[0].text):
        return {
            "outcome": "AGREES",
            "reason": "NORMALIZED_EXACT_MATCH",
            "score": lexical_score(metadata_title, candidates[0].text),
            "candidate": candidates[0].text,
        }
    return evaluate_title_safety(metadata_title, candidates)
