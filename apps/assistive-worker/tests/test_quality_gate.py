from __future__ import annotations

import unittest

from capstone_assistive_worker.contract import NativeQuality, QualityReason
from capstone_assistive_worker.extraction.quality_gate import classify_native_text


class QualityGateTests(unittest.TestCase):
    def test_native_usable(self) -> None:
        assessment = classify_native_text(
            "A complete born-digital poster title and explanatory body.",
            text_object_count=2,
        )
        self.assertEqual(assessment.classification, NativeQuality.NATIVE_USABLE)
        self.assertEqual(assessment.evidence.reasons, (QualityReason.NATIVE_TEXT_PRESENT,))

    def test_zero_native_text_requires_ocr(self) -> None:
        assessment = classify_native_text("", text_object_count=0)
        self.assertEqual(assessment.classification, NativeQuality.OCR_REQUIRED)
        self.assertIn(QualityReason.NO_NATIVE_TEXT, assessment.evidence.reasons)

    def test_sparse_native_text_is_ambiguous(self) -> None:
        assessment = classify_native_text("Page 1", text_object_count=1)
        self.assertEqual(assessment.classification, NativeQuality.AMBIGUOUS)
        self.assertIn(QualityReason.SPARSE_NATIVE_TEXT, assessment.evidence.reasons)

    def test_noisy_native_text_is_ambiguous(self) -> None:
        assessment = classify_native_text("Useful native text " + "\ufffd" * 10, text_object_count=1)
        self.assertEqual(assessment.classification, NativeQuality.AMBIGUOUS)
        self.assertIn(QualityReason.EXCESSIVE_REPLACEMENT_CHARACTERS, assessment.evidence.reasons)

    def test_parser_failure_is_invalid(self) -> None:
        assessment = classify_native_text("", text_object_count=0, parser_succeeded=False)
        self.assertEqual(assessment.classification, NativeQuality.INVALID)
        self.assertEqual(assessment.evidence.reasons, (QualityReason.PARSER_FAILURE,))


if __name__ == "__main__":
    unittest.main()
