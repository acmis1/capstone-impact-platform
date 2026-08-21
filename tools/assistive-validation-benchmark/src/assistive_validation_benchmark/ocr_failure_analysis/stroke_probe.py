"""Controlled single-variable probe for the title stroke-dilation hypothesis.

The v1 corpus draws poster titles with ``stroke_width=1`` and ``stroke_fill`` equal to the
text colour, which dilates every title glyph by one pixel. Body text is drawn without a
stroke. Phase 0's corpus drew titles without a stroke at all. That difference is a candidate
explanation for the large Phase 0 -> v1 exact-title regression, and for the systematic
``i`` -> ``l`` confusions visible in v1 recognition failures.

This probe renders the *same* title text, font, size, colour, position and background twice,
changing only the stroke, then runs the same OCR adapter over both. Nothing else varies, so
a difference in recovery is attributable to the stroke alone. It reads the frozen corpus
generator's helpers rather than modifying them.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Callable

from PIL import Image, ImageDraw

from ..ocr_productionization.corpus import _font, _title_lines
from ..ocr_productionization.title_safety import normalize_metric_title
from .capture import exposed_development_cases


PALETTES = {
    "high": ((248, 249, 246), (18, 30, 42)),
    "medium": ((232, 237, 235), (48, 57, 61)),
    "low": ((218, 222, 218), (112, 116, 112)),
}


def render_title_band(case: dict[str, Any], *, stroke: bool, max_input_dimension: int) -> Image.Image:
    """Reproduce the corpus title band exactly, with the stroke as the only variable."""
    width = case["width"]
    background, body_colour = PALETTES[case["contrast"]]
    title_size = max(34, width // (22 if case["difficulty"] == "clean" else 25))
    title_font = _font(title_size)
    line_height = int(title_size * 1.18)
    probe = Image.new("RGB", (width, 10), background)
    lines = _title_lines(ImageDraw.Draw(probe), case, title_font, width)
    probe.close()
    top = max(28, case["height"] // 28)
    height = top + line_height * len(lines) + title_size
    image = Image.new("RGB", (width, height), background)
    draw = ImageDraw.Draw(image)
    y = top
    for line in lines:
        box = draw.textbbox((0, 0), line, font=title_font, stroke_width=1 if stroke else 0)
        x = max(20, (width - (box[2] - box[0])) // 2)
        if stroke:
            draw.text((x, y), line, font=title_font, fill=body_colour, stroke_width=1, stroke_fill=body_colour)
        else:
            draw.text((x, y), line, font=title_font, fill=body_colour)
        y += line_height
    longest = max(image.size)
    if longest > max_input_dimension:
        scale = max_input_dimension / longest
        resized = image.resize(
            (max(1, round(image.width * scale)), max(1, round(image.height * scale))),
            resample=Image.Resampling.LANCZOS,
        )
        image.close()
        image = resized
    return image


def run_probe(
    runner: Callable[[Path], dict[str, Any]],
    *,
    workspace: Path,
    max_input_dimension: int,
    cases: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """OCR every exposed title band with and without the stroke and compare recovery."""
    cases = cases if cases is not None else exposed_development_cases()
    workspace.mkdir(parents=True, exist_ok=True)
    records = []
    for case in cases:
        outcome: dict[str, Any] = {"case_id": case["id"], "title_style": case["title_style"], "difficulty": case["difficulty"]}
        for variant, stroke in (("stroke", True), ("no_stroke", False)):
            target = workspace / f"{case['id']}--{variant}.png"
            if not target.is_file():
                image = render_title_band(case, stroke=stroke, max_input_dimension=max_input_dimension)
                image.save(target, format="PNG", optimize=False, compress_level=6)
                image.close()
            started = time.perf_counter()
            observation = runner(target)
            text = " ".join(
                " ".join(str(block.get("text") or "").split()) for block in observation["blocks"]
            ).strip()
            outcome[variant] = {
                "text": text,
                "exact": normalize_metric_title(text) == normalize_metric_title(case["title"]),
                "runtime_ms": (time.perf_counter() - started) * 1000,
            }
        records.append(outcome)
    stroke_exact = sum(record["stroke"]["exact"] for record in records)
    plain_exact = sum(record["no_stroke"]["exact"] for record in records)
    return {
        "schema_version": "pp1-ocr-stroke-probe/v1",
        "hypothesis": "title stroke dilation, not OCR capability, drives the v1 exact-title regression",
        "max_input_dimension": max_input_dimension,
        "case_count": len(records),
        "stroke_exact_count": stroke_exact,
        "no_stroke_exact_count": plain_exact,
        "stroke_exact_rate": stroke_exact / len(records) if records else None,
        "no_stroke_exact_rate": plain_exact / len(records) if records else None,
        "recovered_only_without_stroke": [
            record["case_id"] for record in records if record["no_stroke"]["exact"] and not record["stroke"]["exact"]
        ],
        "recovered_only_with_stroke": [
            record["case_id"] for record in records if record["stroke"]["exact"] and not record["no_stroke"]["exact"]
        ],
        "records": records,
    }
