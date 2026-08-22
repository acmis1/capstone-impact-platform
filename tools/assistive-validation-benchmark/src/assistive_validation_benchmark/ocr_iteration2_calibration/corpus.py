from __future__ import annotations

import hashlib
import io
import random
import textwrap
from pathlib import Path
from typing import Any

import pypdfium2 as pdfium
from PIL import Image, ImageDraw, ImageFont

from .schema import canonical_json_bytes, data_root, file_sha256


MAX_GENERATED_FILE_BYTES = 20 * 1024 * 1024
SECTION_HEADINGS = ("BACKGROUND", "METHOD", "EVIDENCE")


def _case_seed(seed: int, case_id: str) -> int:
    return int.from_bytes(hashlib.sha256(f"{seed}:{case_id}".encode()).digest()[:8], "big")


def _font(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(data_root() / "font" / "NotoSans-Regular.ttf"), size=size)


def _text_width(font: ImageFont.FreeTypeFont, text: str, tracking: float = 0) -> float:
    return float(font.getlength(text)) + max(0, len(text) - 1) * tracking


def _wrap_pixels(text: str, font: ImageFont.FreeTypeFont, width: int, tracking: float = 0) -> list[str]:
    lines: list[str] = []
    current: list[str] = []
    for word in text.split():
        candidate = " ".join([*current, word])
        if current and _text_width(font, candidate, tracking) > width:
            lines.append(" ".join(current))
            current = [word]
        else:
            current.append(word)
    if current:
        lines.append(" ".join(current))
    return lines


def _draw_tracked_text(
    draw: ImageDraw.ImageDraw,
    position: tuple[float, float],
    text: str,
    font: ImageFont.FreeTypeFont,
    fill: tuple[int, int, int],
    tracking: float,
    *,
    stroke_width: int = 0,
    stroke_fill: tuple[int, int, int] | None = None,
) -> None:
    x, y = position
    for character in text:
        draw.text(
            (round(x, 3), y),
            character,
            font=font,
            fill=fill,
            stroke_width=stroke_width,
            stroke_fill=stroke_fill,
        )
        x += float(font.getlength(character)) + tracking


def _section_columns(sections: list[str], columns: int) -> list[list[tuple[str, str]]]:
    base, remainder = divmod(len(sections), columns)
    groups: list[list[tuple[str, str]]] = []
    offset = 0
    for column in range(columns):
        count = base + (1 if column < remainder else 0)
        groups.append([(SECTION_HEADINGS[index], sections[index]) for index in range(offset, offset + count)])
        offset += count
    return groups


def reference_text(case: dict[str, Any]) -> str:
    parts = [case["title"]]
    for heading, section in zip(SECTION_HEADINGS, case["body_sections"]):
        parts.extend([heading, section])
    return "\n".join(parts)


def _draw_poster(case: dict[str, Any], seed: int, *, force_tracking_zero: bool = False) -> Image.Image:
    width, height = case["width"], case["height"]
    randomizer = random.Random(_case_seed(seed, case["id"]))
    palettes = {
        "high": ((248, 249, 246), (18, 30, 42), (25, 73, 102)),
        "medium": ((232, 237, 235), (48, 57, 61), (67, 94, 105)),
        "low": ((218, 222, 218), (105, 109, 106), (96, 106, 107)),
    }
    background, body_colour, accent = palettes[case["contrast"]]
    image = Image.new("RGB", (width, height), background)
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, width, max(8, height // 55)), fill=accent)

    title_size = max(32, width // (23 if case["difficulty"] == "clean" else 27))
    body_size = max(11 if "small_body_text" in case["tags"] else 14, width // (135 if "small_body_text" in case["tags"] else 105))
    heading_size = max(body_size + 3, round(body_size * 1.22))
    title_font, body_font, heading_font = _font(title_size), _font(body_size), _font(heading_size)
    tracking = 0 if force_tracking_zero else float(case["tracking_px"])
    max_width = int(width * (0.72 if case["title_style"] == "wrapped" else 0.88))
    lines = _wrap_pixels(case["title"], title_font, max_width, tracking)[:3]
    y = max(28, height // 28)
    line_height = round(title_size * 1.22)
    for line in lines:
        line_width = _text_width(title_font, line, tracking)
        x = max(20, (width - line_width) / 2)
        if case["title_style"] == "shadow":
            _draw_tracked_text(draw, (x + 3, y + 3), line, title_font, (170, 176, 174), tracking)
        stroke_width = 1 if case["title_style"] == "outlined" else 0
        _draw_tracked_text(
            draw,
            (x, y),
            line,
            title_font,
            body_colour,
            tracking,
            stroke_width=stroke_width,
            stroke_fill=accent if stroke_width else None,
        )
        y += line_height

    content_top = max(y + 3 * body_size, int(height * 0.30))
    margin = max(32, width // 28)
    columns = {"one_column": 1, "two_column": 2, "three_column": 3}[case["layout"]]
    gap = max(26, width // 34)
    column_width = (width - 2 * margin - gap * (columns - 1)) // columns
    for column, sections in enumerate(_section_columns(case["body_sections"], columns)):
        x = margin + column * (column_width + gap)
        column_y = content_top
        for heading, text in sections:
            draw.text((x, column_y), heading, font=heading_font, fill=accent)
            column_y += round(heading_size * 1.55)
            for line in _wrap_pixels(text, body_font, column_width):
                draw.text((x, column_y), line, font=body_font, fill=body_colour)
                column_y += round(body_size * 1.42)
            column_y += round(body_size * 1.2)

    if case["noise"] == "mild":
        for _ in range(min(9000, width * height // 180)):
            x, y = randomizer.randrange(width), randomizer.randrange(height)
            draw.point((x, y), fill=randomizer.choice(((85, 85, 85), (185, 185, 185), (242, 242, 242))))
    return image


def render_tracking_pair(case: dict[str, Any], seed: int) -> tuple[Image.Image, Image.Image]:
    if case["title_style"] != "tracked":
        raise ValueError("tracking probe requires a visually tracked title case")
    return _draw_poster(case, seed), _draw_poster(case, seed, force_tracking_zero=True)


def _pdf_ascii(text: str) -> str:
    return text.replace("—", "-").replace("–", "-").replace("’", "'").replace("₂", "2")


def _pdf_escape(text: str) -> str:
    return _pdf_ascii(text).replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def _native_pdf(control: dict[str, Any]) -> bytes:
    title_lines = textwrap.wrap(_pdf_ascii(control["title"]), width=48) or [""]
    body_lines = textwrap.wrap(_pdf_ascii(control["body"]), width=56)
    commands = ["BT", "/F1 25 Tf"]
    y = 535
    for line in title_lines:
        commands.extend([f"1 0 0 1 55 {y} Tm", f"({_pdf_escape(line)}) Tj"])
        y -= 34
    commands.append("/F1 12 Tf")
    y -= 35
    columns = {"one_column": 1, "two_column": 2, "three_column": 3}[control["layout"]]
    per_column = (len(body_lines) + columns - 1) // columns
    for column in range(columns):
        x = 55 + column * (730 // columns)
        column_y = y
        for line in body_lines[column * per_column : (column + 1) * per_column]:
            commands.extend([f"1 0 0 1 {x} {column_y} Tm", f"({_pdf_escape(line)}) Tj"])
            column_y -= 19
    commands.append("ET")
    stream = "\n".join(commands).encode("ascii")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
    ]
    output = bytearray(b"%PDF-1.4\n%PP1 synthetic OCR v2 native control\n")
    offsets = [0]
    for number, obj in enumerate(objects, start=1):
        offsets.append(len(output))
        output.extend(f"{number} 0 obj\n".encode())
        output.extend(obj)
        output.extend(b"\nendobj\n")
    xref = len(output)
    output.extend(f"xref\n0 {len(objects) + 1}\n".encode())
    output.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        output.extend(f"{offset:010d} 00000 n \n".encode())
    output.extend(f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return bytes(output)


def generate_assets(corpus: dict[str, Any], output_dir: Path) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    records: list[dict[str, Any]] = []
    for case in corpus["ocr_cases"]:
        target = output_dir / case["asset"]
        image = _draw_poster(case, corpus["seed"])
        if case["media"] == "png":
            image.save(target, format="PNG", optimize=False, compress_level=6)
        elif case["media"] == "jpeg":
            image.save(target, format="JPEG", quality=case["jpeg_quality"], subsampling=1, optimize=False)
        else:
            fixed_time = "D:20260822000000Z"
            image.save(target, format="PDF", resolution=180.0, creationDate=fixed_time, modDate=fixed_time)
        image.close()
        if target.stat().st_size > MAX_GENERATED_FILE_BYTES:
            raise ValueError(f"generated case exceeds the worker byte bound: {case['id']}")
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
        digest.update(record["case_id"].encode())
        digest.update(b"\0")
        digest.update(bytes.fromhex(record["sha256"]))
    result = {
        "schema_version": "pp1-ocr-iteration2-generated-corpus/v1",
        "corpus_version": corpus["corpus_version"],
        "seed": corpus["seed"],
        "asset_count": len(records),
        "corpus_asset_sha256": digest.hexdigest(),
        "assets": sorted(records, key=lambda item: item["case_id"]),
    }
    (output_dir / "generation.json").write_bytes(canonical_json_bytes(result))
    return result


def evaluate_controls(corpus: dict[str, Any], assets_dir: Path) -> dict[str, Any]:
    native_records = []
    for control in corpus["native_controls"]:
        document = pdfium.PdfDocument(str(assets_dir / control["asset"]))
        try:
            page = document[0]
            try:
                text_page = page.get_textpage()
                try:
                    text = " ".join(text_page.get_text_range().split())
                finally:
                    text_page.close()
            finally:
                page.close()
        finally:
            document.close()
        title_recovered = control["title"] in text
        if not title_recovered:
            raise ValueError(f"native PDF control did not recover its title: {control['id']}")
        native_records.append({"case_id": control["id"], "title_recovered": True, "extracted_characters": len(text)})
    security_records = []
    for control in corpus["security_controls"]:
        try:
            if control["kind"] == "malformed_pdf":
                document = pdfium.PdfDocument(str(assets_dir / control["asset"]))
                document.close()
            else:
                with Image.open(assets_dir / control["asset"]) as image:
                    image.load()
        except Exception as error:
            security_records.append({"case_id": control["id"], "failed_safely": True, "error_type": type(error).__name__})
        else:
            raise ValueError(f"malformed/security control was unexpectedly accepted: {control['id']}")
    return {
        "native_pdf_controls": native_records,
        "native_pdf_title_recovery_rate": sum(record["title_recovered"] for record in native_records) / len(native_records),
        "security_controls": security_records,
        "security_controls_failed_safely": all(record["failed_safely"] for record in security_records),
    }


def raster_path(
    case: dict[str, Any],
    assets_dir: Path,
    rendered_dir: Path,
    dpi: int,
    max_input_dimension: int,
) -> Path:
    source = assets_dir / case["asset"]
    rendered_dir.mkdir(parents=True, exist_ok=True)
    target = rendered_dir / f"{case['id']}.png"
    if target.is_file():
        return target
    if case["media"] == "scanned_pdf":
        document = pdfium.PdfDocument(str(source))
        try:
            if len(document) != 1:
                raise ValueError("synthetic scanned PDF must contain exactly one page")
            page = document[0]
            try:
                bitmap = page.render(scale=dpi / 72.0, rotation=0)
                try:
                    image = bitmap.to_pil().convert("RGB")
                finally:
                    bitmap.close()
            finally:
                page.close()
        finally:
            document.close()
    else:
        with Image.open(source) as decoded:
            image = decoded.convert("RGB")
    longest = max(image.size)
    if longest > max_input_dimension:
        scale = max_input_dimension / longest
        resized = image.resize(
            (max(1, round(image.width * scale)), max(1, round(image.height * scale))),
            resample=Image.Resampling.LANCZOS,
        )
        image.close()
        image = resized
    image.save(target, format="PNG", optimize=False, compress_level=6)
    image.close()
    return target
