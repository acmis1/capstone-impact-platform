from __future__ import annotations

import hashlib
import random
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw

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
    "high": ((248, 249, 246), (18, 30, 42), (25, 73, 102)),
    "low": ((222, 225, 221), (92, 96, 94), (83, 99, 101)),
}
PDF_FIXED_TIME = "D:20260826000000Z"


def _distractors(case: dict[str, Any], position: str) -> list[dict[str, str]]:
    return [item for item in case["distractors"] if item["position"] == position]


def _draw_sections(
    draw: ImageDraw.ImageDraw,
    sections: list[dict[str, str]],
    *,
    x: int,
    y: int,
    width: int,
    body_font: Any,
    heading_font: Any,
    body_colour: tuple[int, int, int],
    accent: tuple[int, int, int],
) -> int:
    body_size = body_font.size
    heading_size = heading_font.size
    for section in sections:
        draw.text((x, y), section["heading"], font=heading_font, fill=accent)
        y += round(heading_size * 1.45)
        for line in _wrap_pixels(section["body"], body_font, width):
            draw.text((x, y), line, font=body_font, fill=body_colour)
            y += round(body_size * 1.38)
        y += round(body_size * 0.8)
    return y


def draw_poster(case: dict[str, Any], seed: int) -> Image.Image:
    width, height = case["width"], case["height"]
    randomizer = random.Random(_case_seed(seed, case["id"]))
    background, body_colour, accent = PALETTES[case["contrast"]]
    image = Image.new("RGB", (width, height), background)
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, width, 18), fill=accent)
    margin = 54
    control_font = _font(17)
    distractor_font = _font(19)
    title_size = 58 if case["difficulty"] == "clean" else 54
    body_size = 17 if "small_body_text" in case["tags"] else 19
    title_font, body_font, heading_font = _font(title_size), _font(body_size), _font(body_size + 4)

    y = 31
    controls = case["top_controls"]
    for position, text in enumerate(controls):
        x = margin if position % 2 == 0 else max(margin, width - margin - _text_width(control_font, text))
        draw.text((x, y), text, font=control_font, fill=(92, 98, 102))
        y += 25
    for distractor in _distractors(case, "above"):
        draw.text((margin, y), distractor["text"], font=distractor_font, fill=(92, 98, 102))
        y += 28
    y += 8

    max_title_width = int(width * (0.68 if case["title_style"] in {"wrapped", "multiline"} else 0.88))
    title_lines = _wrap_pixels(case["title"], title_font, max_title_width, float(case["tracking_px"]))
    if case["title_style"] == "multiline" and len(title_lines) == 1:
        words = title_lines[0].split()
        midpoint = max(1, len(words) // 2)
        title_lines = [" ".join(words[:midpoint]), " ".join(words[midpoint:])]
    for line in title_lines[:3]:
        line_width = _text_width(title_font, line, float(case["tracking_px"]))
        x = max(margin, (width - line_width) / 2)
        if case["title_style"] == "shadow":
            _draw_tracked_text(draw, (x + 3, y + 3), line, title_font, (174, 178, 176), 0)
        _draw_tracked_text(draw, (x, y), line, title_font, body_colour, float(case["tracking_px"]))
        y += round(title_size * 1.18)
    for distractor in _distractors(case, "near"):
        y += 4
        text = distractor["text"]
        draw.text(((width - _text_width(distractor_font, text)) / 2, y), text, font=distractor_font, fill=(92, 98, 102))
        y += 28

    content_top = max(300, y + 34)
    columns = len(case["column_sections"])
    gap = 46
    column_width = (width - 2 * margin - gap * (columns - 1)) // columns
    column_bottoms = []
    for position, sections in enumerate(case["column_sections"]):
        x = margin + position * (column_width + gap)
        column_bottoms.append(
            _draw_sections(
                draw,
                sections,
                x=x,
                y=content_top,
                width=column_width,
                body_font=body_font,
                heading_font=heading_font,
                body_colour=body_colour,
                accent=accent,
            )
        )
    y = max(column_bottoms) + 10

    if case["feature"] != "none":
        draw.line((margin, y, width - margin, y), fill=accent, width=2)
        y += 10
        feature_font = _font(body_size + 1)
        draw.text((margin, y), case["feature_heading"], font=feature_font, fill=accent)
        y += round((body_size + 1) * 1.55)
        cell_width = column_width
        for position, text in enumerate(case["feature_items"]):
            x = margin + position * (column_width + gap)
            if case["feature"] == "table":
                draw.rectangle((x, y, x + cell_width - 8, y + 42), outline=accent, width=2)
            else:
                draw.rounded_rectangle((x, y, x + cell_width - 8, y + 42), radius=8, outline=accent, width=2)
            draw.text((x + 9, y + 9), text, font=body_font, fill=body_colour)
        y += 54
        draw.text((margin, y), case["feature_caption"], font=body_font, fill=body_colour)
        y += round(body_size * 1.8)

    for position, section in enumerate(case["closing_sections"]):
        x = margin + position * (column_width + gap)
        _draw_sections(
            draw,
            [section],
            x=x,
            y=y,
            width=column_width,
            body_font=body_font,
            heading_font=heading_font,
            body_colour=body_colour,
            accent=accent,
        )

    if case["noise"] == "mild":
        for _ in range(min(9000, width * height // 180)):
            draw.point(
                (randomizer.randrange(width), randomizer.randrange(height)),
                fill=randomizer.choice(((85, 85, 85), (185, 185, 185), (242, 242, 242))),
            )
    return image


def reference_text(case: dict[str, Any]) -> str:
    parts = [*case["top_controls"]]
    parts.extend(item["text"] for item in _distractors(case, "above"))
    parts.append(case["title"])
    parts.extend(item["text"] for item in _distractors(case, "near"))
    if case["feature"] == "none":
        for column, closing in zip(case["column_sections"], case["closing_sections"]):
            for section in column:
                parts.extend([section["heading"], section["body"]])
            parts.extend([closing["heading"], closing["body"]])
    else:
        for column in case["column_sections"]:
            for section in column:
                parts.extend([section["heading"], section["body"]])
        parts.extend([case["feature_heading"], *case["feature_items"], case["feature_caption"]])
        for section in case["closing_sections"]:
            parts.extend([section["heading"], section["body"]])
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
        raise ValueError(f"generated case exceeds worker byte bound: {case['id']}")


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
        "schema_version": "pp1-ocr-iteration3-generation/v1",
        "corpus_version": corpus["corpus_version"],
        "seed": corpus["seed"],
        "asset_count": len(records),
        "corpus_asset_sha256": digest.hexdigest(),
        "assets": sorted(records, key=lambda item: item["case_id"]),
    }
    (output_dir / "generation.json").write_bytes(canonical_json_bytes(result))
    return result
