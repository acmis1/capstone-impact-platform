from __future__ import annotations

import inspect
import unittest
from dataclasses import replace

from capstone_assistive_worker.contract import (
    BoundingBox,
    ErrorCode,
    ExtractionSource,
    ExtractionStatus,
    GeometryUnit,
    OcrState,
    ProviderInfo,
)
from capstone_assistive_worker.ocr.contract import (
    OcrAvailability,
    OcrAvailabilityState,
    OcrBlock,
    OcrInput,
    OcrProviderErrorCode,
    OcrResult,
    OcrResultStatus,
    OcrWarning,
    OcrWarningCode,
)
from capstone_assistive_worker.ocr.tesseract import TesseractProvider
from capstone_assistive_worker.security.limits import DEFAULT_LIMITS
from capstone_assistive_worker.service import extract_document

from tests.fixture_support import generate_fixtures


class SuccessfulProvider:
    provider_id = "fake-success"

    def __init__(self) -> None:
        self.calls = 0

    def availability(self) -> OcrAvailability:
        return OcrAvailability(
            OcrAvailabilityState.AVAILABLE,
            ProviderInfo(self.provider_id, "1.0", "fake-runtime", "fake-model"),
        )

    def extract(self, raster: OcrInput) -> OcrResult:
        self.calls += 1
        return OcrResult(
            OcrResultStatus.SUCCESS,
            self.availability().provider,
            text=f"Synthetic OCR page {raster.page_number}",
            blocks=(
                OcrBlock(
                    page_number=raster.page_number,
                    text=f"Synthetic OCR page {raster.page_number}",
                    bounding_box=BoundingBox(
                        1.0,
                        2.0,
                        float(min(100, raster.width)),
                        float(min(40, raster.height)),
                        GeometryUnit.IMAGE_PIXELS_TOP_LEFT,
                    ),
                    confidence=0.91,
                ),
            ),
        )


class FailedProvider:
    provider_id = "fake-failure"

    def __init__(self) -> None:
        self.calls = 0

    def availability(self) -> OcrAvailability:
        return OcrAvailability(OcrAvailabilityState.AVAILABLE, ProviderInfo(self.provider_id, "1.0"))

    def extract(self, raster: OcrInput) -> OcrResult:
        self.calls += 1
        return OcrResult(
            OcrResultStatus.FAILED,
            self.availability().provider,
            error_code=OcrProviderErrorCode.EXECUTION_FAILED,
            error_message="Fake provider failed deterministically.",
        )


class UnavailableProvider:
    provider_id = "fake-unavailable"

    def __init__(self) -> None:
        self.calls = 0

    def availability(self) -> OcrAvailability:
        return OcrAvailability(
            OcrAvailabilityState.UNAVAILABLE,
            ProviderInfo(self.provider_id),
            "Fake provider is not installed.",
        )

    def extract(self, raster: OcrInput) -> OcrResult:
        self.calls += 1
        raise AssertionError("unavailable provider must not execute")


class OversizedProvider(SuccessfulProvider):
    provider_id = "fake-oversized"

    def extract(self, raster: OcrInput) -> OcrResult:
        self.calls += 1
        text = "x" * 100
        return OcrResult(OcrResultStatus.SUCCESS, self.availability().provider, text=text)


class OversizedBlockProvider(SuccessfulProvider):
    provider_id = "fake-oversized-block"

    def extract(self, raster: OcrInput) -> OcrResult:
        self.calls += 1
        return OcrResult(
            OcrResultStatus.SUCCESS,
            self.availability().provider,
            text="short",
            blocks=(OcrBlock(raster.page_number, "x" * 100),),
        )


class ExcessWarningsProvider(SuccessfulProvider):
    provider_id = "fake-warning-flood"

    def extract(self, raster: OcrInput) -> OcrResult:
        self.calls += 1
        warnings = tuple(
            OcrWarning(OcrWarningCode.PROVIDER_NOTICE, f"Synthetic warning {index}")
            for index in range(3)
        )
        return OcrResult(
            OcrResultStatus.SUCCESS,
            self.availability().provider,
            text="short",
            warnings=warnings,
        )


class AvailabilityFailureProvider:
    provider_id = "fake-availability-failure"

    def availability(self) -> OcrAvailability:
        raise RuntimeError("raw provider failure must not escape")

    def extract(self, raster: OcrInput) -> OcrResult:
        raise AssertionError("provider must not execute")


class OcrContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temporary, cls.fixtures, _ = generate_fixtures()
        cls.png = (cls.fixtures / "valid.png").read_bytes()
        cls.scanned_pdf = (cls.fixtures / "scanned-raster.pdf").read_bytes()
        cls.native_pdf = (cls.fixtures / "born-digital-one-page.pdf").read_bytes()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.temporary.cleanup()

    def test_no_provider_installed_is_normal_ocr_required_state(self) -> None:
        result = extract_document(self.png)
        self.assertEqual(result.status, ExtractionStatus.OCR_REQUIRED)
        self.assertEqual(result.ocr_state, OcrState.REQUIRED_NOT_RUN)
        self.assertIsNone(result.provider)

    def test_explicit_fake_provider_success(self) -> None:
        provider = SuccessfulProvider()
        result = extract_document(self.scanned_pdf, ocr_provider=provider)
        self.assertEqual(result.status, ExtractionStatus.COMPLETED)
        self.assertEqual(result.source, ExtractionSource.OCR)
        self.assertEqual(result.ocr_state, OcrState.COMPLETED)
        self.assertEqual(result.provider.provider_id, "fake-success")
        self.assertEqual(provider.calls, 1)
        self.assertEqual(result.blocks[0].confidence, 0.91)

    def test_valid_image_can_use_explicit_provider(self) -> None:
        provider = SuccessfulProvider()
        result = extract_document(self.png, ocr_provider=provider)
        self.assertEqual(result.status, ExtractionStatus.COMPLETED)
        self.assertEqual(provider.calls, 1)

    def test_provider_failure_is_bounded(self) -> None:
        provider = FailedProvider()
        result = extract_document(self.png, ocr_provider=provider)
        self.assertEqual(result.status, ExtractionStatus.FAILED)
        self.assertEqual(result.error.code, ErrorCode.OCR_PROVIDER_FAILED)
        self.assertEqual(provider.calls, 1)

    def test_unavailable_provider_does_not_execute(self) -> None:
        provider = UnavailableProvider()
        result = extract_document(self.png, ocr_provider=provider)
        self.assertEqual(result.status, ExtractionStatus.OCR_REQUIRED)
        self.assertEqual(result.ocr_state, OcrState.UNAVAILABLE)
        self.assertEqual(result.provider.provider_id, "fake-unavailable")
        self.assertEqual(provider.calls, 0)

    def test_real_adapter_reports_explicit_unavailable_state(self) -> None:
        provider = TesseractProvider(executable=self.fixtures / "not-installed.exe")
        availability = provider.availability()
        self.assertEqual(availability.state, OcrAvailabilityState.UNAVAILABLE)
        result = extract_document(self.png, ocr_provider=provider)
        self.assertEqual(result.ocr_state, OcrState.UNAVAILABLE)

    def test_clean_native_pdf_never_invokes_selected_provider(self) -> None:
        provider = UnavailableProvider()
        result = extract_document(self.native_pdf, ocr_provider=provider)
        self.assertEqual(result.source, ExtractionSource.NATIVE_PDF)
        self.assertEqual(result.ocr_state, OcrState.NOT_REQUIRED)
        self.assertEqual(provider.calls, 0)

    def test_provider_output_is_bounded(self) -> None:
        provider = OversizedProvider()
        result = extract_document(
            self.png,
            ocr_provider=provider,
            limits=replace(DEFAULT_LIMITS, max_extracted_characters=20),
        )
        self.assertEqual(result.error.code, ErrorCode.OCR_PROVIDER_OUTPUT_LIMIT_EXCEEDED)
        self.assertEqual(result.text, "")

    def test_provider_block_text_is_cumulatively_bounded(self) -> None:
        result = extract_document(
            self.png,
            ocr_provider=OversizedBlockProvider(),
            limits=replace(DEFAULT_LIMITS, max_extracted_characters=20),
        )
        self.assertEqual(result.error.code, ErrorCode.OCR_PROVIDER_OUTPUT_LIMIT_EXCEEDED)

    def test_provider_warning_count_is_bounded(self) -> None:
        result = extract_document(
            self.png,
            ocr_provider=ExcessWarningsProvider(),
            limits=replace(DEFAULT_LIMITS, max_warnings=2),
        )
        self.assertEqual(result.error.code, ErrorCode.OCR_PROVIDER_OUTPUT_LIMIT_EXCEEDED)

    def test_provider_availability_exception_is_bounded(self) -> None:
        result = extract_document(self.png, ocr_provider=AvailabilityFailureProvider())
        self.assertEqual(result.status, ExtractionStatus.FAILED)
        self.assertEqual(result.ocr_state, OcrState.FAILED)
        self.assertEqual(result.error.code, ErrorCode.OCR_PROVIDER_FAILED)
        self.assertNotIn("raw provider failure", result.error.message)

    def test_no_automatic_fallback_parameter_or_cascade(self) -> None:
        parameters = inspect.signature(extract_document).parameters
        self.assertIn("ocr_provider", parameters)
        self.assertNotIn("fallback_provider", parameters)
        provider = FailedProvider()
        result = extract_document(self.scanned_pdf, ocr_provider=provider)
        self.assertEqual(result.status, ExtractionStatus.FAILED)
        self.assertEqual(provider.calls, 1)


if __name__ == "__main__":
    unittest.main()
