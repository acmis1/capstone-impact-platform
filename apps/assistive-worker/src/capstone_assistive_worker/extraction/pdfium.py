from __future__ import annotations

from dataclasses import dataclass
from importlib import metadata

import pypdfium2 as pdfium

from ..contract import BoundingBox, ErrorCode, ExtractionSource, GeometryUnit, TextBlock
from ..security.errors import ExtractionFailure
from ..security.limits import ExtractionLimits
from .quality_gate import QualityAssessment, classify_native_text


@dataclass(frozen=True, slots=True)
class NativePdfExtraction:
    page_count: int
    text: str
    blocks: tuple[TextBlock, ...]
    quality: QualityAssessment
    pdfium_version: str


def _count_text_objects(page: pdfium.PdfPage, limit: int) -> int:
    count = 0
    for _ in page.get_objects(filter=[pdfium.raw.FPDF_PAGEOBJ_TEXT]):
        count += 1
        if count > limit:
            raise ExtractionFailure(
                ErrorCode.PDF_TEXT_OBJECT_LIMIT_EXCEEDED,
                "PDF text objects exceed the configured limit.",
            )
    return count


def _page_blocks(
    text_page: pdfium.PdfTextPage,
    *,
    page_number: int,
    page_height: float,
    remaining_blocks: int,
    maximum_block_characters: int,
) -> list[TextBlock]:
    rectangle_count = text_page.count_rects()
    if rectangle_count > remaining_blocks:
        raise ExtractionFailure(ErrorCode.TEXT_BLOCK_LIMIT_EXCEEDED, "PDF text blocks exceed the configured limit.")

    blocks: list[TextBlock] = []
    block_characters = 0
    previous: tuple[str, tuple[float, float, float, float]] | None = None
    for rectangle_index in range(rectangle_count):
        left, bottom, right, top = text_page.get_rect(rectangle_index)
        value = text_page.get_text_bounded(left, bottom, right, top, errors="replace").strip()
        if not value:
            continue
        identity = (value, (left, bottom, right, top))
        if identity == previous:
            continue
        previous = identity
        block_characters += len(value)
        if block_characters > maximum_block_characters:
            raise ExtractionFailure(
                ErrorCode.TEXT_CHARACTER_LIMIT_EXCEEDED,
                "PDF text block output exceeds the configured character limit.",
            )
        blocks.append(
            TextBlock(
                page_number=page_number,
                text=value,
                source=ExtractionSource.NATIVE_PDF,
                bounding_box=BoundingBox(
                    left=float(left),
                    top=float(page_height - top),
                    right=float(right),
                    bottom=float(page_height - bottom),
                    unit=GeometryUnit.PDF_POINTS_TOP_LEFT,
                ),
            )
        )
    return blocks


def extract_native_pdf(data: bytes, *, limits: ExtractionLimits) -> NativePdfExtraction:
    try:
        document = pdfium.PdfDocument(data)
    except Exception:
        raise ExtractionFailure(ErrorCode.CORRUPT_PDF, "PDF could not be opened by PDFium.") from None

    page_texts: list[str] = []
    blocks: list[TextBlock] = []
    total_characters = 0
    total_lines = 0
    total_block_characters = 0
    total_text_objects = 0
    try:
        page_count = len(document)
        if page_count < 1:
            raise ExtractionFailure(ErrorCode.PDF_PAGE_COUNT_INVALID, "PDF contains no pages.")
        if page_count > limits.max_pdf_pages:
            raise ExtractionFailure(
                ErrorCode.PDF_PAGE_LIMIT_EXCEEDED,
                "PDF page count exceeds the configured limit.",
            )

        for page_index in range(page_count):
            page = document[page_index]
            try:
                page_width, page_height = page.get_size()
                text_page = page.get_textpage()
                try:
                    character_count = text_page.count_chars()
                    if total_characters + character_count > limits.max_extracted_characters:
                        raise ExtractionFailure(
                            ErrorCode.TEXT_CHARACTER_LIMIT_EXCEEDED,
                            "Native PDF text exceeds the configured character limit.",
                        )
                    page_text = text_page.get_text_range(errors="replace")
                    total_characters += len(page_text)
                    if total_characters > limits.max_extracted_characters:
                        raise ExtractionFailure(
                            ErrorCode.TEXT_CHARACTER_LIMIT_EXCEEDED,
                            "Native PDF text exceeds the configured character limit.",
                        )
                    line_count = len([line for line in page_text.splitlines() if line.strip()])
                    total_lines += line_count
                    if total_lines > limits.max_text_lines:
                        raise ExtractionFailure(
                            ErrorCode.TEXT_LINE_LIMIT_EXCEEDED,
                            "Native PDF text lines exceed the configured limit.",
                        )
                    text_objects = _count_text_objects(
                        page,
                        limits.max_pdf_text_objects - total_text_objects,
                    )
                    total_text_objects += text_objects
                    page_blocks = _page_blocks(
                        text_page,
                        page_number=page_index + 1,
                        page_height=page_height,
                        remaining_blocks=limits.max_text_blocks - len(blocks),
                        maximum_block_characters=limits.max_extracted_characters - total_block_characters,
                    )
                    if page_text.strip() and not page_blocks:
                        page_blocks = [
                            TextBlock(
                                page_number=page_index + 1,
                                text=page_text.strip(),
                                source=ExtractionSource.NATIVE_PDF,
                                bounding_box=BoundingBox(
                                    left=0.0,
                                    top=0.0,
                                    right=float(page_width),
                                    bottom=float(page_height),
                                    unit=GeometryUnit.PDF_POINTS_TOP_LEFT,
                                ),
                            )
                        ]
                    total_block_characters += sum(len(block.text) for block in page_blocks)
                    if total_block_characters > limits.max_extracted_characters:
                        raise ExtractionFailure(
                            ErrorCode.TEXT_CHARACTER_LIMIT_EXCEEDED,
                            "PDF text block output exceeds the configured character limit.",
                        )
                    blocks.extend(page_blocks)
                    if len(blocks) > limits.max_text_blocks:
                        raise ExtractionFailure(
                            ErrorCode.TEXT_BLOCK_LIMIT_EXCEEDED,
                            "Native PDF text blocks exceed the configured limit.",
                        )
                    page_texts.append(page_text)
                finally:
                    text_page.close()
            finally:
                page.close()
    except ExtractionFailure:
        raise
    except Exception:
        raise ExtractionFailure(ErrorCode.CORRUPT_PDF, "PDF native extraction failed safely.") from None
    finally:
        document.close()

    text = "\n".join(page_texts)
    quality = classify_native_text(text, text_object_count=total_text_objects)
    return NativePdfExtraction(
        page_count=page_count,
        text=text,
        blocks=tuple(blocks),
        quality=quality,
        pdfium_version=metadata.version("pypdfium2"),
    )
