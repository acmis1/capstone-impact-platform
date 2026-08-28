"""Deterministic geometry-only reading order for mixed poster layouts.

Iteration 2 merged horizontal spans with a fixed gap proportional to the whole
page width.  On the preserved holdout, real 45--55 pixel gutters were smaller
than that threshold, so adjacent columns collapsed into one cluster and the
algorithm fell back to interleaved row order.  This implementation instead
finds column starts from repeated left-edge alignments.  Wide blocks crossing a
later column start become vertical band boundaries, allowing full-width titles,
tables, diagrams and captions to coexist with column-major regions.

The algorithm is bounded, metadata blind and text blind.  It receives only OCR
block geometry and never consults a case identity, reference string or title.
"""

from __future__ import annotations

from typing import Any

from ..ocr_failure_analysis.ordering import geometry_order, group_rows


ORDER_ID = "adaptive-left-anchors-and-bands/v1"
MAX_COLUMNS = 4
MIN_COLUMN_SEPARATION_RATIO = 0.12
LEFT_ALIGNMENT_TOLERANCE_RATIO = 0.035
SPAN_CROSSING_MARGIN_RATIO = 0.012
VERTICAL_BAND_TOLERANCE_RATIO = 0.006
MIN_ANCHOR_SUPPORT = 2


def _box(block: dict[str, Any]) -> dict[str, float] | None:
    value = block.get("box")
    if not isinstance(value, dict):
        return None
    try:
        box = {key: float(value[key]) for key in ("left", "top", "right", "bottom")}
    except (KeyError, TypeError, ValueError):
        return None
    if box["right"] < box["left"] or box["bottom"] < box["top"]:
        return None
    return box


def _document_extent(boxes: dict[int, dict[str, float]]) -> tuple[float, float, float, float]:
    return (
        min(box["left"] for box in boxes.values()),
        min(box["top"] for box in boxes.values()),
        max(box["right"] for box in boxes.values()),
        max(box["bottom"] for box in boxes.values()),
    )


def _row_anchor_candidates(
    blocks: list[dict[str, Any]],
    located: list[int],
    *,
    page_width: float,
) -> list[dict[str, Any]]:
    rows = group_rows(blocks, located)
    boxes = {index: _box(blocks[index]) for index in located}
    minimum_separation = MIN_COLUMN_SEPARATION_RATIO * page_width
    tolerance = LEFT_ALIGNMENT_TOLERANCE_RATIO * page_width
    candidates: list[dict[str, Any]] = []
    for row_position, row in enumerate(rows):
        if not 2 <= len(row) <= MAX_COLUMNS:
            continue
        anchors = sorted(boxes[index]["left"] for index in row)
        if any(right - left < minimum_separation for left, right in zip(anchors, anchors[1:])):
            continue
        row_top = min(boxes[index]["top"] for index in row)
        eligible = [index for index in located if boxes[index]["top"] >= row_top]
        supports = [
            sum(abs(boxes[index]["left"] - anchor) <= tolerance for index in eligible)
            for anchor in anchors
        ]
        if min(supports) < MIN_ANCHOR_SUPPORT:
            continue
        aligned = sum(
            min(abs(boxes[index]["left"] - anchor) for anchor in anchors) <= tolerance
            for index in eligible
        )
        candidates.append(
            {
                "row_position": row_position,
                "row_top": row_top,
                "anchors": anchors,
                "supports": supports,
                "aligned": aligned,
                "score": aligned + len(anchors),
            }
        )
    return candidates


def _select_anchors(
    blocks: list[dict[str, Any]],
    located: list[int],
    *,
    page_width: float,
) -> dict[str, Any] | None:
    candidates = _row_anchor_candidates(blocks, located, page_width=page_width)
    if not candidates:
        return None
    return min(
        candidates,
        key=lambda item: (
            -item["score"],
            -min(item["supports"]),
            -len(item["anchors"]),
            item["row_top"],
            item["anchors"],
        ),
    )


def _crosses_later_anchor(
    box: dict[str, float],
    anchors: list[float],
    *,
    page_width: float,
) -> bool:
    margin = SPAN_CROSSING_MARGIN_RATIO * page_width
    return any(box["left"] + margin < anchor < box["right"] - margin for anchor in anchors[1:])


def _ordered_group(blocks: list[dict[str, Any]], indexes: list[int]) -> list[int]:
    if not indexes:
        return []
    subset = [blocks[index] for index in indexes]
    return [indexes[position] for position in geometry_order(subset)]


def adaptive_column_order_with_trace(blocks: list[dict[str, Any]]) -> tuple[list[int], dict[str, Any]]:
    """Return one deterministic permutation plus bounded diagnostic geometry.

    The trace contains no recognised text.  It exists so tests and benchmark
    evidence can prove why a page used columns or a safe geometry fallback.
    """

    located = [index for index, block in enumerate(blocks) if _box(block) is not None]
    unlocated = [index for index, block in enumerate(blocks) if _box(block) is None]
    if not located:
        order = list(range(len(blocks)))
        return order, {"order_id": ORDER_ID, "mode": "provider_fallback", "reason": "no_geometry"}

    boxes = {index: _box(blocks[index]) for index in located}
    document_left, document_top, document_right, document_bottom = _document_extent(boxes)
    page_width = max(1.0, document_right - document_left)
    page_height = max(1.0, document_bottom - document_top)
    selected = _select_anchors(blocks, located, page_width=page_width)
    if selected is None:
        order = geometry_order(blocks)
        return order, {
            "order_id": ORDER_ID,
            "mode": "geometry_fallback",
            "reason": "no_supported_column_anchors",
        }

    anchors = list(selected["anchors"])
    body_top = float(selected["row_top"])
    header = [index for index in located if boxes[index]["top"] < body_top]
    body = [index for index in located if index not in header]
    spanning = [
        index
        for index in body
        if _crosses_later_anchor(boxes[index], anchors, page_width=page_width)
    ]
    columns: list[list[int]] = [[] for _ in anchors]
    for index in body:
        if index in spanning:
            continue
        nearest = min(range(len(anchors)), key=lambda position: (abs(boxes[index]["left"] - anchors[position]), position))
        columns[nearest].append(index)

    order = _ordered_group(blocks, header)
    remaining = [set(column) for column in columns]
    band_tolerance = VERTICAL_BAND_TOLERANCE_RATIO * page_height
    span_rows = group_rows(blocks, spanning) if spanning else []
    for span_row in span_rows:
        row_top = min(boxes[index]["top"] for index in span_row)
        for column in remaining:
            before = [index for index in column if boxes[index]["top"] < row_top - band_tolerance]
            order.extend(_ordered_group(blocks, before))
            column.difference_update(before)
        order.extend(_ordered_group(blocks, span_row))
    for column in remaining:
        order.extend(_ordered_group(blocks, list(column)))
    order.extend(unlocated)

    if sorted(order) != list(range(len(blocks))):
        raise ValueError("adaptive reading order is not a permutation of the input blocks")
    return order, {
        "order_id": ORDER_ID,
        "mode": "adaptive_columns",
        "column_count": len(anchors),
        "anchor_lefts": [round(value, 3) for value in anchors],
        "anchor_supports": list(selected["supports"]),
        "header_block_count": len(header),
        "spanning_band_count": len(span_rows),
        "unlocated_block_count": len(unlocated),
    }


def adaptive_column_order(blocks: list[dict[str, Any]]) -> list[int]:
    return adaptive_column_order_with_trace(blocks)[0]


def apply_adaptive_order(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [blocks[index] for index in adaptive_column_order(blocks)]
