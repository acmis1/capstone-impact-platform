from __future__ import annotations

import hashlib
import json
import random
import textwrap
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageEnhance, ImageFont

from .manifest import cases_of_kind, validate_manifest

MAX_GENERATED_FILE_BYTES = 20 * 1024 * 1024
QUALITY_DIMENSIONS = {
    "high": (1800, 1200),
    "ordinary": (1200, 800),
    "low": (700, 466),
    "invalid": (64, 64),
}


def _case_seed(corpus_seed: int, case_id: str) -> int:
    digest = hashlib.sha256(f"{corpus_seed}:{case_id}".encode()).digest()
    return int.from_bytes(digest[:8], "big")


def _font(size: int, *, bold: bool = False) -> ImageFont.ImageFont:
    candidates = (
        ["DejaVuSans-Bold.ttf", "arialbd.ttf"] if bold else ["DejaVuSans.ttf", "arial.ttf"]
    )
    for candidate in candidates:
        try:
            return ImageFont.truetype(candidate, size=size)
        except OSError:
            continue
    return ImageFont.load_default(size=size)


def _wrapped_lines(text: str, width: int) -> list[str]:
    lines: list[str] = []
    for paragraph in text.splitlines() or [""]:
        lines.extend(textwrap.wrap(paragraph, width=max(8, width), break_long_words=True) or [""])
    return lines


def _draw_poster(case: dict[str, Any], corpus_seed: int) -> Image.Image:
    width, height = QUALITY_DIMENSIONS[case["quality"]]
    if case["layout"] == "empty":
        return Image.new("RGB", (32, 32), "white")

    randomizer = random.Random(_case_seed(corpus_seed, case["id"]))
    coloured = "coloured_background" in case.get("tags", [])
    noisy = "noisy_background" in case.get("tags", [])
    background = (224, 238, 248) if coloured else (250, 250, 246)
    image = Image.new("RGB", (width, height), background)
    draw = ImageDraw.Draw(image)

    if coloured:
        draw.rectangle((0, 0, width, int(height * 0.22)), fill=(26, 76, 112))
        draw.rectangle((int(width * 0.52), int(height * 0.27), width - 40, height - 50), fill=(236, 207, 118))
    if noisy:
        for _ in range(min(12_000, width * height // 70)):
            x, y = randomizer.randrange(width), randomizer.randrange(height)
            shade = randomizer.choice([(25, 25, 25), (245, 245, 245), (120, 120, 120)])
            draw.point((x, y), fill=shade)

    title_size = max(24, width // 24)
    body_size = max(13, width // (100 if "small_body_text" in case.get("tags", []) else 78))
    title_font = _font(title_size, bold=True)
    body_font = _font(body_size)
    title_fill = "white" if coloured else (22, 38, 52)
    title_lines = _wrapped_lines(case["poster_title"], 34)
    title_y = max(20, height // 30)
    for line in title_lines:
        box = draw.textbbox((0, 0), line, font=title_font)
        x = max(20, (width - (box[2] - box[0])) // 2)
        draw.text((x, title_y), line, font=title_font, fill=title_fill)
        title_y += title_size + 10

    body = case["body"]
    if case.get("repeat_body", 1) > 1:
        body = " ".join(f"{body} segment {index}." for index in range(1, case["repeat_body"] + 1))
    content_top = max(int(height * 0.27), title_y + 25)
    margin = max(35, width // 25)
    layout = case["layout"]
    if layout == "multi_column":
        column_width = (width - margin * 3) // 2
        lines = _wrapped_lines(body, max(18, column_width // max(8, body_size // 2)))
        split = (len(lines) + 1) // 2
        for column, column_lines in enumerate((lines[:split], lines[split:])):
            x = margin + column * (column_width + margin)
            y = content_top
            for line in column_lines:
                draw.text((x, y), line, font=body_font, fill=(20, 27, 31))
                y += body_size + 6
    else:
        lines = _wrapped_lines(body, max(24, (width - 2 * margin) // max(8, body_size // 2)))
        y = content_top
        for line in lines[: max(1, (height - content_top - margin) // (body_size + 5))]:
            draw.text((margin, y), line, font=body_font, fill=(18, 25, 29))
            y += body_size + 5

    if layout == "table":
        top = int(height * 0.58)
        left, right, bottom = margin, width - margin, height - margin
        for row in range(5):
            y = top + row * max(1, (bottom - top) // 4)
            draw.line((left, y, right, y), fill=(30, 30, 30), width=2)
        for column in range(4):
            x = left + column * max(1, (right - left) // 3)
            draw.line((x, top, x, bottom), fill=(30, 30, 30), width=2)
    elif layout == "diagram":
        center_y = int(height * 0.67)
        nodes = [(int(width * 0.18), center_y), (int(width * 0.50), center_y), (int(width * 0.82), center_y)]
        for index, (x, y) in enumerate(nodes, start=1):
            radius = max(35, width // 30)
            draw.ellipse((x - radius, y - radius, x + radius, y + radius), outline=(21, 90, 120), width=5)
            draw.text((x - radius // 2, y - body_size // 2), f"Step {index}", font=body_font, fill=(20, 30, 40))
        draw.line((nodes[0][0] + width // 30, center_y, nodes[-1][0] - width // 30, center_y), fill=(21, 90, 120), width=5)

    if layout == "rotated":
        image = image.rotate(4.0, resample=Image.Resampling.BICUBIC, expand=False, fillcolor="white")
    elif layout == "skewed":
        skew = 0.035
        image = image.transform(
            image.size,
            Image.Transform.AFFINE,
            (1, skew, -skew * height / 2, 0, 1, 0),
            resample=Image.Resampling.BICUBIC,
            fillcolor="white",
        )
    if case["quality"] == "low":
        image = ImageEnhance.Contrast(image).enhance(1.35)
    return image


def _pdf_escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def _born_digital_pdf(case: dict[str, Any]) -> bytes:
    title_lines = case["poster_title"].splitlines() or [""]
    body_lines = _wrapped_lines(case["body"], 78)[:22]
    commands = ["BT", "/F1 24 Tf"]
    y = 540
    for line in title_lines:
        commands.extend([f"1 0 0 1 55 {y} Tm", f"({_pdf_escape(line)}) Tj"])
        y -= 34
    commands.append("/F1 11 Tf")
    y -= 20
    for line in body_lines:
        commands.extend([f"1 0 0 1 55 {y} Tm", f"({_pdf_escape(line)}) Tj"])
        y -= 18
    commands.append("ET")
    stream = "\n".join(commands).encode("ascii", errors="replace")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
    ]
    output = bytearray(b"%PDF-1.4\n%PP1 synthetic\n")
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


def _write_case(case: dict[str, Any], corpus_seed: int, destination: Path) -> None:
    target = destination / case["asset"]
    document_type = case["document_type"]
    if document_type == "born_digital_pdf":
        target.write_bytes(_born_digital_pdf(case))
    elif document_type == "corrupt_pdf":
        target.write_bytes(b"%PDF-1.4\n1 0 obj\n<< deliberately truncated synthetic fixture")
    elif document_type == "unsupported":
        target.write_text(case["body"], encoding="utf-8")
    else:
        image = _draw_poster(case, corpus_seed)
        if document_type == "scanned_pdf":
            fixed_time = "D:20260101000000Z"
            image.save(target, "PDF", resolution=150.0, creationDate=fixed_time, modDate=fixed_time)
        elif document_type == "png":
            image.save(target, "PNG", optimize=False)
        elif document_type == "jpeg":
            image.save(target, "JPEG", quality=78 if case["quality"] == "low" else 90, subsampling=1)
    if target.stat().st_size > MAX_GENERATED_FILE_BYTES:
        target.unlink(missing_ok=True)
        raise ValueError(f"generated fixture {case['id']} exceeded the {MAX_GENERATED_FILE_BYTES} byte limit")


def generate_corpus(manifest: dict[str, Any], output_dir: Path, *, seed: int | None = None) -> dict[str, Any]:
    validate_manifest(manifest)
    output_dir.mkdir(parents=True, exist_ok=True)
    corpus_seed = manifest["seed"] if seed is None else seed
    generated = []
    for case in cases_of_kind(manifest, "document"):
        _write_case(case, corpus_seed, output_dir)
        data = (output_dir / case["asset"]).read_bytes()
        generated.append({"case_id": case["id"], "asset": case["asset"], "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    generation = {
        "corpus_version": manifest["corpus_version"],
        "seed": corpus_seed,
        "document_count": len(generated),
        "assets": generated,
    }
    (output_dir / "generation.json").write_text(json.dumps(generation, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return generation
