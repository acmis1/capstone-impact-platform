"""Metadata-blind full-page title selection.

This starts from the merged top-band group-prominence selector and changes exactly two things,
both of which are properties of rendered typography rather than of any particular document:

1. **Extent-aware line height.** An OCR line box measures ink, not type size. A title line
   containing descenders spans ascender-to-descender while its neighbouring line without
   descenders spans only ascender-to-baseline, so two lines of one title can differ by ~30% in
   measured height. Each line's height is therefore divided by the vertical extent its own
   characters imply before any height is compared or ranked.

2. **Case-style consistency when joining.** A control, status or administrative stamp is
   conventionally set in full capitals and is typographically distinct from a mixed-case
   project title, so an all-uppercase line is never joined to a mixed-case line.

Nothing here consults metadata, case identifiers, project wording or learned coordinates.
Ranking sees OCR geometry and the letter classes of the recognised glyphs only.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Any

from ..ocr_failure_analysis.ordering import apply_order
from ..ocr_productionization.title_safety import (
    Candidate,
    evaluate_title_safety,
    lexical_score,
    normalize_metric_title,
)


SELECTOR_ID = "top-band-typography-consistent-group-prominence-v4@geometry"
TOP_BAND_RATIO = 0.34
GROUP_BONUS = 0.12
MAX_GROUP_LINES = 3
MAX_CANDIDATES = 8
# Unchanged from the merged baseline: comparable height and at most a one-line gap.
HEIGHT_TOLERANCE = 0.30
GAP_LINE_HEIGHTS = 1.0
# Vertical ink extent as a fraction of the type size, by the letter classes a line contains.
# These are ordinary Latin typographic proportions, not values fitted to any case.
EXTENT_ASCENDER_AND_DESCENDER = 0.98
EXTENT_ASCENDER_ONLY = 0.75
EXTENT_DESCENDER_ONLY = 0.78
EXTENT_X_HEIGHT_ONLY = 0.55
DESCENDER_CHARACTERS = frozenset("gjpqy,;")
ASCENDER_CHARACTERS = frozenset("bdfhklt")
_HARMLESS_PUNCTUATION = re.compile(r'''[.,;:!?()\[\]{}"'/\\-]''')


def normalize_title(value: str) -> str:
    value = unicodedata.normalize("NFKC", value).casefold()
    value = re.sub("[‘’‛]", "'", value)
    value = re.sub("[“”‟]", '"', value)
    value = re.sub("[‐-―−]", "-", value)
    return " ".join(_HARMLESS_PUNCTUATION.sub(" ", value).split())


def _text(block: dict[str, Any]) -> str:
    return " ".join(str(block.get("text") or "").split())


def _box(block: dict[str, Any]) -> dict[str, float] | None:
    value = block.get("box")
    if not isinstance(value, dict):
        return None
    try:
        return {key: float(value[key]) for key in ("left", "top", "right", "bottom")}
    except (KeyError, TypeError, ValueError):
        return None


def case_style(text: str) -> str:
    """Letter-case style of a rendered line: a typographic property, never its meaning."""
    letters = [character for character in text if character.isalpha()]
    if not letters:
        return "NEUTRAL"
    return "UPPER" if all(character.isupper() for character in letters) else "MIXED"


def vertical_extent_ratio(text: str) -> float:
    """The fraction of the type size this line's own characters can actually paint."""
    tall = any(character.isupper() or character.isdigit() for character in text) or any(
        character in ASCENDER_CHARACTERS for character in text
    )
    deep = any(character in DESCENDER_CHARACTERS for character in text)
    if tall and deep:
        return EXTENT_ASCENDER_AND_DESCENDER
    if tall:
        return EXTENT_ASCENDER_ONLY
    if deep:
        return EXTENT_DESCENDER_ONLY
    return EXTENT_X_HEIGHT_ONLY


def type_size(box: dict[str, float] | None, text: str) -> float:
    """Estimated type size of one recognised line, from its ink box and its letter classes."""
    if box is None:
        return 0.0
    return max(1.0, box["bottom"] - box["top"]) / vertical_extent_ratio(text)


def typography_consistent(
    previous_box: dict[str, float] | None,
    following_box: dict[str, float] | None,
    previous_text: str,
    following_text: str,
) -> bool:
    """Join predicate: comparable type size, at most a one-line gap, same letter-case style."""
    if previous_box is None or following_box is None:
        return False
    if following_box["top"] < previous_box["top"]:
        return False
    previous_size = type_size(previous_box, previous_text)
    following_size = type_size(following_box, following_text)
    if min(previous_size, following_size) / max(previous_size, following_size) < 1 - HEIGHT_TOLERANCE:
        return False
    previous_height = max(1.0, previous_box["bottom"] - previous_box["top"])
    following_height = max(1.0, following_box["bottom"] - following_box["top"])
    if following_box["top"] - previous_box["bottom"] > GAP_LINE_HEIGHTS * min(previous_height, following_height):
        return False
    previous_style, following_style = case_style(previous_text), case_style(following_text)
    return "NEUTRAL" in {previous_style, following_style} or previous_style == following_style


def typography_consistent_groups(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """All adjacent groups of at most three typographically consistent lines."""
    groups: list[dict[str, Any]] = []
    for start in range(len(blocks)):
        if not _text(blocks[start]):
            continue
        boxes: list[dict[str, float] | None] = []
        texts: list[str] = []
        for offset in range(MAX_GROUP_LINES):
            index = start + offset
            if index >= len(blocks):
                break
            text = _text(blocks[index])
            if not text:
                break
            box = _box(blocks[index])
            if offset and not typography_consistent(boxes[-1], box, texts[-1], text):
                break
            boxes.append(box)
            texts.append(text)
            if any(item is None for item in boxes):
                combined = None
                mean_type_size = 0.0
            else:
                combined = {
                    "left": min(item["left"] for item in boxes),
                    "top": min(item["top"] for item in boxes),
                    "right": max(item["right"] for item in boxes),
                    "bottom": max(item["bottom"] for item in boxes),
                }
                mean_type_size = sum(
                    type_size(item, line) for item, line in zip(boxes, texts)
                ) / len(boxes)
            groups.append(
                {
                    "text": " ".join(texts),
                    "box": combined,
                    "line_count": offset + 1,
                    "first_index": start,
                    "mean_type_size": mean_type_size,
                }
            )
    return groups


def select_title_candidates(blocks: list[dict[str, Any]]) -> list[Candidate]:
    """Rank typographically coherent top-band line groups by estimated type size."""
    ordered = apply_order(blocks, "geometry")
    boxes = [box for box in (_box(block) for block in ordered) if box is not None]
    if not boxes:
        return []
    top = min(box["top"] for box in boxes)
    bottom = max(box["bottom"] for box in boxes)
    limit = top + TOP_BAND_RATIO * max(1.0, bottom - top)
    groups = [
        group
        for group in typography_consistent_groups(ordered)
        if group["box"] is not None and group["box"]["top"] <= limit
    ]
    groups.sort(
        key=lambda group: (
            -round(group["mean_type_size"] * (1 + GROUP_BONUS * (group["line_count"] - 1)), 3),
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
        prominence = group["mean_type_size"] * (1 + GROUP_BONUS * (group["line_count"] - 1))
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
    """Frozen three-outcome deterministic title safety. Semantic similarity never agrees."""
    if not candidates:
        return {"outcome": "REVIEW", "reason": "NO_CREDIBLE_TITLE_CANDIDATE", "score": None, "candidate": ""}
    if normalize_title(metadata_title) == normalize_title(candidates[0].text):
        return {
            "outcome": "AGREES",
            "reason": "NORMALIZED_EXACT_MATCH",
            "score": lexical_score(metadata_title, candidates[0].text),
            "candidate": candidates[0].text,
        }
    return evaluate_title_safety(metadata_title, candidates)
