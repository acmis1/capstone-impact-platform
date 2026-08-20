from __future__ import annotations

import unittest

from capstone_assistive_worker.contract import (
    DocumentType,
    ExtractionResult,
    ExtractionSource,
    ExtractionStatus,
    NativeQuality,
    OcrState,
    ProviderInfo,
    SCHEMA_VERSION,
)


class ContractTests(unittest.TestCase):
    def test_stable_enum_values(self) -> None:
        self.assertEqual(SCHEMA_VERSION, "assistive-document-extraction/v1")
        self.assertEqual([value.value for value in ExtractionStatus], ["COMPLETED", "OCR_REQUIRED", "FAILED"])
        self.assertEqual(DocumentType.PDF.value, "PDF")
        self.assertEqual(NativeQuality.AMBIGUOUS.value, "AMBIGUOUS")

    def test_round_trip_serialization(self) -> None:
        result = ExtractionResult(
            status=ExtractionStatus.OCR_REQUIRED,
            source=ExtractionSource.NONE,
            document_type=DocumentType.PNG,
            page_count=1,
            text="",
            blocks=(),
            native_quality=NativeQuality.NOT_APPLICABLE,
            quality_evidence=None,
            ocr_state=OcrState.REQUIRED_NOT_RUN,
        )
        self.assertEqual(ExtractionResult.from_dict(result.to_dict()), result)

    def test_unknown_output_field_is_rejected(self) -> None:
        raw = ExtractionResult(
            status=ExtractionStatus.OCR_REQUIRED,
            source=ExtractionSource.NONE,
            document_type=DocumentType.JPEG,
            page_count=1,
            text="",
            blocks=(),
            native_quality=NativeQuality.NOT_APPLICABLE,
            quality_evidence=None,
            ocr_state=OcrState.REQUIRED_NOT_RUN,
        ).to_dict()
        raw["authoritative"] = True
        with self.assertRaises(ValueError):
            ExtractionResult.from_dict(raw)

    def test_invalid_status_is_rejected(self) -> None:
        raw = ExtractionResult(
            status=ExtractionStatus.OCR_REQUIRED,
            source=ExtractionSource.NONE,
            document_type=DocumentType.PNG,
            page_count=1,
            text="",
            blocks=(),
            native_quality=NativeQuality.NOT_APPLICABLE,
            quality_evidence=None,
            ocr_state=OcrState.REQUIRED_NOT_RUN,
        ).to_dict()
        raw["status"] = "APPROVED"
        with self.assertRaises(ValueError):
            ExtractionResult.from_dict(raw)

    def test_non_string_provider_metadata_is_rejected(self) -> None:
        raw = ExtractionResult(
            status=ExtractionStatus.COMPLETED,
            source=ExtractionSource.OCR,
            document_type=DocumentType.PNG,
            page_count=1,
            text="synthetic",
            blocks=(),
            native_quality=NativeQuality.NOT_APPLICABLE,
            quality_evidence=None,
            ocr_state=OcrState.COMPLETED,
            provider=ProviderInfo("fake", "1.0"),
        ).to_dict()
        raw["provider"]["provider_version"] = 1
        with self.assertRaises(ValueError):
            ExtractionResult.from_dict(raw)

    def test_impossible_completed_state_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            ExtractionResult(
                status=ExtractionStatus.COMPLETED,
                source=ExtractionSource.NONE,
                document_type=DocumentType.PNG,
                page_count=1,
                text="synthetic",
                blocks=(),
                native_quality=NativeQuality.NOT_APPLICABLE,
                quality_evidence=None,
                ocr_state=OcrState.NOT_REQUIRED,
            )


if __name__ == "__main__":
    unittest.main()
