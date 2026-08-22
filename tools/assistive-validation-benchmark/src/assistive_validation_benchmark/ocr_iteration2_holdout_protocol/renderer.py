"""The frozen canonical renderer for the future Iteration 2 fresh holdout.

This module is content-free. It contains the drawing algorithm and a tiny synthetic
reference fixture, never a holdout case. Freezing it here is what stops a later branch from
quietly reshaping how holdout pages look after seeing a result.

Two things differ from the merged Iteration 2 calibration renderer, and both are deliberate:

* an upper-page distractor band is drawn *above* and *beside* the project title, so the
  frozen metadata-blind selector faces a real generalisation test instead of a corpus where
  the title is always the first textual region;
* the reference fixture exists purely to prove the renderer environment. It is explicitly
  unscored, is never part of any corpus and never reaches OCR.

Everything else reuses the reviewed calibration primitives (pinned font, visual-only glyph
tracking, unstroked titles, wrapping, shadow, noise, native-PDF control writer and the
180 DPI / 1920-pixel raster adapter) rather than re-implementing them.
"""

from __future__ import annotations

import hashlib
import io
import random
from pathlib import Path
from typing import Any

import pypdfium2 as pdfium
from PIL import Image, ImageDraw

from ..ocr_iteration2_calibration.corpus import (
    MAX_GENERATED_FILE_BYTES,
    SECTION_HEADINGS,
    _case_seed,
    _draw_tracked_text,
    _font,
    _native_pdf,
    _section_columns,
    _text_width,
    _wrap_pixels,
)
from .schema import canonical_json_bytes, file_sha256


CONTRAST_PALETTES = {
    "high": ((248, 249, 246), (18, 30, 42), (25, 73, 102)),
    "medium": ((232, 237, 235), (48, 57, 61), (67, 94, 105)),
    "low": ((218, 222, 218), (105, 109, 106), (96, 106, 107)),
}
DISTRACTOR_COLOUR = (92, 98, 102)
PDF_FIXED_TIME = "D:20260823000000Z"

# A tiny, explicitly non-scored synthetic probe. Its only purpose is to prove that the
# renderer environment produces the frozen pixels. It carries no project meaning, is not a
# corpus case and never reaches an OCR engine.
REFERENCE_FIXTURE: dict[str, Any] = {
    "id": "pp1-renderer-reference-fixture",
    "role": "renderer_environment_proof",
    "scored": False,
    "holdout_content": False,
    "reaches_ocr": False,
    "width": 360,
    "height": 150,
    "background": [250, 250, 248],
    "title": "Reference Fixture",
    "title_size": 34,
    "title_tracking_px": 1.5,
    "body": "canonical renderer probe — café ‘sensor’ – CO₂ 180/1920",
    "body_size": 13,
    "jpeg_quality": 82,
    "pdf_dpi": 180,
}


def render_reference_fixture() -> Image.Image:
    """Draw the frozen reference fixture with the pinned font and no system-font fallback."""
    spec = REFERENCE_FIXTURE
    image = Image.new("RGB", (spec["width"], spec["height"]), tuple(spec["background"]))
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, spec["width"], 6), fill=(25, 73, 102))
    _draw_tracked_text(
        draw,
        (14, 22),
        spec["title"],
        _font(spec["title_size"]),
        (18, 30, 42),
        float(spec["title_tracking_px"]),
    )
    draw.text((14, 78), spec["body"], font=_font(spec["body_size"]), fill=(60, 60, 60))
    draw.text((14, 104), "0123456789 AUS ISO/IEC (draft) v2.1", font=_font(spec["body_size"]), fill=(60, 60, 60))
    return image


def _pdf_bytes(image: Image.Image, dpi: int) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PDF", resolution=float(dpi), creationDate=PDF_FIXED_TIME, modDate=PDF_FIXED_TIME)
    return buffer.getvalue()


def _pdf_raster_bytes(pdf: bytes, dpi: int) -> bytes:
    document = pdfium.PdfDocument(pdf)
    try:
        page = document[0]
        try:
            bitmap = page.render(scale=dpi / 72.0, rotation=0)
            try:
                rendered = bitmap.to_pil().convert("RGB")
                try:
                    return rendered.tobytes()
                finally:
                    rendered.close()
            finally:
                bitmap.close()
        finally:
            page.close()
    finally:
        document.close()


def reference_digests() -> dict[str, Any]:
    """Measure the reference fixture at the pixel level, plus encoded bytes as attestation.

    The *binding* digests are decoded-pixel digests, because decoded pixels are what an OCR
    engine actually consumes. Encoded byte digests are recorded as attestation only: a
    compressor whose optimised code path differs between CPUs can emit different valid bytes
    for identical pixels, and refusing a holdout run for that would be a false alarm.
    """
    spec = REFERENCE_FIXTURE
    image = render_reference_fixture()
    try:
        raw = image.tobytes()
        png = io.BytesIO()
        image.save(png, format="PNG", optimize=False, compress_level=6)
        jpeg = io.BytesIO()
        image.save(jpeg, format="JPEG", quality=spec["jpeg_quality"], subsampling=1, optimize=False)
        pdf = _pdf_bytes(image, spec["pdf_dpi"])
        with Image.open(io.BytesIO(png.getvalue())) as decoded_png:
            png_raster = decoded_png.convert("RGB").tobytes()
        with Image.open(io.BytesIO(jpeg.getvalue())) as decoded_jpeg:
            jpeg_raster = decoded_jpeg.convert("RGB").tobytes()
        pdf_raster = _pdf_raster_bytes(pdf, spec["pdf_dpi"])
    finally:
        image.close()
    return {
        "fixture_id": spec["id"],
        "scored": False,
        "image_size": [spec["width"], spec["height"]],
        "image_mode": "RGB",
        "binding": {
            "glyph_raster_sha256": hashlib.sha256(raw).hexdigest(),
            "png_roundtrip_raster_sha256": hashlib.sha256(png_raster).hexdigest(),
            "jpeg_roundtrip_raster_sha256": hashlib.sha256(jpeg_raster).hexdigest(),
            "pdf_raster_sha256": hashlib.sha256(pdf_raster).hexdigest(),
        },
        "attestation": {
            "png_bytes_sha256": hashlib.sha256(png.getvalue()).hexdigest(),
            "jpeg_bytes_sha256": hashlib.sha256(jpeg.getvalue()).hexdigest(),
            "pdf_bytes_sha256": hashlib.sha256(pdf).hexdigest(),
        },
    }


def _distractors(case: dict[str, Any], position: str) -> list[dict[str, Any]]:
    return [item for item in case.get("distractors", []) if item.get("position") == position]


def draw_holdout_poster(case: dict[str, Any], seed: int, *, force_tracking_zero: bool = False) -> Image.Image:
    """Draw one holdout poster: upper-page distractors, then the title, then body columns.

    ``force_tracking_zero`` renders the identical semantic strings without visual tracking so
    a test can prove that tracking changes pixels only.
    """
    width, height = case["width"], case["height"]
    randomizer = random.Random(_case_seed(seed, case["id"]))
    background, body_colour, accent = CONTRAST_PALETTES[case["contrast"]]
    image = Image.new("RGB", (width, height), background)
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, width, max(8, height // 55)), fill=accent)

    title_size = max(32, width // (23 if case["difficulty"] == "clean" else 27))
    small = "small_body_text" in case["tags"]
    body_size = max(11 if small else 14, width // (135 if small else 105))
    heading_size = max(body_size + 3, round(body_size * 1.22))
    distractor_size = max(body_size + 1, round(title_size * 0.34))
    title_font, body_font, heading_font = _font(title_size), _font(body_size), _font(heading_size)
    distractor_font = _font(distractor_size)
    margin = max(32, width // 28)

    y = max(24, height // 34)
    for distractor in _distractors(case, "above"):
        text = str(distractor["text"])
        text_width = _text_width(distractor_font, text)
        centred = randomizer.random() < 0.5
        x = max(margin, (width - text_width) / 2) if centred else margin
        draw.text((x, y), text, font=distractor_font, fill=DISTRACTOR_COLOUR)
        y += round(distractor_size * 1.5)
    y += round(distractor_size * 0.6) if _distractors(case, "above") else 0

    tracking = 0 if force_tracking_zero else float(case["tracking_px"])
    max_title_width = int(width * (0.72 if case["title_style"] == "wrapped" else 0.88))
    line_height = round(title_size * 1.22)
    for line in _wrap_pixels(case["title"], title_font, max_title_width, tracking)[:3]:
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

    near = _distractors(case, "near")
    if near:
        y += round(title_size * 0.28)
        for distractor in near:
            text = str(distractor["text"])
            text_width = _text_width(distractor_font, text)
            draw.text((max(margin, (width - text_width) / 2), y), text, font=distractor_font, fill=DISTRACTOR_COLOUR)
            y += round(distractor_size * 1.45)

    content_top = max(y + 2 * body_size, int(height * 0.30))
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
            point = (randomizer.randrange(width), randomizer.randrange(height))
            draw.point(point, fill=randomizer.choice(((85, 85, 85), (185, 185, 185), (242, 242, 242))))
    return image


def render_tracking_pair(case: dict[str, Any], seed: int) -> tuple[Image.Image, Image.Image]:
    if case["title_style"] != "tracked":
        raise ValueError("tracking probe requires a visually tracked title case")
    return draw_holdout_poster(case, seed), draw_holdout_poster(case, seed, force_tracking_zero=True)


def reference_text(case: dict[str, Any]) -> str:
    """Whole-page reference text for WER.

    Upper-page distractors are rendered pixels and are deliberately *not* reference text: the
    holdout measures recovery of the project title and body, and crediting a distractor would
    reward the very header noise the generalisation test introduces.
    """
    parts = [case["title"]]
    for heading, section in zip(SECTION_HEADINGS, case["body_sections"]):
        parts.extend([heading, section])
    return "\n".join(parts)


def _write_case_asset(case: dict[str, Any], seed: int, target: Path) -> None:
    image = draw_holdout_poster(case, seed)
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
        raise ValueError(f"generated case exceeds the worker byte bound: {case['id']}")


def generate_holdout_assets(corpus: dict[str, Any], output_dir: Path) -> dict[str, Any]:
    """Render every holdout asset. The canonical renderer guard runs before any pixel is drawn.

    This is the entry point the future Iteration 2B3 branch must call. It refuses to run
    outside the frozen canonical renderer environment, so a holdout cannot be generated on an
    unattested toolchain and then presented as reproducible evidence.
    """
    from .fingerprint import require_canonical_renderer

    fingerprint = require_canonical_renderer()
    output_dir.mkdir(parents=True, exist_ok=True)
    records: list[dict[str, Any]] = []
    for case in corpus["ocr_cases"]:
        target = output_dir / case["asset"]
        _write_case_asset(case, corpus["seed"], target)
        records.append(
            {
                "case_id": case["id"],
                "asset": case["asset"],
                "bytes": target.stat().st_size,
                "sha256": file_sha256(target),
            }
        )
    for control in corpus["native_controls"]:
        target = output_dir / control["asset"]
        target.write_bytes(_native_pdf(control))
        records.append(
            {
                "case_id": control["id"],
                "asset": control["asset"],
                "bytes": target.stat().st_size,
                "sha256": file_sha256(target),
            }
        )
    for control in corpus["security_controls"]:
        target = output_dir / control["asset"]
        payload = (
            b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\n"
            if control["kind"] == "malformed_pdf"
            else b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
        )
        target.write_bytes(payload)
        records.append(
            {
                "case_id": control["id"],
                "asset": control["asset"],
                "bytes": target.stat().st_size,
                "sha256": file_sha256(target),
            }
        )
    digest = hashlib.sha256()
    for record in sorted(records, key=lambda item: item["case_id"]):
        digest.update(record["case_id"].encode("utf-8"))
        digest.update(b"\0")
        digest.update(bytes.fromhex(record["sha256"]))
    result = {
        "schema_version": "pp1-ocr-iteration2-holdout-generated-corpus/v1",
        "corpus_version": corpus["corpus_version"],
        "seed": corpus["seed"],
        "asset_count": len(records),
        "corpus_asset_sha256": digest.hexdigest(),
        "renderer_fingerprint_sha256": fingerprint["fingerprint_sha256"],
        "assets": sorted(records, key=lambda item: item["case_id"]),
    }
    (output_dir / "generation.json").write_bytes(canonical_json_bytes(result))
    return result
