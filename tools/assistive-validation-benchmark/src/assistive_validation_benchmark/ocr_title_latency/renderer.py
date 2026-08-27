from __future__ import annotations

import hashlib
import random
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFilter

from ..ocr_iteration2_calibration.corpus import (
    MAX_GENERATED_FILE_BYTES,
    _case_seed,
    _draw_tracked_text,
    _font,
    _native_pdf,
    _text_width,
    _wrap_pixels,
    raster_path,
)
from .schema import canonical_json_bytes, file_sha256


PALETTES = {
    "high": ((248, 250, 247), (18, 30, 42), (24, 78, 107)),
    "low": ((230, 232, 229), (88, 94, 92), (78, 101, 102)),
}
PDF_FIXED_TIME = "D:20260827000000Z"
RENDERER_ID = "pillow-noto-title-latency-poster/v1"


def _title_lines(title: str, style: str, font: Any, width: int) -> list[str]:
    if style == "three_line":
        words = title.split()
        first = max(1, len(words) // 3)
        second = max(first + 1, (2 * len(words)) // 3)
        return [" ".join(words[:first]), " ".join(words[first:second]), " ".join(words[second:])]
    return _wrap_pixels(title, font, int(width * (0.42 if style == "wrapped" else 0.82)))


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
    control_font = _font(17)
    y = 32
    for position, control in enumerate(case["top_controls"]):
        x = margin if position % 2 == 0 else max(margin, width - margin - _text_width(control_font, control))
        draw.text((x, y), control, font=control_font, fill=(94, 100, 102))
        y += 24

    if case.get("above_title_distractor"):
        distractor = case["above_title_distractor"]
        distractor_font = _font(34 if "crop_distractor" in case["tags"] else 26)
        draw.text(((width - _text_width(distractor_font, distractor)) / 2, max(y + 8, 104)), distractor, font=distractor_font, fill=(82, 90, 94))

    title_y = max(y + 18, round(height * float(case["title_top_ratio"])))
    poster_title = case.get("poster_title")
    title_mode = case["title_render_mode"]
    if title_mode != "absent" and poster_title:
        title_font = _font(int(case["title_font_size"]))
        lines = _title_lines(poster_title, case["title_style"], title_font, width)[:3]
        logo_width = 190 if case["title_style"] == "logo_side" else 0
        if logo_width:
            draw.rounded_rectangle((margin, title_y + 2, margin + 164, title_y + 86), radius=12, outline=accent, width=3)
            draw.text((margin + 18, title_y + 32), "LOCAL LAB", font=_font(19), fill=accent)
        for line in lines:
            line_width = _text_width(title_font, line)
            if case["title_style"] == "left":
                x = margin
            elif case["title_style"] == "right":
                x = width - margin - line_width
            elif case["title_style"] == "logo_side":
                x = margin + logo_width
            else:
                x = max(margin, (width - line_width) / 2)
            _draw_tracked_text(draw, (x, title_y), line, title_font, body_colour, int(case.get("title_tracking") or 0))
            title_y += round(title_font.size * 1.18)
    if case.get("competing_heading"):
        heading = case["competing_heading"]
        font = _font(48)
        competing_y = round(height * 0.27) if "ambiguous_title" in case["tags"] else title_y + 70
        draw.text(((width - _text_width(font, heading)) / 2, competing_y), heading, font=font, fill=accent)
    if case.get("subtitle"):
        subtitle = case["subtitle"]
        font = _font(22)
        draw.text(((width - _text_width(font, subtitle)) / 2, title_y + 6), subtitle, font=font, fill=(82, 90, 94))
        title_y += 36

    _draw_body(
        draw,
        case["column_sections"],
        top=max(round(height * 0.55), title_y + 48),
        width=width,
        body_colour=body_colour,
        accent=accent,
    )
    footer = "LOCAL EVIDENCE CARD  •  PAGE 1"
    footer_font = _font(17)
    draw.text(((width - _text_width(footer_font, footer)) / 2, height - 42), footer, font=footer_font, fill=(94, 100, 102))
    if case["noise"] == "mild":
        for _ in range(min(7000, width * height // 210)):
            draw.point(
                (randomizer.randrange(width), randomizer.randrange(height)),
                fill=randomizer.choice(((88, 88, 88), (188, 188, 188), (243, 243, 243))),
            )
    blur = float(case.get("blur_radius") or 0)
    return image.filter(ImageFilter.GaussianBlur(radius=blur)) if blur else image


def reference_text(case: dict[str, Any]) -> str:
    parts = [*case["top_controls"]]
    if case.get("above_title_distractor"):
        parts.append(case["above_title_distractor"])
    if case.get("poster_title") and case["title_render_mode"] != "absent":
        parts.append(case["poster_title"])
    for key in ("subtitle", "competing_heading"):
        if case.get(key):
            parts.append(case[key])
    for column in case["column_sections"]:
        for section in column:
            parts.extend([section["heading"], section["body"]])
    parts.append("LOCAL EVIDENCE CARD PAGE 1")
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
        raise ValueError(f"generated title-latency case exceeds worker byte bound: {case['id']}")


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
        "schema_version": "pp1-ocr-title-latency-generation/v1",
        "renderer_id": RENDERER_ID,
        "corpus_version": corpus["corpus_version"],
        "seed": corpus["seed"],
        "asset_count": len(records),
        "corpus_asset_sha256": digest.hexdigest(),
        "assets": sorted(records, key=lambda item: item["case_id"]),
    }
    (output_dir / "generation.json").write_bytes(canonical_json_bytes(result))
    return result
