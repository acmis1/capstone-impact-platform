from __future__ import annotations

import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from capstone_assistive_worker.contract import DocumentType, ErrorCode, ExtractionStatus, WarningCode
from capstone_assistive_worker.security.limits import DEFAULT_LIMITS
from capstone_assistive_worker.service import extract_document, extract_staged_document

from tests.fixture_support import generate_fixtures


class SecurityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temporary, cls.fixtures, _ = generate_fixtures()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.temporary.cleanup()

    def read(self, name: str) -> bytes:
        return (self.fixtures / name).read_bytes()

    def test_pdf_byte_limit(self) -> None:
        data = self.read("born-digital-one-page.pdf")
        result = extract_document(data, limits=replace(DEFAULT_LIMITS, max_pdf_bytes=len(data) - 1))
        self.assertEqual(result.error.code, ErrorCode.INPUT_TOO_LARGE)

    def test_image_byte_limit(self) -> None:
        data = self.read("valid.png")
        result = extract_document(data, limits=replace(DEFAULT_LIMITS, max_image_bytes=len(data) - 1))
        self.assertEqual(result.error.code, ErrorCode.INPUT_TOO_LARGE)

    def test_oversized_dimensions_and_pixel_bomb_header(self) -> None:
        result = extract_document(self.read("oversized-dimensions.png"))
        self.assertEqual(result.status, ExtractionStatus.FAILED)
        self.assertIn(result.error.code, {ErrorCode.IMAGE_DIMENSIONS_EXCEEDED, ErrorCode.IMAGE_PIXELS_EXCEEDED})

    def test_decoded_pixel_limit(self) -> None:
        result = extract_document(
            self.read("valid.png"),
            limits=replace(DEFAULT_LIMITS, max_decoded_pixels=100),
        )
        self.assertEqual(result.error.code, ErrorCode.IMAGE_PIXELS_EXCEEDED)

    def test_malformed_image(self) -> None:
        result = extract_document(b"\x89PNG\r\n\x1a\nmalformed")
        self.assertEqual(result.error.code, ErrorCode.IMAGE_MALFORMED)

    def test_unsupported_signature(self) -> None:
        result = extract_document(self.read("unsupported.txt"))
        self.assertEqual(result.error.code, ErrorCode.UNSUPPORTED_MEDIA_TYPE)

    def test_signature_mismatch(self) -> None:
        result = extract_document(self.read("valid.jpg"), claimed_media_type=DocumentType.PNG)
        self.assertEqual(result.error.code, ErrorCode.MIME_SIGNATURE_MISMATCH)

    def test_low_resolution_is_warning_not_failure(self) -> None:
        result = extract_document(self.read("low-resolution.png"))
        self.assertEqual(result.status, ExtractionStatus.OCR_REQUIRED)
        self.assertIn(WarningCode.LOW_RESOLUTION_IMAGE, {warning.code for warning in result.warnings})

    def test_path_traversal_is_rejected(self) -> None:
        result = extract_staged_document(
            allowed_root=self.fixtures,
            relative_path="../outside.pdf",
        )
        self.assertEqual(result.error.code, ErrorCode.STAGING_PATH_TRAVERSAL)

    def test_absolute_path_is_rejected(self) -> None:
        result = extract_staged_document(
            allowed_root=self.fixtures,
            relative_path=str((self.fixtures / "valid.png").resolve()),
        )
        self.assertEqual(result.error.code, ErrorCode.STAGING_PATH_TRAVERSAL)

    def test_staged_file_inside_root_is_accepted(self) -> None:
        result = extract_staged_document(
            allowed_root=self.fixtures,
            relative_path="valid.png",
        )
        self.assertEqual(result.status, ExtractionStatus.OCR_REQUIRED)

    def test_staged_directory_is_not_a_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "child").mkdir()
            result = extract_staged_document(allowed_root=root, relative_path="child")
        self.assertEqual(result.error.code, ErrorCode.STAGED_PATH_NOT_FILE)

    def test_missing_staging_root_is_explicit(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            missing = Path(directory) / "missing-root"
            result = extract_staged_document(allowed_root=missing, relative_path="poster.pdf")
        self.assertEqual(result.error.code, ErrorCode.STAGING_PATH_INVALID)


if __name__ == "__main__":
    unittest.main()
