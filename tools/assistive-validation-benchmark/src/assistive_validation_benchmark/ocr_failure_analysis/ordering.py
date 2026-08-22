"""Deterministic, geometry-only page reading-order reconstruction.

Bounded and metadata blind: no ML, no language model, no ground-truth input. Every
decision uses only OCR block geometry (top/left/right/bottom) plus the document extent
implied by those blocks. Blocks without geometry keep their provider order at the end,
because inventing a position for them would not be evidence.
"""

from __future__ import annotations

from typing import Any


# Bounded constants. They are development-tuned against the exposed v1 corpus and are
# recorded in the diagnostic report so the tuning is auditable rather than implicit.
MAX_COLUMNS = 4
ROW_OVERLAP_RATIO = 0.5
COLUMN_GAP_RATIO = 0.04


def _box(block: dict[str, Any]) -> dict[str, float] | None:
    box = block.get("box")
    if not isinstance(box, dict):
        return None
    try:
        values = {key: float(box[key]) for key in ("left", "top", "right", "bottom")}
    except (KeyError, TypeError, ValueError):
        return None
    if values["right"] < values["left"] or values["bottom"] < values["top"]:
        return None
    return values


def _height(box: dict[str, float]) -> float:
    return max(1.0, box["bottom"] - box["top"])


def _partition(blocks: list[dict[str, Any]]) -> tuple[list[int], list[int]]:
    """Split block indexes into those with usable geometry and those without."""
    located = [index for index, block in enumerate(blocks) if _box(block) is not None]
    unlocated = [index for index, block in enumerate(blocks) if _box(block) is None]
    return located, unlocated


def group_rows(blocks: list[dict[str, Any]], indexes: list[int]) -> list[list[int]]:
    """Group indexes into visual rows using vertical overlap, then order each row left to right."""
    boxes = {index: _box(blocks[index]) for index in indexes}
    ordered = sorted(indexes, key=lambda index: (boxes[index]["top"], boxes[index]["left"], index))
    rows: list[list[int]] = []
    span: tuple[float, float] | None = None
    for index in ordered:
        box = boxes[index]
        if span is None:
            rows.append([index])
            span = (box["top"], box["bottom"])
            continue
        overlap = min(span[1], box["bottom"]) - max(span[0], box["top"])
        reference = min(_height(box), max(1.0, span[1] - span[0]))
        if overlap >= ROW_OVERLAP_RATIO * reference:
            rows[-1].append(index)
            span = (min(span[0], box["top"]), max(span[1], box["bottom"]))
        else:
            rows.append([index])
            span = (box["top"], box["bottom"])
    return [sorted(row, key=lambda index: (boxes[index]["left"], boxes[index]["top"], index)) for row in rows]


def geometry_order(blocks: list[dict[str, Any]]) -> list[int]:
    """Top-to-bottom, left-to-right order built from vertical-overlap row banding."""
    located, unlocated = _partition(blocks)
    if not located:
        return list(range(len(blocks)))
    order = [index for row in group_rows(blocks, located) for index in row]
    return order + unlocated


def _column_clusters(blocks: list[dict[str, Any]], indexes: list[int], gap: float) -> list[list[int]]:
    """Cluster indexes into columns by merging overlapping horizontal spans."""
    boxes = {index: _box(blocks[index]) for index in indexes}
    ordered = sorted(indexes, key=lambda index: (boxes[index]["left"], boxes[index]["right"], index))
    clusters: list[dict[str, Any]] = []
    for index in ordered:
        box = boxes[index]
        if clusters and box["left"] - clusters[-1]["right"] < gap:
            clusters[-1]["right"] = max(clusters[-1]["right"], box["right"])
            clusters[-1]["members"].append(index)
        else:
            clusters.append({"left": box["left"], "right": box["right"], "members": [index]})
    return [cluster["members"] for cluster in clusters]


def _first_multi_column_row(blocks: list[dict[str, Any]], rows: list[list[int]], gap: float) -> int | None:
    """Index of the first row holding two horizontally separated blocks, i.e. where columns begin."""
    boxes = {index: _box(blocks[index]) for row in rows for index in row}
    for position, row in enumerate(rows):
        if len(row) < 2:
            continue
        spans = sorted((boxes[index]["left"], boxes[index]["right"]) for index in row)
        if any(following[0] - previous[1] >= gap for previous, following in zip(spans, spans[1:])):
            return position
    return None


def column_order(blocks: list[dict[str, Any]]) -> list[int]:
    """Bounded column-aware order: full-width header, each column top to bottom, then the rest.

    The column region starts at the first row that actually contains two horizontally
    separated blocks. Anything above that row is a header band (a poster title spans the
    page but is not itself a column), which keeps a wrapped multi-line title contiguous.

    Falls back to :func:`geometry_order` whenever the geometry does not present a bounded
    small number of columns, so a pathological page cannot produce an arbitrary ordering.
    """
    located, unlocated = _partition(blocks)
    if not located:
        return list(range(len(blocks)))
    boxes = {index: _box(blocks[index]) for index in located}
    document_left = min(box["left"] for box in boxes.values())
    document_right = max(box["right"] for box in boxes.values())
    gap = COLUMN_GAP_RATIO * max(1.0, document_right - document_left)
    rows = group_rows(blocks, located)
    start = _first_multi_column_row(blocks, rows, gap)
    if start is None:
        return geometry_order(blocks)
    header = [index for row in rows[:start] for index in row]
    body = [index for row in rows[start:] for index in row]
    clusters = _column_clusters(blocks, body, gap)
    if len(clusters) < 2 or len(clusters) > MAX_COLUMNS:
        return geometry_order(blocks)
    columns = [
        list(cluster) for cluster in sorted(clusters, key=lambda members: min(boxes[index]["left"] for index in members))
    ]
    order: list[int] = []
    for group in [header, *columns]:
        order.extend(index for row in group_rows(blocks, group) for index in row)
    return order + unlocated


ORDERINGS = {
    "raw": lambda blocks: list(range(len(blocks))),
    "geometry": geometry_order,
    "column": column_order,
}


def apply_order(blocks: list[dict[str, Any]], name: str) -> list[dict[str, Any]]:
    if name not in ORDERINGS:
        raise ValueError(f"unknown reading order: {name}")
    order = ORDERINGS[name](blocks)
    if sorted(order) != list(range(len(blocks))):
        raise ValueError(f"reading order {name} is not a permutation of the input blocks")
    return [blocks[index] for index in order]
