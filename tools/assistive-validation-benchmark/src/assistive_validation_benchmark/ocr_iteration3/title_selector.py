"""Metadata-blind Iteration 3 title grouping for wrapped and multiline titles."""

from __future__ import annotations

from typing import Any

from ..ocr_failure_analysis.ordering import apply_order
from ..ocr_failure_analysis.selectors import bounded_groups
from ..ocr_productionization.title_safety import Candidate, normalize_metric_title


SELECTOR_ID = "top-band-group-prominence-v2@geometry"
TOP_BAND_RATIO = 0.30
GROUP_BONUS = 0.10
MAX_CANDIDATES = 8


def _box(block: dict[str, Any]) -> dict[str, float] | None:
    value = block.get("box")
    if not isinstance(value, dict):
        return None
    try:
        return {key: float(value[key]) for key in ("left", "top", "right", "bottom")}
    except (KeyError, TypeError, ValueError):
        return None


def select_title_candidates(blocks: list[dict[str, Any]]) -> list[Candidate]:
    """Prefer a coherent multiline title group over its tallest individual line.

    Iteration 2 ranked by mean line height, so the slightly taller line in a
    wrapped title outranked the exact two-line group.  A bounded 10% bonus per
    additional joined line repairs that deterministic ranking defect without
    consulting metadata, text meaning or ground truth.
    """

    ordered = apply_order(blocks, "geometry")
    boxes = [box for box in (_box(block) for block in ordered) if box is not None]
    if not boxes:
        return []
    top = min(box["top"] for box in boxes)
    bottom = max(box["bottom"] for box in boxes)
    limit = top + TOP_BAND_RATIO * max(1.0, bottom - top)
    groups = [group for group in bounded_groups(ordered) if group["box"] is not None and group["box"]["top"] <= limit]
    ranked = sorted(
        groups,
        key=lambda group: (
            -round(group["mean_line_height"] * (1 + GROUP_BONUS * (group["line_count"] - 1)), 3),
            -group["line_count"],
            group["first_index"],
        ),
    )
    result: list[Candidate] = []
    seen: set[str] = set()
    for group in ranked:
        key = normalize_metric_title(group["text"])
        if key in seen:
            continue
        seen.add(key)
        score = group["mean_line_height"] * (1 + GROUP_BONUS * (group["line_count"] - 1))
        result.append(
            Candidate(
                text=group["text"],
                page_number=1,
                box=group["box"],
                block_indexes=tuple(range(group["first_index"], group["first_index"] + group["line_count"])),
                prominence=round(score, 3),
                rank=len(result) + 1,
            )
        )
        if len(result) == MAX_CANDIDATES:
            break
    return result
