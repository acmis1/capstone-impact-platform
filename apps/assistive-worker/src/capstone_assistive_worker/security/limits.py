from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ExtractionLimits:
    """Trusted server-side operational ceilings.

    The byte limits mirror the existing Admin/CMS media contract. Remaining
    limits are conservative worker controls and are never accepted from a
    document or untrusted request payload.
    """

    max_pdf_bytes: int = 20 * 1024 * 1024
    max_image_bytes: int = 5 * 1024 * 1024
    max_pdf_pages: int = 10
    max_image_width: int = 10_000
    max_image_height: int = 10_000
    max_decoded_pixels: int = 40_000_000
    min_raster_dpi: int = 72
    max_raster_dpi: int = 200
    default_raster_dpi: int = 150
    max_raster_width: int = 10_000
    max_raster_height: int = 10_000
    max_raster_pixels_per_page: int = 40_000_000
    max_total_raster_pixels: int = 80_000_000
    max_extracted_characters: int = 100_000
    max_text_blocks: int = 5_000
    max_text_lines: int = 5_000
    max_warnings: int = 50
    max_pdf_text_objects: int = 10_000
    max_provider_output_bytes: int = 5 * 1024 * 1024
    max_provider_stderr_bytes: int = 8 * 1024
    provider_timeout_seconds: float = 90.0
    low_resolution_warning_dimension: int = 300

    def __post_init__(self) -> None:
        integer_fields = (
            "max_pdf_bytes",
            "max_image_bytes",
            "max_pdf_pages",
            "max_image_width",
            "max_image_height",
            "max_decoded_pixels",
            "min_raster_dpi",
            "max_raster_dpi",
            "default_raster_dpi",
            "max_raster_width",
            "max_raster_height",
            "max_raster_pixels_per_page",
            "max_total_raster_pixels",
            "max_extracted_characters",
            "max_text_blocks",
            "max_text_lines",
            "max_warnings",
            "max_pdf_text_objects",
            "max_provider_output_bytes",
            "max_provider_stderr_bytes",
            "low_resolution_warning_dimension",
        )
        if any(getattr(self, field) <= 0 for field in integer_fields):
            raise ValueError("all extraction limits must be positive")
        if not self.min_raster_dpi <= self.default_raster_dpi <= self.max_raster_dpi:
            raise ValueError("default raster DPI must be inside the configured range")
        if self.provider_timeout_seconds <= 0:
            raise ValueError("provider timeout must be positive")


DEFAULT_LIMITS = ExtractionLimits()
