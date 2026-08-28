"""Deterministic Pillow poster renderer for the full-page title calibration/holdout corpora."""

from __future__ import annotations

import hashlib
import random
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFilter

from ..ocr_iteration2_calibration.corpus import (
    MAX_GENERATED_FILE_BYTES,
    _case_seed,
    _font,
    _native_pdf,
    _text_width,
    _wrap_pixels,
    raster_path,
)
from .schema import canonical_json_bytes, file_sha256


PALETTES = {
    "high": ((249, 250, 248), (20, 28, 38), (26, 82, 104)),
    "low": ((228, 231, 228), (92, 98, 95), (82, 104, 104)),
}
PDF_FIXED_TIME = "D:20260827000000Z"
RENDERER_ID = "pillow-noto-fullpage-title-poster/v1"
ADMINISTRATIVE_HEADING_SIZE = 38
ADJACENT_ADMINISTRATIVE_SIZE = 44
STATUS_LINE_SIZE = 42
COMPETING_HEADING_SIZE = 54
BRANDING_SIZE = 30
SUBTITLE_SIZE = 22
CONTROL_SIZE = 17

__all__ = ["RENDERER_ID", "draw_poster", "generate_assets", "raster_path", "reference_text"]


def _title_lines(title: str, style: str, font: Any, width: int) -> list[str]:
    words = title.split()
    if style == "three_line" and len(words) >= 3:
        first = max(1, len(words) // 3)
        second = max(first + 1, (2 * len(words)) // 3)
        return [" ".join(words[:first]), " ".join(words[first:second]), " ".join(words[second:])]
    if style == "short_second_line" and len(words) >= 2:
        return [" ".join(words[:-1]), words[-1]]
    return _wrap_pixels(title, font, int(width * 0.82))


def _centre(draw: ImageDraw.ImageDraw, text: str, font: Any, y: int, width: int, fill: tuple[int, int, int]) -> int:
    draw.text(((width - _text_width(font, text)) / 2, y), text, font=font, fill=fill)
    return y + round(font.size * 1.25)


def _draw_body(
    draw: ImageDraw.ImageDraw,
    sections: list[list[dict[str, str]]],
    *,
    top: int,
    width: int,
    body_colour: tuple[int, int, int],
    accent: tuple[int, int, int],
) -> None:
    margin, gap = 54, 44
    body_font, heading_font = _font(19), _font(23)
    columns = len(sections)
    column_width = (width - 2 * margin - gap * (columns - 1)) // columns
    for position, column in enumerate(sections):
        x = margin + position * (column_width + gap)
        y = top
        for section in column:
            draw.text((x, y), section["heading"], font=heading_font, fill=accent)
            y += 34
            for line in _wrap_pixels(section["body"], body_font, column_width):
                draw.text((x, y), line, font=body_font, fill=body_colour)
                y += 27
            y += 18


def draw_poster(case: dict[str, Any], seed: int) -> Image.Image:
    width, height = int(case["width"]), int(case["height"])
    randomizer = random.Random(_case_seed(seed, case["id"]))
    background, body_colour, accent = PALETTES[case["contrast"]]
    image = Image.new("RGB", (width, height), background)
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, width, 18), fill=accent)
    margin = 54
    control_font = _font(CONTROL_SIZE)
    y = 32
    for position, control in enumerate(case["top_controls"]):
        x = margin if position % 2 == 0 else max(margin, width - margin - _text_width(control_font, control))
        draw.text((x, y), control, font=control_font, fill=(96, 102, 104))
        y += 24

    if case.get("branding_line"):
        y = _centre(draw, case["branding_line"], _font(BRANDING_SIZE), max(y + 10, 82), width, (86, 94, 98))
    if case.get("above_title_distractor"):
        y = _centre(draw, case["above_title_distractor"], _font(ADMINISTRATIVE_HEADING_SIZE), max(y + 12, 96), width, (84, 92, 96))

    title_y = max(y + 16, round(height * float(case["title_top_ratio"])))
    if case.get("adjacent_administrative_line"):
        adjacent_font = _font(ADJACENT_ADMINISTRATIVE_SIZE)
        adjacent_y = max(y + 8, title_y - round(ADJACENT_ADMINISTRATIVE_SIZE * 1.22))
        draw.text(
            ((width - _text_width(adjacent_font, case["adjacent_administrative_line"])) / 2, adjacent_y),
            case["adjacent_administrative_line"],
            font=adjacent_font,
            fill=(84, 92, 96),
        )

    poster_title = case.get("poster_title")
    if case["title_render_mode"] != "absent" and poster_title:
        title_font = _font(int(case["title_font_size"]))
        lines = _title_lines(poster_title, case["title_style"], title_font, width)[:3]
        logo_width = 190 if case["title_style"] == "logo_side" else 0
        if logo_width:
            draw.rounded_rectangle((margin, title_y + 2, margin + 164, title_y + 86), radius=12, outline=accent, width=3)
            draw.text((margin + 20, title_y + 32), "FIELD LAB", font=_font(19), fill=accent)
        for line in lines:
            line_width = _text_width(title_font, line)
            x = margin + logo_width if logo_width else max(margin, (width - line_width) / 2)
            draw.text((x, title_y), line, font=title_font, fill=body_colour)
            title_y += round(title_font.size * 1.18)

    if case.get("status_line"):
        status_font = _font(STATUS_LINE_SIZE)
        draw.text(
            ((width - _text_width(status_font, case["status_line"])) / 2, title_y),
            case["status_line"],
            font=status_font,
            fill=(84, 92, 96),
        )
        title_y += round(STATUS_LINE_SIZE * 1.2)
    if case.get("subtitle"):
        subtitle_font = _font(SUBTITLE_SIZE)
        draw.text(
            ((width - _text_width(subtitle_font, case["subtitle"])) / 2, title_y + 8),
            case["subtitle"],
            font=subtitle_font,
            fill=(84, 92, 96),
        )
        title_y += 40
    if case.get("competing_heading"):
        competing_font = _font(COMPETING_HEADING_SIZE)
        competing_y = max(title_y + 46, round(height * 0.33))
        draw.text(
            ((width - _text_width(competing_font, case["competing_heading"])) / 2, competing_y),
            case["competing_heading"],
            font=competing_font,
            fill=accent,
        )
        title_y = competing_y + round(COMPETING_HEADING_SIZE * 1.2)

    _draw_body(
        draw,
        case["column_sections"],
        top=max(round(height * 0.55), title_y + 46),
        width=width,
        body_colour=body_colour,
        accent=accent,
    )
    footer = "LOCAL CALIBRATION CARD  •  PAGE 1"
    footer_font = _font(CONTROL_SIZE)
    draw.text(((width - _text_width(footer_font, footer)) / 2, height - 42), footer, font=footer_font, fill=(96, 102, 104))
    if case["noise"] == "mild":
        for _ in range(min(7000, width * height // 210)):
            draw.point(
                (randomizer.randrange(width), randomizer.randrange(height)),
                fill=randomizer.choice(((90, 90, 90), (186, 186, 186), (242, 242, 242))),
            )
    blur = float(case.get("blur_radius") or 0)
    return image.filter(ImageFilter.GaussianBlur(radius=blur)) if blur else image


def reference_text(case: dict[str, Any]) -> str:
    """Every rendered string, in reading order. Used only for corpus-identity evidence."""
    parts = [*case["top_controls"]]
    for key in ("branding_line", "above_title_distractor", "adjacent_administrative_line"):
        if case.get(key):
            parts.append(case[key])
    if case.get("poster_title") and case["title_render_mode"] != "absent":
        parts.append(case["poster_title"])
    for key in ("status_line", "subtitle", "competing_heading"):
        if case.get(key):
            parts.append(case[key])
    for column in case["column_sections"]:
        for section in column:
            parts.extend([section["heading"], section["body"]])
    parts.append("LOCAL CALIBRATION CARD PAGE 1")
    return "\n".join(parts)


def _write_case(case: dict[str, Any], seed: int, target: Path) -> None:
    image = draw_poster(case, seed)
    try:
        if case["media"] == "png":
            image.save(target, format="PNG", optimize=False, compress_level=6)
        elif case["media"] == "jpeg":
            image.save(target, format="JPEG", quality=case["jpeg_quality"], subsampling=1, optimize=False)
        else:
            image.save(target, format="PDF", resolution=180.0, creationDate=PDF_FIXED_TIME, modDate=PDF_FIXED_TIME)
    finally:
        image.close()
    if target.stat().st_size > MAX_GENERATED_FILE_BYTES:
        raise ValueError(f"generated title-fullpage case exceeds worker byte bound: {case['id']}")


def generate_assets(corpus: dict[str, Any], output_dir: Path) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    records = []
    for case in corpus["ocr_cases"]:
        target = output_dir / case["asset"]
        _write_case(case, corpus["seed"], target)
        records.append({"case_id": case["id"], "asset": case["asset"], "bytes": target.stat().st_size, "sha256": file_sha256(target)})
    for control in corpus["native_controls"]:
        target = output_dir / control["asset"]
        target.write_bytes(_native_pdf(control))
        records.append({"case_id": control["id"], "asset": control["asset"], "bytes": target.stat().st_size, "sha256": file_sha256(target)})
    for control in corpus["security_controls"]:
        target = output_dir / control["asset"]
        payload = b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\n" if control["kind"] == "malformed_pdf" else b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
        target.write_bytes(payload)
        records.append({"case_id": control["id"], "asset": control["asset"], "bytes": target.stat().st_size, "sha256": file_sha256(target)})
    digest = hashlib.sha256()
    for record in sorted(records, key=lambda item: item["case_id"]):
        digest.update(record["case_id"].encode("utf-8"))
        digest.update(b"\0")
        digest.update(bytes.fromhex(record["sha256"]))
    result = {
        "schema_version": "pp1-ocr-title-fullpage-generation/v1",
        "renderer_id": RENDERER_ID,
        "corpus_version": corpus["corpus_version"],
        "seed": corpus["seed"],
        "asset_count": len(records),
        "corpus_asset_sha256": digest.hexdigest(),
        "assets": sorted(records, key=lambda item: item["case_id"]),
    }
    (output_dir / "generation.json").write_bytes(canonical_json_bytes(result))
    return result
