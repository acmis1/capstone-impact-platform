from __future__ import annotations

import hashlib
import io
import json
import random
import textwrap
from pathlib import Path
from typing import Any

import pypdfium2 as pdfium
from PIL import Image, ImageDraw, ImageFont

from .schema import canonical_json_bytes, file_sha256


MAX_GENERATED_FILE_BYTES = 20 * 1024 * 1024


def _case_seed(seed: int, case_id: str) -> int:
    return int.from_bytes(hashlib.sha256(f"{seed}:{case_id}".encode()).digest()[:8], "big")


def _font(size: int) -> ImageFont.ImageFont:
    # Pillow's bundled font avoids platform font substitution, keeping generation byte-stable.
    return ImageFont.load_default(size=size)


def _wrap_pixels(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont, width: int) -> list[str]:
    words = text.split()
    lines: list[str] = []
    current: list[str] = []
    for word in words:
        candidate = " ".join(current + [word])
        box = draw.textbbox((0, 0), candidate, font=font)
        if current and box[2] - box[0] > width:
            lines.append(" ".join(current))
            current = [word]
        else:
            current.append(word)
    if current:
        lines.append(" ".join(current))
    return lines


def _title_lines(draw: ImageDraw.ImageDraw, case: dict[str, Any], font: ImageFont.ImageFont, width: int) -> list[str]:
    title = case["title"]
    if case["title_style"] == "letterspaced":
        title = "  ".join(title)
    max_width = int(width * (0.72 if case["title_style"] == "wrapped" else 0.86))
    return _wrap_pixels(draw, title, font, max_width)[:3]


def _draw_poster(case: dict[str, Any], seed: int) -> Image.Image:
    width, height = case["width"], case["height"]
    randomizer = random.Random(_case_seed(seed, case["id"]))
    palettes = {
        "high": ((248, 249, 246), (18, 30, 42), (25, 73, 102)),
        "medium": ((232, 237, 235), (48, 57, 61), (67, 94, 105)),
        "low": ((218, 222, 218), (112, 116, 112), (101, 112, 113)),
    }
    background, body_colour, accent = palettes[case["contrast"]]
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
        box = draw.textbbox((0, 0), line, font=title_font, stroke_width=1)
        x = max(20, (width - (box[2] - box[0])) // 2)
        if case["title_style"] == "decorative":
            draw.text((x + 3, y + 3), line, font=title_font, fill=(175, 180, 178), stroke_width=1)
        draw.text((x, y), line, font=title_font, fill=body_colour, stroke_width=1, stroke_fill=body_colour)
        y += line_height

    # Keep the title group visually separate so the production adjacent-line grouper cannot
    # accidentally combine the first body line into a title candidate.
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


def _pdf_ascii(text: str) -> str:
    return (
        text.replace("—", "-")
        .replace("–", "-")
        .replace("’", "'")
        .replace("‘", "'")
        .replace("“", '"')
        .replace("”", '"')
        .replace("₂", "2")
    )


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
    output = bytearray(b"%PDF-1.4\n%PP1 synthetic OCR control\n")
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


def _security_payload(control: dict[str, Any]) -> bytes:
    if control["kind"] == "malformed_pdf":
        return b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\n"
    if control["kind"] == "truncated_png":
        return b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
    raise ValueError("unsupported security control kind")


def generate_assets(manifest: dict[str, Any], output_dir: Path) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    cases: list[dict[str, Any]] = []
    controls: list[dict[str, Any]] = []
    security_controls: list[dict[str, Any]] = []
    for part in (manifest["calibration"], manifest.get("holdout")):
        if part:
            cases.extend(part["ocr_cases"])
            controls.extend(part["native_controls"])
            security_controls.extend(part.get("security_controls", []))
    records = []
    for case in cases:
        target = output_dir / case["asset"]
        image = _draw_poster(case, manifest["seed"])
        if case["media"] == "png":
            image.save(target, format="PNG", optimize=False, compress_level=6)
        elif case["media"] == "jpeg":
            image.save(target, format="JPEG", quality=case["jpeg_quality"], subsampling=1, optimize=False)
        else:
            fixed_time = "D:20260821000000Z"
            image.save(target, format="PDF", resolution=180.0, creationDate=fixed_time, modDate=fixed_time)
        image.close()
        if target.stat().st_size > MAX_GENERATED_FILE_BYTES:
            raise ValueError(f"generated OCR case exceeds the worker byte bound: {case['id']}")
        records.append({"case_id": case["id"], "asset": case["asset"], "bytes": target.stat().st_size, "sha256": file_sha256(target)})
    for control in controls:
        target = output_dir / control["asset"]
        target.write_bytes(_native_pdf(control))
        records.append({"case_id": control["id"], "asset": control["asset"], "bytes": target.stat().st_size, "sha256": file_sha256(target)})
    for control in security_controls:
        target = output_dir / control["asset"]
        target.write_bytes(_security_payload(control))
        records.append({"case_id": control["id"], "asset": control["asset"], "bytes": target.stat().st_size, "sha256": file_sha256(target)})
    digest = hashlib.sha256()
    for record in sorted(records, key=lambda item: item["case_id"]):
        digest.update(record["case_id"].encode())
        digest.update(b"\0")
        digest.update(bytes.fromhex(record["sha256"]))
    result = {
        "schema_version": "pp1-ocr-generated-corpus/v1",
        "corpus_version": manifest["corpus_version"],
        "seed": manifest["seed"],
        "asset_count": len(records),
        "corpus_asset_sha256": digest.hexdigest(),
        "assets": sorted(records, key=lambda item: item["case_id"]),
    }
    (output_dir / "generation.json").write_bytes(canonical_json_bytes(result))
    return result


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
