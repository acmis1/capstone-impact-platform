"""Controlled A/B development probe for the corpus title stroke.

The v1 corpus draws poster titles with ``stroke_width=1`` and a stroke colour equal to the
text colour, dilating every title glyph by one pixel. Body text is drawn with no stroke. This
probe measures how much that one rendering choice moves the *tested* engines.

Scope, stated precisely:

* It renders the **complete poster**, not an isolated title band, so layout, section
  headings, body text, noise, contrast and the decorative title shadow are all present
  exactly as the corpus produces them.
* The stroke variant is proved byte-identical to the corpus asset before any OCR runs, so
  the A side is the real corpus and the B side differs from it in the stroke alone.
* Title *position* is held fixed: the layout bounding box is always computed with
  ``stroke_width=1``, so the two variants place identical glyphs at identical coordinates
  and differ only by the one-pixel dilation.

What this establishes is a measured sensitivity of the tested PP-OCRv6 candidates to one
corpus rendering choice. It does **not** establish a ceiling for OCR models generally, and
it does not by itself attribute the whole Phase 0 to v1 difference to the stroke.
"""

from __future__ import annotations

import random
import time
from pathlib import Path
from typing import Any, Callable

from PIL import Image, ImageDraw

from ..ocr_productionization.corpus import (
    _case_seed,
    _draw_poster,
    _font,
    _title_lines,
    _wrap_pixels,
)
from ..ocr_productionization.title_safety import normalize_metric_title
from .capture import exposed_development_cases


PROBE_SCHEMA = "pp1-ocr-stroke-probe/v2"

PALETTES = {
    "high": ((248, 249, 246), (18, 30, 42), (25, 73, 102)),
    "medium": ((232, 237, 235), (48, 57, 61), (67, 94, 105)),
    "low": ((218, 222, 218), (112, 116, 112), (101, 112, 113)),
}


def render_poster(case: dict[str, Any], seed: int, *, title_stroke: bool) -> Image.Image:
    """Reproduce the corpus poster exactly, with the title stroke as the only variable.

    This mirrors the frozen generator rather than modifying it. ``title_stroke=True`` must
    reproduce the corpus asset byte for byte, which :func:`verify_stroke_variant_matches_corpus`
    asserts before the probe is allowed to run.
    """
    width, height = case["width"], case["height"]
    randomizer = random.Random(_case_seed(seed, case["id"]))
    background, body_colour, accent = PALETTES[case["contrast"]]
    image = Image.new("RGB", (width, height), background)
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, width, max(8, height // 55)), fill=accent)

    title_size = max(34, width // (22 if case["difficulty"] == "clean" else 25))
    body_size = max(14, width // (112 if "small_body_text" in case["tags"] else 88))
    heading_size = max(body_size + 3, int(body_size * 1.22))
    title_font = _font(title_size)
    body_font = _font(body_size)
    heading_font = _font(heading_size)
    lines = _title_lines(draw, case, title_font, width)
    line_height = int(title_size * 1.18)
    y = max(28, height // 28)
    for line in lines:
        # Layout always uses the stroked metrics, so both variants place the same glyphs at
        # the same coordinates and the dilation is the only difference.
        box = draw.textbbox((0, 0), line, font=title_font, stroke_width=1)
        x = max(20, (width - (box[2] - box[0])) // 2)
        if case["title_style"] == "decorative":
            draw.text(
                (x + 3, y + 3),
                line,
                font=title_font,
                fill=(175, 180, 178),
                stroke_width=1 if title_stroke else 0,
            )
        if title_stroke:
            draw.text((x, y), line, font=title_font, fill=body_colour, stroke_width=1, stroke_fill=body_colour)
        else:
            draw.text((x, y), line, font=title_font, fill=body_colour)
        y += line_height

    content_top = max(y + 3 * body_size, int(height * 0.30))
    margin = max(34, width // 28)
    column_count = {"one_column": 1, "two_column": 2, "three_column": 3}[case["layout"]]
    gap = max(28, width // 35)
    column_width = (width - 2 * margin - gap * (column_count - 1)) // column_count
    body_lines = _wrap_pixels(draw, case["body"], body_font, column_width)
    per_column = (len(body_lines) + column_count - 1) // column_count
    headings = ["BACKGROUND", "METHOD", "EVIDENCE"]
    for column in range(column_count):
        x = margin + column * (column_width + gap)
        column_y = content_top
        draw.text((x, column_y), headings[column], font=heading_font, fill=accent)
        column_y += int(heading_size * 1.6)
        start = column * per_column
        end = min(len(body_lines), (column + 1) * per_column)
        for line in body_lines[start:end]:
            draw.text((x, column_y), line, font=body_font, fill=body_colour)
            column_y += int(body_size * 1.45)

    if case["noise"] == "mild":
        count = min(9000, width * height // 180)
        for _ in range(count):
            x, y = randomizer.randrange(width), randomizer.randrange(height)
            shade = randomizer.choice(((85, 85, 85), (185, 185, 185), (242, 242, 242)))
            draw.point((x, y), fill=shade)
    return image


def verify_stroke_variant_matches_corpus(cases: list[dict[str, Any]], seed: int) -> int:
    """Prove the A side of the probe is the real corpus rendering, pixel for pixel."""
    for case in cases:
        expected = _draw_poster(case, seed)
        observed = render_poster(case, seed, title_stroke=True)
        try:
            if expected.size != observed.size or expected.tobytes() != observed.tobytes():
                raise ValueError(f"stroke probe does not reproduce the corpus poster for {case['id']}")
        finally:
            expected.close()
            observed.close()
    return len(cases)


def _save(image: Image.Image, case: dict[str, Any], target: Path) -> None:
    """Persist a probe poster through the corpus media path so encoding matches too."""
    if case["media"] == "png":
        image.save(target, format="PNG", optimize=False, compress_level=6)
    elif case["media"] == "jpeg":
        image.save(target, format="JPEG", quality=case["jpeg_quality"], subsampling=1, optimize=False)
    else:
        fixed_time = "D:20260821000000Z"
        image.save(target, format="PDF", resolution=180.0, creationDate=fixed_time, modDate=fixed_time)


def _raster(source: Path, case: dict[str, Any], target: Path, dpi: int, max_input_dimension: int) -> Path:
    from ..ocr_productionization.corpus import raster_path

    stub = dict(case)
    stub["asset"] = source.name
    return raster_path(stub, source.parent, target, dpi, max_input_dimension)


def run_probe(
    runner: Callable[[Path], dict[str, Any]],
    *,
    workspace: Path,
    seed: int,
    raster_dpi: int = 150,
    max_input_dimension: int = 960,
    cases: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Render both variants of every exposed poster, OCR them, and compare title recovery.

    Both the merged production selector and the best development selector are scored, so the
    stroke effect can be read against the pipeline the benchmark actually measured as well as
    against the corrected one.
    """
    from .selectors import run_variant

    selectors = {
        "production_geometry_prominence@raw": ("production_geometry_prominence", "raw"),
        "first_bounded_group@geometry": ("first_bounded_group", "geometry"),
    }
    cases = cases if cases is not None else exposed_development_cases()
    verified = verify_stroke_variant_matches_corpus(cases, seed)
    records = []
    for case in cases:
        outcome: dict[str, Any] = {
            "case_id": case["id"],
            "title_style": case["title_style"],
            "difficulty": case["difficulty"],
            "media": case["media"],
        }
        for variant, stroke in (("stroke", True), ("no_stroke", False)):
            assets = workspace / variant / "assets"
            assets.mkdir(parents=True, exist_ok=True)
            asset = assets / case["asset"]
            if not asset.is_file():
                image = render_poster(case, seed, title_stroke=stroke)
                _save(image, case, asset)
                image.close()
            rendered = _raster(asset, case, workspace / variant / "rendered", raster_dpi, max_input_dimension)
            started = time.perf_counter()
            observation = runner(rendered)
            scored = {}
            for key, (selector, order) in selectors.items():
                candidates = run_variant(selector, order, observation["blocks"])
                top = candidates[0].text if candidates else ""
                scored[key] = normalize_metric_title(top) == normalize_metric_title(case["title"])
            outcome[variant] = {
                "exact_by_selector": scored,
                "exact": scored["production_geometry_prominence@raw"],
                "runtime_ms": (time.perf_counter() - started) * 1000,
                "block_count": len(observation["blocks"]),
            }
        records.append(outcome)
    stroke_exact = sum(record["stroke"]["exact"] for record in records)
    plain_exact = sum(record["no_stroke"]["exact"] for record in records)
    by_selector = {
        key: {
            "stroke_exact_count": sum(record["stroke"]["exact_by_selector"][key] for record in records),
            "no_stroke_exact_count": sum(record["no_stroke"]["exact_by_selector"][key] for record in records),
        }
        for key in selectors
    }
    return {
        "schema_version": PROBE_SCHEMA,
        "measures": "sensitivity of the tested engine to the corpus title stroke, on complete posters",
        "does_not_measure": "any ceiling for OCR models in general, and any single cause of the Phase 0 to v1 difference",
        "full_poster_context": True,
        "stroke_variant_matches_corpus_cases": verified,
        "raster_dpi": raster_dpi,
        "max_input_dimension": max_input_dimension,
        "case_count": len(records),
        "scored_selector": "production_geometry_prominence@raw",
        "by_selector": by_selector,
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
