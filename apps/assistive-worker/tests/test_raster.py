from __future__ import annotations

import unittest
from dataclasses import replace

from capstone_assistive_worker.contract import ErrorCode
from capstone_assistive_worker.extraction.raster import iter_pdf_rasters
from capstone_assistive_worker.security.errors import ExtractionFailure
from capstone_assistive_worker.security.limits import DEFAULT_LIMITS

from tests.fixture_support import generate_fixtures


class RasterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temporary, cls.fixtures, _ = generate_fixtures()
        cls.pdf = (cls.fixtures / "scanned-raster.pdf").read_bytes()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.temporary.cleanup()

    def test_incremental_rgb_raster(self) -> None:
        iterator = iter_pdf_rasters(self.pdf, limits=DEFAULT_LIMITS, dpi=100)
        page = next(iterator)
        self.assertEqual(page.page_number, 1)
        self.assertEqual(page.color_mode, "RGB")
        self.assertTrue(page.png_bytes.startswith(b"\x89PNG\r\n\x1a\n"))
        with self.assertRaises(StopIteration):
            next(iterator)

    def test_dpi_bound(self) -> None:
        with self.assertRaises(ExtractionFailure) as caught:
            next(iter_pdf_rasters(self.pdf, limits=DEFAULT_LIMITS, dpi=500))
        self.assertEqual(caught.exception.code, ErrorCode.RASTER_DPI_OUT_OF_RANGE)

    def test_per_page_raster_pixel_bound(self) -> None:
        limits = replace(DEFAULT_LIMITS, max_raster_pixels_per_page=100)
        with self.assertRaises(ExtractionFailure) as caught:
            next(iter_pdf_rasters(self.pdf, limits=limits, dpi=100))
        self.assertEqual(caught.exception.code, ErrorCode.RASTER_PIXELS_EXCEEDED)

    def test_total_raster_pixel_bound(self) -> None:
        limits = replace(DEFAULT_LIMITS, max_total_raster_pixels=100)
        with self.assertRaises(ExtractionFailure) as caught:
            next(iter_pdf_rasters(self.pdf, limits=limits, dpi=100))
        self.assertEqual(caught.exception.code, ErrorCode.RASTER_TOTAL_PIXELS_EXCEEDED)


if __name__ == "__main__":
    unittest.main()
