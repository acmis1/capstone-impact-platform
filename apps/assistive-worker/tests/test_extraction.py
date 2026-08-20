from __future__ import annotations

import unittest
from dataclasses import replace

from capstone_assistive_worker.contract import (
    DocumentType,
    ErrorCode,
    ExtractionSource,
    ExtractionStatus,
    NativeQuality,
    OcrState,
)
from capstone_assistive_worker.security.limits import DEFAULT_LIMITS
from capstone_assistive_worker.service import extract_document

from tests.fixture_support import generate_fixtures


class ExtractionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temporary, cls.fixtures, _ = generate_fixtures()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.temporary.cleanup()

    def read(self, name: str) -> bytes:
        return (self.fixtures / name).read_bytes()

    def test_born_digital_pdf_uses_native_extraction(self) -> None:
        result = extract_document(self.read("born-digital-one-page.pdf"))
        self.assertEqual(result.status, ExtractionStatus.COMPLETED)
        self.assertEqual(result.source, ExtractionSource.NATIVE_PDF)
        self.assertEqual(result.native_quality, NativeQuality.NATIVE_USABLE)
        self.assertEqual(result.ocr_state, OcrState.NOT_REQUIRED)
        self.assertIn("Synthetic Native Extraction Poster", result.text)
        self.assertTrue(result.blocks)
        self.assertTrue(all(block.page_number == 1 for block in result.blocks))
        box = result.blocks[0].bounding_box
        self.assertIsNotNone(box)
        assert box is not None
        self.assertLessEqual(box.left, box.right)
        self.assertLessEqual(box.top, box.bottom)

    def test_multi_page_order_and_geometry(self) -> None:
        result = extract_document(self.read("born-digital-multi-page.pdf"))
        self.assertEqual(result.page_count, 2)
        self.assertLess(result.text.index("Page one"), result.text.index("Page two"))
        self.assertEqual(sorted({block.page_number for block in result.blocks}), [1, 2])

    def test_scanned_pdf_signals_ocr_required(self) -> None:
        result = extract_document(self.read("scanned-raster.pdf"))
        self.assertEqual(result.status, ExtractionStatus.OCR_REQUIRED)
        self.assertEqual(result.native_quality, NativeQuality.OCR_REQUIRED)
        self.assertEqual(result.ocr_state, OcrState.REQUIRED_NOT_RUN)
        self.assertEqual(result.quality_evidence.native_character_count, 0)

    def test_png_signals_ocr_required(self) -> None:
        result = extract_document(self.read("valid.png"))
        self.assertEqual(result.document_type, DocumentType.PNG)
        self.assertEqual(result.status, ExtractionStatus.OCR_REQUIRED)
        self.assertEqual(result.native_quality, NativeQuality.NOT_APPLICABLE)

    def test_jpeg_signals_ocr_required(self) -> None:
        result = extract_document(self.read("valid.jpg"))
        self.assertEqual(result.document_type, DocumentType.JPEG)
        self.assertEqual(result.status, ExtractionStatus.OCR_REQUIRED)

    def test_corrupt_pdf_fails_safely(self) -> None:
        result = extract_document(self.read("corrupt.pdf"))
        self.assertEqual(result.status, ExtractionStatus.FAILED)
        self.assertEqual(result.error.code, ErrorCode.CORRUPT_PDF)

    def test_empty_input_fails_safely(self) -> None:
        result = extract_document(self.read("empty.pdf"))
        self.assertEqual(result.error.code, ErrorCode.EMPTY_INPUT)

    def test_text_output_bound_fails_without_returning_partial_text(self) -> None:
        limits = replace(DEFAULT_LIMITS, max_extracted_characters=10)
        result = extract_document(self.read("born-digital-one-page.pdf"), limits=limits)
        self.assertEqual(result.status, ExtractionStatus.FAILED)
        self.assertEqual(result.error.code, ErrorCode.TEXT_CHARACTER_LIMIT_EXCEEDED)
        self.assertEqual(result.text, "")
        self.assertEqual(result.blocks, ())

    def test_page_bound_is_explicit(self) -> None:
        result = extract_document(
            self.read("born-digital-multi-page.pdf"),
            limits=replace(DEFAULT_LIMITS, max_pdf_pages=1),
        )
        self.assertEqual(result.error.code, ErrorCode.PDF_PAGE_LIMIT_EXCEEDED)


if __name__ == "__main__":
    unittest.main()
