from __future__ import annotations

from pathlib import Path
from typing import Iterable

from .contract import (
    DocumentType,
    ErrorCode,
    ExtractionError,
    ExtractionResult,
    ExtractionSource,
    ExtractionStatus,
    ExtractionWarning,
    NativeQuality,
    OcrState,
    TextBlock,
    WarningCode,
)
from .extraction.pdfium import NativePdfExtraction, extract_native_pdf
from .extraction.raster import RasterPage, iter_pdf_rasters
from .ocr.contract import OcrAvailabilityState, OcrInput, OcrProvider, OcrResultStatus
from .security.errors import ExtractionFailure
from .security.limits import DEFAULT_LIMITS, ExtractionLimits
from .security.media_validation import (
    ValidatedDocument,
    normalized_image_png,
    validate_document_bytes,
)
from .security.staging import read_staged_bytes


def _failed_result(
    failure: ExtractionFailure,
    *,
    document_type: DocumentType | None = None,
    page_count: int = 0,
    native: NativePdfExtraction | None = None,
    provider=None,
    ocr_failed: bool = False,
) -> ExtractionResult:
    return ExtractionResult(
        status=ExtractionStatus.FAILED,
        source=ExtractionSource.NONE,
        document_type=document_type,
        page_count=page_count,
        text="",
        blocks=(),
        native_quality=native.quality.classification if native else NativeQuality.INVALID,
        quality_evidence=native.quality.evidence if native else None,
        ocr_state=OcrState.FAILED if provider is not None or ocr_failed else OcrState.NOT_REQUIRED,
        provider=provider,
        error=ExtractionError(failure.code, failure.safe_message),
    )


def _pending_ocr_result(
    *,
    validated: ValidatedDocument,
    native: NativePdfExtraction | None,
    unavailable_provider=None,
    warnings: tuple[ExtractionWarning, ...] = (),
) -> ExtractionResult:
    provider_warnings = warnings
    state = OcrState.REQUIRED_NOT_RUN
    if unavailable_provider is not None:
        state = OcrState.UNAVAILABLE
        provider_warnings += (
            ExtractionWarning(
                WarningCode.OCR_PROVIDER_UNAVAILABLE,
                "The explicitly selected OCR provider is unavailable.",
            ),
        )
    return ExtractionResult(
        status=ExtractionStatus.OCR_REQUIRED,
        source=(
            ExtractionSource.NATIVE_PDF
            if native is not None and native.text.strip()
            else ExtractionSource.NONE
        ),
        document_type=validated.document_type,
        page_count=native.page_count if native else 1,
        text=native.text if native else "",
        blocks=native.blocks if native else (),
        native_quality=native.quality.classification if native else NativeQuality.NOT_APPLICABLE,
        quality_evidence=native.quality.evidence if native else None,
        ocr_state=state,
        provider=unavailable_provider,
        warnings=provider_warnings,
    )


def _provider_failure_code(provider_code: str) -> ErrorCode:
    if provider_code == "OUTPUT_LIMIT_EXCEEDED":
        return ErrorCode.OCR_PROVIDER_OUTPUT_LIMIT_EXCEEDED
    if provider_code == "OUTPUT_INVALID":
        return ErrorCode.OCR_PROVIDER_OUTPUT_INVALID
    return ErrorCode.OCR_PROVIDER_FAILED


def _run_ocr(
    rasters: Iterable[RasterPage],
    *,
    provider: OcrProvider,
    validated: ValidatedDocument,
    native: NativePdfExtraction | None,
    limits: ExtractionLimits,
    warnings: tuple[ExtractionWarning, ...],
) -> ExtractionResult:
    try:
        availability = provider.availability()
    except Exception:
        return _failed_result(
            ExtractionFailure(ErrorCode.OCR_PROVIDER_FAILED, "OCR provider availability check failed safely."),
            document_type=validated.document_type,
            page_count=native.page_count if native else 1,
            native=native,
            ocr_failed=True,
        )
    if availability.provider.provider_id != provider.provider_id:
        return _failed_result(
            ExtractionFailure(ErrorCode.OCR_PROVIDER_OUTPUT_INVALID, "OCR provider identity is inconsistent."),
            document_type=validated.document_type,
            page_count=native.page_count if native else 1,
            native=native,
            provider=availability.provider,
        )
    if availability.state is OcrAvailabilityState.UNAVAILABLE:
        return _pending_ocr_result(
            validated=validated,
            native=native,
            unavailable_provider=availability.provider,
            warnings=warnings,
        )

    texts: list[str] = []
    blocks: list[TextBlock] = []
    provider_warnings = list(warnings)
    provider_info = availability.provider
    total_characters = 0
    total_block_characters = 0
    total_lines = 0
    try:
        for raster in rasters:
            result = provider.extract(
                OcrInput(
                    png_bytes=raster.png_bytes,
                    page_number=raster.page_number,
                    width=raster.width,
                    height=raster.height,
                )
            )
            provider_info = result.provider
            if provider_info.provider_id != provider.provider_id:
                raise ExtractionFailure(
                    ErrorCode.OCR_PROVIDER_OUTPUT_INVALID,
                    "OCR provider result identity is inconsistent.",
                )
            if result.status is OcrResultStatus.FAILED:
                code = _provider_failure_code(result.error_code.value if result.error_code else "")
                messages = {
                    ErrorCode.OCR_PROVIDER_OUTPUT_LIMIT_EXCEEDED: "OCR provider output exceeded the configured limit.",
                    ErrorCode.OCR_PROVIDER_OUTPUT_INVALID: "OCR provider returned invalid structured output.",
                    ErrorCode.OCR_PROVIDER_FAILED: "OCR provider failed safely.",
                }
                raise ExtractionFailure(code, messages[code])
            if any(block.page_number != raster.page_number for block in result.blocks):
                raise ExtractionFailure(
                    ErrorCode.OCR_PROVIDER_OUTPUT_INVALID,
                    "OCR provider returned a block for an unexpected page.",
                )
            total_characters += len(result.text)
            total_lines += len([line for line in result.text.splitlines() if line.strip()])
            if total_characters > limits.max_extracted_characters:
                raise ExtractionFailure(
                    ErrorCode.OCR_PROVIDER_OUTPUT_LIMIT_EXCEEDED,
                    "OCR text exceeds the configured character limit.",
                )
            if total_lines > limits.max_text_lines:
                raise ExtractionFailure(
                    ErrorCode.OCR_PROVIDER_OUTPUT_LIMIT_EXCEEDED,
                    "OCR text lines exceed the configured limit.",
                )
            if len(blocks) + len(result.blocks) > limits.max_text_blocks:
                raise ExtractionFailure(
                    ErrorCode.OCR_PROVIDER_OUTPUT_LIMIT_EXCEEDED,
                    "OCR text blocks exceed the configured limit.",
                )
            total_block_characters += sum(len(block.text) for block in result.blocks)
            if total_block_characters > limits.max_extracted_characters:
                raise ExtractionFailure(
                    ErrorCode.OCR_PROVIDER_OUTPUT_LIMIT_EXCEEDED,
                    "OCR text block output exceeds the configured character limit.",
                )
            if len(provider_warnings) + len(result.warnings) > limits.max_warnings:
                raise ExtractionFailure(
                    ErrorCode.OCR_PROVIDER_OUTPUT_LIMIT_EXCEEDED,
                    "OCR warnings exceed the configured limit.",
                )
            texts.append(result.text)
            blocks.extend(
                TextBlock(
                    page_number=block.page_number,
                    text=block.text,
                    source=ExtractionSource.OCR,
                    bounding_box=block.bounding_box,
                    confidence=block.confidence,
                )
                for block in result.blocks
            )
            provider_warnings.extend(
                ExtractionWarning(WarningCode.OCR_PROVIDER_WARNING, warning.message)
                for warning in result.warnings
            )
    except ExtractionFailure as failure:
        return _failed_result(
            failure,
            document_type=validated.document_type,
            page_count=native.page_count if native else 1,
            native=native,
            provider=provider_info,
        )
    except Exception:
        return _failed_result(
            ExtractionFailure(ErrorCode.OCR_PROVIDER_FAILED, "OCR provider failed safely."),
            document_type=validated.document_type,
            page_count=native.page_count if native else 1,
            native=native,
            provider=provider_info,
        )

    text = "\n".join(texts)
    if not text.strip():
        return _failed_result(
            ExtractionFailure(ErrorCode.OCR_EMPTY_OUTPUT, "OCR completed without extracting text."),
            document_type=validated.document_type,
            page_count=native.page_count if native else 1,
            native=native,
            provider=provider_info,
        )
    return ExtractionResult(
        status=ExtractionStatus.COMPLETED,
        source=ExtractionSource.OCR,
        document_type=validated.document_type,
        page_count=native.page_count if native else 1,
        text=text,
        blocks=tuple(blocks),
        native_quality=native.quality.classification if native else NativeQuality.NOT_APPLICABLE,
        quality_evidence=native.quality.evidence if native else None,
        ocr_state=OcrState.COMPLETED,
        provider=provider_info,
        warnings=tuple(provider_warnings),
    )


def extract_document(
    data: bytes,
    *,
    claimed_media_type: DocumentType | None = None,
    ocr_provider: OcrProvider | None = None,
    raster_dpi: int | None = None,
    limits: ExtractionLimits = DEFAULT_LIMITS,
) -> ExtractionResult:
    """Extract bounded evidence from one untrusted document.

    Supplying ``ocr_provider`` is the only way OCR executes. There is no
    provider registry, implicit default, confidence escalation, or cascade.
    """

    try:
        return _extract_document(
            data,
            claimed_media_type=claimed_media_type,
            ocr_provider=ocr_provider,
            raster_dpi=raster_dpi,
            limits=limits,
        )
    except Exception:
        return _failed_result(
            ExtractionFailure(ErrorCode.INTERNAL_ERROR, "Document extraction failed safely."),
            ocr_failed=ocr_provider is not None,
        )


def _extract_document(
    data: bytes,
    *,
    claimed_media_type: DocumentType | None,
    ocr_provider: OcrProvider | None,
    raster_dpi: int | None,
    limits: ExtractionLimits,
) -> ExtractionResult:
    try:
        validated = validate_document_bytes(
            data,
            limits=limits,
            claimed_media_type=claimed_media_type,
        )
    except ExtractionFailure as failure:
        return _failed_result(failure)

    if validated.document_type is DocumentType.PDF:
        try:
            native = extract_native_pdf(data, limits=limits)
        except ExtractionFailure as failure:
            return _failed_result(failure, document_type=DocumentType.PDF)
        if native.quality.classification is NativeQuality.NATIVE_USABLE:
            return ExtractionResult(
                status=ExtractionStatus.COMPLETED,
                source=ExtractionSource.NATIVE_PDF,
                document_type=DocumentType.PDF,
                page_count=native.page_count,
                text=native.text,
                blocks=native.blocks,
                native_quality=native.quality.classification,
                quality_evidence=native.quality.evidence,
                ocr_state=OcrState.NOT_REQUIRED,
            )
        warnings: tuple[ExtractionWarning, ...] = ()
        if native.quality.classification is NativeQuality.AMBIGUOUS:
            warnings = (
                ExtractionWarning(
                    WarningCode.NATIVE_TEXT_AMBIGUOUS,
                    "Native PDF text is ambiguous under conservative operational heuristics.",
                ),
            )
        if ocr_provider is None:
            return _pending_ocr_result(validated=validated, native=native, warnings=warnings)
        try:
            rasters = iter_pdf_rasters(data, limits=limits, dpi=raster_dpi)
            return _run_ocr(
                rasters,
                provider=ocr_provider,
                validated=validated,
                native=native,
                limits=limits,
                warnings=warnings,
            )
        except ExtractionFailure as failure:
            return _failed_result(
                failure,
                document_type=DocumentType.PDF,
                page_count=native.page_count,
                native=native,
            )

    image_warnings: tuple[ExtractionWarning, ...] = ()
    assert validated.width is not None and validated.height is not None
    if min(validated.width, validated.height) < limits.low_resolution_warning_dimension:
        image_warnings = (
            ExtractionWarning(
                WarningCode.LOW_RESOLUTION_IMAGE,
                "Image resolution is low and OCR quality may be limited.",
            ),
        )
    if ocr_provider is None:
        return _pending_ocr_result(validated=validated, native=None, warnings=image_warnings)
    try:
        png_bytes = normalized_image_png(data, validated)
        raster = RasterPage(
            page_number=1,
            width=validated.width,
            height=validated.height,
            dpi=0,
            color_mode="RGB",
            png_bytes=png_bytes,
        )
    except ExtractionFailure as failure:
        return _failed_result(failure, document_type=validated.document_type)
    return _run_ocr(
        [raster],
        provider=ocr_provider,
        validated=validated,
        native=None,
        limits=limits,
        warnings=image_warnings,
    )


def extract_staged_document(
    *,
    allowed_root: Path,
    relative_path: str,
    claimed_media_type: DocumentType | None = None,
    ocr_provider: OcrProvider | None = None,
    raster_dpi: int | None = None,
    limits: ExtractionLimits = DEFAULT_LIMITS,
) -> ExtractionResult:
    try:
        data = read_staged_bytes(
            allowed_root,
            relative_path,
            maximum_bytes=max(limits.max_pdf_bytes, limits.max_image_bytes),
        )
    except (ExtractionFailure, OSError) as error:
        failure = error if isinstance(error, ExtractionFailure) else ExtractionFailure(
            ErrorCode.STAGING_PATH_INVALID,
            "Staged document could not be read safely.",
        )
        return _failed_result(failure)
    return extract_document(
        data,
        claimed_media_type=claimed_media_type,
        ocr_provider=ocr_provider,
        raster_dpi=raster_dpi,
        limits=limits,
    )
