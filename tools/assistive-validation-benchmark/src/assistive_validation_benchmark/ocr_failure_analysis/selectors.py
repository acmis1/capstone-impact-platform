"""Metadata-blind title-candidate selectors and the ground-truth title oracle.

Every selector here is runtime label blind: it receives OCR blocks only. Ground truth is
used exclusively to *score* selectors and to compute the oracle coverage that tells us
whether the engine recognised the title at all. No selector may consult the metadata title,
so none of these can become a ground-truth-driven production algorithm.
"""

from __future__ import annotations

from typing import Any, Callable

from ..ocr_productionization.title_safety import (
    Candidate,
    extract_title_candidates,
    levenshtein,
    normalize_metric_title,
)
from .ordering import apply_order


MAX_GROUP_LINES = 3
TOP_BAND_RATIO = 0.40
HEIGHT_TOLERANCE = 0.30
GAP_LINE_HEIGHTS = 1.0
CENTRE_TOLERANCE_RATIO = 0.10


def _text(block: dict[str, Any]) -> str:
    return " ".join(str(block.get("text") or "").split())


def _box(block: dict[str, Any]) -> dict[str, float] | None:
    box = block.get("box")
    if not isinstance(box, dict):
        return None
    try:
        return {key: float(box[key]) for key in ("left", "top", "right", "bottom")}
    except (KeyError, TypeError, ValueError):
        return None


def _height(box: dict[str, float]) -> float:
    return max(1.0, box["bottom"] - box["top"])


def _joinable(previous: dict[str, float] | None, following: dict[str, float] | None) -> bool:
    """Bounded adjacency: comparable line height and a gap no larger than one line."""
    if previous is None or following is None:
        return False
    if following["top"] < previous["top"]:
        return False
    previous_height, following_height = _height(previous), _height(following)
    ratio = min(previous_height, following_height) / max(previous_height, following_height)
    if ratio < 1 - HEIGHT_TOLERANCE:
        return False
    return following["top"] - previous["bottom"] <= GAP_LINE_HEIGHTS * min(previous_height, following_height)


def bounded_groups(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """All adjacent groups of at most three consecutive blocks, with combined geometry."""
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
            if offset and not _joinable(boxes[-1], box):
                break
            boxes.append(box)
            texts.append(text)
            present = [item for item in boxes if item is not None]
            combined = (
                {
                    "left": min(item["left"] for item in present),
                    "top": min(item["top"] for item in present),
                    "right": max(item["right"] for item in present),
                    "bottom": max(item["bottom"] for item in present),
                }
                if len(present) == len(boxes)
                else None
            )
            groups.append(
                {
                    "text": " ".join(texts),
                    "box": combined,
                    "line_count": offset + 1,
                    "first_index": start,
                    "mean_line_height": (
                        sum(_height(item) for item in present) / len(present) if present else 0.0
                    ),
                }
            )
    return groups


def _document_extent(blocks: list[dict[str, Any]]) -> tuple[float, float, float, float] | None:
    boxes = [box for box in (_box(block) for block in blocks) if box is not None]
    if not boxes:
        return None
    return (
        min(box["left"] for box in boxes),
        min(box["top"] for box in boxes),
        max(box["right"] for box in boxes),
        max(box["bottom"] for box in boxes),
    )


def _as_candidates(groups: list[dict[str, Any]]) -> list[Candidate]:
    """Convert ranked groups into the production Candidate shape, deduplicating by title.

    Preserving ``block_indexes`` and ``prominence`` matters: the existing deterministic
    title-safety logic uses both to decide ambiguity, so every alternative selector is
    scored through exactly the same safety contract as the production selector.
    """
    result: list[Candidate] = []
    seen: set[str] = set()
    for group in groups:
        key = normalize_metric_title(group["text"])
        if key in seen:
            continue
        seen.add(key)
        result.append(
            Candidate(
                text=group["text"],
                page_number=1,
                box=group["box"],
                block_indexes=tuple(range(group["first_index"], group["first_index"] + group["line_count"])),
                prominence=round(group["mean_line_height"], 3),
                rank=len(result) + 1,
            )
        )
        if len(result) == 8:
            break
    return result


def select_production(blocks: list[dict[str, Any]]) -> list[Candidate]:
    """The exact merged v1 selector: document order, prominence and adjacent groups."""
    return extract_title_candidates(blocks)


def select_first_line(blocks: list[dict[str, Any]]) -> list[Candidate]:
    """Phase 0's metadata-blind baseline: the first non-empty recognised line."""
    for index, block in enumerate(blocks):
        text = _text(block)
        if text:
            box = _box(block)
            return _as_candidates(
                [
                    {
                        "text": text,
                        "box": box,
                        "line_count": 1,
                        "first_index": index,
                        "mean_line_height": _height(box) if box else 0.0,
                    }
                ]
            )
    return []


def select_first_group(blocks: list[dict[str, Any]]) -> list[Candidate]:
    """The longest bounded adjacent group anchored at the first non-empty line."""
    for index, block in enumerate(blocks):
        if not _text(block):
            continue
        # bounded_groups always yields at least the single-line group for a block with text.
        anchored = [group for group in bounded_groups(blocks) if group["first_index"] == index]
        return _as_candidates([max(anchored, key=lambda group: group["line_count"])])
    return []


def _band_groups(
    blocks: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], tuple[float, float, float, float]] | None:
    extent = _document_extent(blocks)
    if extent is None:
        return None
    _, top, _, bottom = extent
    limit = top + TOP_BAND_RATIO * max(1.0, bottom - top)
    groups = [
        group
        for group in bounded_groups(blocks)
        if group["box"] is not None and group["box"]["top"] <= limit
    ]
    return (groups, extent) if groups else None


def _rank(groups: list[dict[str, Any]]) -> list[Candidate]:
    ranked = sorted(
        groups,
        key=lambda group: (-round(group["mean_line_height"], 3), -group["line_count"], group["first_index"]),
    )
    return _as_candidates(ranked)


def select_top_band_prominence(blocks: list[dict[str, Any]]) -> list[Candidate]:
    """Tallest bounded group inside the top band, preferring longer groups on a height tie."""
    banded = _band_groups(blocks)
    if banded is None:
        return select_first_group(blocks)
    return _rank(banded[0])


def select_centred_prominence(blocks: list[dict[str, Any]]) -> list[Candidate]:
    """Tallest horizontally centred group in the top band; falls back to top-band prominence.

    Centring is pure geometry, but it does encode an assumption that posters centre their
    titles. The diagnostic report records that assumption so it is not mistaken for a
    corpus-independent result.
    """
    banded = _band_groups(blocks)
    if banded is None:
        return select_first_group(blocks)
    groups, (left, _, right, _) = banded
    centre = (left + right) / 2
    tolerance = CENTRE_TOLERANCE_RATIO * max(1.0, right - left)
    centred = [
        group
        for group in groups
        if abs((group["box"]["left"] + group["box"]["right"]) / 2 - centre) <= tolerance
    ]
    return _rank(centred) if centred else _rank(groups)


SELECTORS: dict[str, Callable[[list[dict[str, Any]]], list[Candidate]]] = {
    "production_geometry_prominence": select_production,
    "first_line": select_first_line,
    "first_bounded_group": select_first_group,
    "top_band_prominence": select_top_band_prominence,
    "centred_top_band_prominence": select_centred_prominence,
}

# Selector/ordering pairs scored in the diagnostic. "raw" reproduces the merged v1 pipeline.
SELECTOR_VARIANTS: tuple[tuple[str, str], ...] = (
    ("production_geometry_prominence", "raw"),
    ("production_geometry_prominence", "geometry"),
    ("production_geometry_prominence", "column"),
    ("first_line", "raw"),
    ("first_line", "geometry"),
    ("first_bounded_group", "geometry"),
    ("top_band_prominence", "geometry"),
    ("centred_top_band_prominence", "geometry"),
)


def run_variant(selector: str, order: str, blocks: list[dict[str, Any]]) -> list[Candidate]:
    """Apply a reading order, then a metadata-blind selector, to one page of OCR blocks."""
    if selector not in SELECTORS:
        raise ValueError(f"unknown title selector: {selector}")
    return SELECTORS[selector](apply_order(blocks, order))


def similarity(left: str, right: str) -> float:
    """Normalized-title similarity in [0, 1]; 1.0 means an exact normalized match."""
    first, second = normalize_metric_title(left), normalize_metric_title(right)
    if not first and not second:
        return 1.0
    return 1 - levenshtein(first, second) / max(1, len(first), len(second))


def title_oracle(blocks: list[dict[str, Any]], truth: str) -> dict[str, Any]:
    """Ground-truth-aware diagnostic: could the title have been recovered from this OCR output?

    This is an oracle, never a production path. It answers whether recognition produced the
    title, separately from whether the blind selector ranked it first.
    """
    target = normalize_metric_title(truth)
    candidates = [candidate.text for candidate in select_production(blocks)]
    groups = {name: bounded_groups(apply_order(blocks, name)) for name in ("raw", "geometry", "column")}
    in_blocks = any(normalize_metric_title(_text(block)) == target for block in blocks)
    grouped = {
        name: any(normalize_metric_title(group["text"]) == target for group in group_list)
        for name, group_list in groups.items()
    }
    best = max(
        (similarity(group["text"], truth) for group_list in groups.values() for group in group_list),
        default=0.0,
    )
    return {
        "top1": bool(candidates) and normalize_metric_title(candidates[0]) == target,
        "top3": any(normalize_metric_title(text) == target for text in candidates[:3]),
        "top5": any(normalize_metric_title(text) == target for text in candidates[:5]),
        "top8": any(normalize_metric_title(text) == target for text in candidates[:8]),
        "in_individual_blocks": in_blocks,
        "in_adjacent_groups_raw": grouped["raw"],
        "in_adjacent_groups_geometry": grouped["geometry"],
        "in_adjacent_groups_column": grouped["column"],
        "recoverable": in_blocks or any(grouped.values()),
        "best_group_similarity": round(best, 4),
        "selected_candidate": candidates[0] if candidates else "",
        "candidate_count": len(candidates),
    }
