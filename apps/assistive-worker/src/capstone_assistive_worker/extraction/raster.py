from __future__ import annotations

import io
import math
from dataclasses import dataclass
from typing import Iterator

import pypdfium2 as pdfium

from ..contract import ErrorCode
from ..security.errors import ExtractionFailure
from ..security.limits import ExtractionLimits


@dataclass(frozen=True, slots=True)
class RasterPage:
    page_number: int
    width: int
    height: int
    dpi: int
    color_mode: str
    png_bytes: bytes


def iter_pdf_rasters(
    data: bytes,
    *,
    limits: ExtractionLimits,
    dpi: int | None = None,
) -> Iterator[RasterPage]:
    selected_dpi = limits.default_raster_dpi if dpi is None else dpi
    if not limits.min_raster_dpi <= selected_dpi <= limits.max_raster_dpi:
        raise ExtractionFailure(ErrorCode.RASTER_DPI_OUT_OF_RANGE, "Raster DPI is outside the configured range.")

    try:
        document = pdfium.PdfDocument(data)
    except Exception:
        raise ExtractionFailure(ErrorCode.CORRUPT_PDF, "PDF could not be opened for rasterization.") from None

    scale = selected_dpi / 72.0
    total_pixels = 0
    try:
        page_count = len(document)
        if page_count < 1:
            raise ExtractionFailure(ErrorCode.PDF_PAGE_COUNT_INVALID, "PDF contains no pages.")
        if page_count > limits.max_pdf_pages:
            raise ExtractionFailure(ErrorCode.PDF_PAGE_LIMIT_EXCEEDED, "PDF page count exceeds the configured limit.")

        dimensions: list[tuple[int, int]] = []
        for page_index in range(page_count):
            page = document[page_index]
            try:
                width_points, height_points = page.get_size()
            finally:
                page.close()
            width = math.ceil(width_points * scale)
            height = math.ceil(height_points * scale)
            if width > limits.max_raster_width or height > limits.max_raster_height:
                raise ExtractionFailure(
                    ErrorCode.RASTER_DIMENSIONS_EXCEEDED,
                    "Raster dimensions exceed the configured per-page limit.",
                )
            pixels = width * height
            if pixels > limits.max_raster_pixels_per_page:
                raise ExtractionFailure(
                    ErrorCode.RASTER_PIXELS_EXCEEDED,
                    "Raster pixels exceed the configured per-page limit.",
                )
            total_pixels += pixels
            if total_pixels > limits.max_total_raster_pixels:
                raise ExtractionFailure(
                    ErrorCode.RASTER_TOTAL_PIXELS_EXCEEDED,
                    "Total raster pixels exceed the configured document limit.",
                )
            dimensions.append((width, height))

        for page_index, (expected_width, expected_height) in enumerate(dimensions):
            page = document[page_index]
            try:
                bitmap = page.render(scale=scale, rotation=0)
                try:
                    image = bitmap.to_pil().convert("RGB")
                    if image.size != (expected_width, expected_height):
                        raise ExtractionFailure(
                            ErrorCode.RASTERIZATION_FAILED,
                            "PDF raster dimensions differed from the safe preflight.",
                        )
                    output = io.BytesIO()
                    image.save(output, format="PNG", optimize=False)
                    image.close()
                finally:
                    bitmap.close()
            except ExtractionFailure:
                raise
            except Exception:
                raise ExtractionFailure(
                    ErrorCode.RASTERIZATION_FAILED,
                    "PDF page rasterization failed safely.",
                ) from None
            finally:
                page.close()
            yield RasterPage(
                page_number=page_index + 1,
                width=expected_width,
                height=expected_height,
                dpi=selected_dpi,
                color_mode="RGB",
                png_bytes=output.getvalue(),
            )
    finally:
        document.close()
