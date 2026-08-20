from __future__ import annotations

import math
from dataclasses import dataclass
from enum import Enum
from typing import Any, Mapping


SCHEMA_VERSION = "assistive-document-extraction/v1"
MAX_CONTRACT_MESSAGE_CHARACTERS = 300


class DocumentType(str, Enum):
    PDF = "PDF"
    PNG = "PNG"
    JPEG = "JPEG"


class ExtractionStatus(str, Enum):
    COMPLETED = "COMPLETED"
    OCR_REQUIRED = "OCR_REQUIRED"
    FAILED = "FAILED"


class ExtractionSource(str, Enum):
    NONE = "NONE"
    NATIVE_PDF = "NATIVE_PDF"
    OCR = "OCR"


class NativeQuality(str, Enum):
    NATIVE_USABLE = "NATIVE_USABLE"
    OCR_REQUIRED = "OCR_REQUIRED"
    AMBIGUOUS = "AMBIGUOUS"
    INVALID = "INVALID"
    NOT_APPLICABLE = "NOT_APPLICABLE"


class QualityReason(str, Enum):
    NATIVE_TEXT_PRESENT = "NATIVE_TEXT_PRESENT"
    NO_NATIVE_TEXT = "NO_NATIVE_TEXT"
    SPARSE_NATIVE_TEXT = "SPARSE_NATIVE_TEXT"
    LOW_PRINTABLE_RATIO = "LOW_PRINTABLE_RATIO"
    EXCESSIVE_REPLACEMENT_CHARACTERS = "EXCESSIVE_REPLACEMENT_CHARACTERS"
    NO_TEXT_OBJECTS = "NO_TEXT_OBJECTS"
    PARSER_FAILURE = "PARSER_FAILURE"


class OcrState(str, Enum):
    NOT_REQUIRED = "NOT_REQUIRED"
    REQUIRED_NOT_RUN = "REQUIRED_NOT_RUN"
    COMPLETED = "COMPLETED"
    UNAVAILABLE = "UNAVAILABLE"
    FAILED = "FAILED"


class ErrorCode(str, Enum):
    EMPTY_INPUT = "EMPTY_INPUT"
    INPUT_TOO_LARGE = "INPUT_TOO_LARGE"
    UNSUPPORTED_MEDIA_TYPE = "UNSUPPORTED_MEDIA_TYPE"
    MIME_SIGNATURE_MISMATCH = "MIME_SIGNATURE_MISMATCH"
    CORRUPT_PDF = "CORRUPT_PDF"
    PDF_PAGE_LIMIT_EXCEEDED = "PDF_PAGE_LIMIT_EXCEEDED"
    PDF_PAGE_COUNT_INVALID = "PDF_PAGE_COUNT_INVALID"
    IMAGE_MALFORMED = "IMAGE_MALFORMED"
    IMAGE_DIMENSIONS_EXCEEDED = "IMAGE_DIMENSIONS_EXCEEDED"
    IMAGE_PIXELS_EXCEEDED = "IMAGE_PIXELS_EXCEEDED"
    RASTER_DPI_OUT_OF_RANGE = "RASTER_DPI_OUT_OF_RANGE"
    RASTER_DIMENSIONS_EXCEEDED = "RASTER_DIMENSIONS_EXCEEDED"
    RASTER_PIXELS_EXCEEDED = "RASTER_PIXELS_EXCEEDED"
    RASTER_TOTAL_PIXELS_EXCEEDED = "RASTER_TOTAL_PIXELS_EXCEEDED"
    RASTERIZATION_FAILED = "RASTERIZATION_FAILED"
    TEXT_CHARACTER_LIMIT_EXCEEDED = "TEXT_CHARACTER_LIMIT_EXCEEDED"
    TEXT_BLOCK_LIMIT_EXCEEDED = "TEXT_BLOCK_LIMIT_EXCEEDED"
    TEXT_LINE_LIMIT_EXCEEDED = "TEXT_LINE_LIMIT_EXCEEDED"
    PDF_TEXT_OBJECT_LIMIT_EXCEEDED = "PDF_TEXT_OBJECT_LIMIT_EXCEEDED"
    STAGING_PATH_INVALID = "STAGING_PATH_INVALID"
    STAGING_PATH_TRAVERSAL = "STAGING_PATH_TRAVERSAL"
    STAGED_FILE_NOT_FOUND = "STAGED_FILE_NOT_FOUND"
    STAGED_PATH_NOT_FILE = "STAGED_PATH_NOT_FILE"
    OCR_PROVIDER_UNAVAILABLE = "OCR_PROVIDER_UNAVAILABLE"
    OCR_PROVIDER_FAILED = "OCR_PROVIDER_FAILED"
    OCR_PROVIDER_OUTPUT_INVALID = "OCR_PROVIDER_OUTPUT_INVALID"
    OCR_PROVIDER_OUTPUT_LIMIT_EXCEEDED = "OCR_PROVIDER_OUTPUT_LIMIT_EXCEEDED"
    OCR_EMPTY_OUTPUT = "OCR_EMPTY_OUTPUT"
    INTERNAL_ERROR = "INTERNAL_ERROR"


class WarningCode(str, Enum):
    LOW_RESOLUTION_IMAGE = "LOW_RESOLUTION_IMAGE"
    NATIVE_TEXT_AMBIGUOUS = "NATIVE_TEXT_AMBIGUOUS"
    OCR_PROVIDER_UNAVAILABLE = "OCR_PROVIDER_UNAVAILABLE"
    OCR_PROVIDER_WARNING = "OCR_PROVIDER_WARNING"


class GeometryUnit(str, Enum):
    PDF_POINTS_TOP_LEFT = "PDF_POINTS_TOP_LEFT"
    IMAGE_PIXELS_TOP_LEFT = "IMAGE_PIXELS_TOP_LEFT"


def _bounded_message(value: str, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be a non-empty string")
    if len(value) > MAX_CONTRACT_MESSAGE_CHARACTERS:
        raise ValueError(f"{field} exceeds the contract message bound")
    return value


@dataclass(frozen=True, slots=True)
class BoundingBox:
    left: float
    top: float
    right: float
    bottom: float
    unit: GeometryUnit

    def __post_init__(self) -> None:
        values = (self.left, self.top, self.right, self.bottom)
        if not all(
            isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
            for value in values
        ):
            raise ValueError("bounding box coordinates must be finite")
        if self.right < self.left or self.bottom < self.top:
            raise ValueError("bounding box coordinates are inverted")

    def to_dict(self) -> dict[str, Any]:
        return {
            "left": self.left,
            "top": self.top,
            "right": self.right,
            "bottom": self.bottom,
            "unit": self.unit.value,
        }


@dataclass(frozen=True, slots=True)
class TextBlock:
    page_number: int
    text: str
    source: ExtractionSource
    bounding_box: BoundingBox | None = None
    confidence: float | None = None

    def __post_init__(self) -> None:
        if self.page_number < 1:
            raise ValueError("page_number must be one-based")
        if not isinstance(self.text, str) or not self.text:
            raise ValueError("text block text must be non-empty")
        if self.confidence is not None and not 0.0 <= self.confidence <= 1.0:
            raise ValueError("confidence must be between zero and one")

    def to_dict(self) -> dict[str, Any]:
        return {
            "page_number": self.page_number,
            "text": self.text,
            "source": self.source.value,
            "bounding_box": self.bounding_box.to_dict() if self.bounding_box else None,
            "confidence": self.confidence,
        }


@dataclass(frozen=True, slots=True)
class NativeQualityEvidence:
    native_character_count: int
    meaningful_character_count: int
    printable_ratio: float
    replacement_character_count: int
    text_object_count: int
    reasons: tuple[QualityReason, ...]

    def __post_init__(self) -> None:
        counts = (
            self.native_character_count,
            self.meaningful_character_count,
            self.replacement_character_count,
            self.text_object_count,
        )
        if any(value < 0 for value in counts):
            raise ValueError("quality evidence counts cannot be negative")
        if not 0.0 <= self.printable_ratio <= 1.0:
            raise ValueError("printable_ratio must be between zero and one")
        if not self.reasons:
            raise ValueError("quality evidence must include at least one reason")

    def to_dict(self) -> dict[str, Any]:
        return {
            "native_character_count": self.native_character_count,
            "meaningful_character_count": self.meaningful_character_count,
            "printable_ratio": self.printable_ratio,
            "replacement_character_count": self.replacement_character_count,
            "text_object_count": self.text_object_count,
            "reasons": [reason.value for reason in self.reasons],
        }


@dataclass(frozen=True, slots=True)
class ProviderInfo:
    provider_id: str
    provider_version: str | None = None
    runtime_version: str | None = None
    model_version: str | None = None

    def __post_init__(self) -> None:
        _bounded_message(self.provider_id, "provider_id")
        for field in (self.provider_version, self.runtime_version, self.model_version):
            if field is not None:
                if not isinstance(field, str):
                    raise ValueError("provider metadata must be a string or null")
                if len(field) > MAX_CONTRACT_MESSAGE_CHARACTERS:
                    raise ValueError("provider metadata exceeds the contract bound")

    def to_dict(self) -> dict[str, Any]:
        return {
            "provider_id": self.provider_id,
            "provider_version": self.provider_version,
            "runtime_version": self.runtime_version,
            "model_version": self.model_version,
        }


@dataclass(frozen=True, slots=True)
class ExtractionWarning:
    code: WarningCode
    message: str

    def __post_init__(self) -> None:
        _bounded_message(self.message, "warning message")

    def to_dict(self) -> dict[str, str]:
        return {"code": self.code.value, "message": self.message}


@dataclass(frozen=True, slots=True)
class ExtractionError:
    code: ErrorCode
    message: str

    def __post_init__(self) -> None:
        _bounded_message(self.message, "error message")

    def to_dict(self) -> dict[str, str]:
        return {"code": self.code.value, "message": self.message}


@dataclass(frozen=True, slots=True)
class ExtractionResult:
    status: ExtractionStatus
    source: ExtractionSource
    document_type: DocumentType | None
    page_count: int
    text: str
    blocks: tuple[TextBlock, ...]
    native_quality: NativeQuality
    quality_evidence: NativeQualityEvidence | None
    ocr_state: OcrState
    provider: ProviderInfo | None = None
    warnings: tuple[ExtractionWarning, ...] = ()
    error: ExtractionError | None = None
    schema_version: str = SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != SCHEMA_VERSION:
            raise ValueError("unsupported extraction schema version")
        if not isinstance(self.page_count, int) or isinstance(self.page_count, bool) or self.page_count < 0:
            raise ValueError("page_count cannot be negative")
        if not isinstance(self.text, str):
            raise ValueError("extracted text must be a string")
        if self.status is ExtractionStatus.FAILED and self.error is None:
            raise ValueError("failed extraction requires an error")
        if self.status is not ExtractionStatus.FAILED and self.error is not None:
            raise ValueError("non-failed extraction cannot carry an error")
        if self.status is ExtractionStatus.COMPLETED and (
            self.source is ExtractionSource.NONE or self.page_count < 1 or not self.text.strip()
        ):
            raise ValueError("completed extraction requires a source, page, and non-empty text")
        if self.status is ExtractionStatus.OCR_REQUIRED and self.page_count < 1:
            raise ValueError("OCR_REQUIRED extraction requires at least one page")
        if self.ocr_state is OcrState.COMPLETED and (
            self.provider is None or self.source is not ExtractionSource.OCR
        ):
            raise ValueError("completed OCR requires provider metadata and OCR source")
        if self.source is ExtractionSource.OCR and self.ocr_state is not OcrState.COMPLETED:
            raise ValueError("OCR source requires completed OCR state")
        if self.source is ExtractionSource.NATIVE_PDF and self.document_type is not DocumentType.PDF:
            raise ValueError("native PDF source requires PDF document type")
        if self.source is ExtractionSource.NONE and self.blocks:
            raise ValueError("source-less extraction cannot contain text blocks")
        if self.status is ExtractionStatus.OCR_REQUIRED and self.ocr_state not in {
            OcrState.REQUIRED_NOT_RUN,
            OcrState.UNAVAILABLE,
        }:
            raise ValueError("OCR_REQUIRED status requires a pending or unavailable OCR state")
        if any(block.page_number > self.page_count for block in self.blocks):
            raise ValueError("text block page exceeds page_count")
        if any(block.source is not self.source for block in self.blocks):
            raise ValueError("text block source must match result source")

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "status": self.status.value,
            "source": self.source.value,
            "document_type": self.document_type.value if self.document_type else None,
            "page_count": self.page_count,
            "text": self.text,
            "blocks": [block.to_dict() for block in self.blocks],
            "native_quality": self.native_quality.value,
            "quality_evidence": self.quality_evidence.to_dict() if self.quality_evidence else None,
            "ocr_state": self.ocr_state.value,
            "provider": self.provider.to_dict() if self.provider else None,
            "warnings": [warning.to_dict() for warning in self.warnings],
            "error": self.error.to_dict() if self.error else None,
        }

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "ExtractionResult":
        expected = {
            "schema_version",
            "status",
            "source",
            "document_type",
            "page_count",
            "text",
            "blocks",
            "native_quality",
            "quality_evidence",
            "ocr_state",
            "provider",
            "warnings",
            "error",
        }
        _require_exact_keys(raw, expected, "extraction result")
        blocks_raw = _require_list(raw["blocks"], "blocks")
        warnings_raw = _require_list(raw["warnings"], "warnings")
        return cls(
            schema_version=_require_str(raw["schema_version"], "schema_version"),
            status=ExtractionStatus(raw["status"]),
            source=ExtractionSource(raw["source"]),
            document_type=DocumentType(raw["document_type"]) if raw["document_type"] is not None else None,
            page_count=_require_int(raw["page_count"], "page_count"),
            text=_require_str(raw["text"], "text", allow_empty=True),
            blocks=tuple(_block_from_dict(value) for value in blocks_raw),
            native_quality=NativeQuality(raw["native_quality"]),
            quality_evidence=(
                _quality_from_dict(_require_mapping(raw["quality_evidence"], "quality_evidence"))
                if raw["quality_evidence"] is not None
                else None
            ),
            ocr_state=OcrState(raw["ocr_state"]),
            provider=(
                _provider_from_dict(_require_mapping(raw["provider"], "provider"))
                if raw["provider"] is not None
                else None
            ),
            warnings=tuple(_warning_from_dict(value) for value in warnings_raw),
            error=(
                _error_from_dict(_require_mapping(raw["error"], "error"))
                if raw["error"] is not None
                else None
            ),
        )


def _require_exact_keys(raw: Mapping[str, Any], expected: set[str], label: str) -> None:
    if set(raw) != expected:
        raise ValueError(f"{label} contains unknown or missing fields")


def _require_mapping(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{label} must be an object")
    return value


def _require_list(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise ValueError(f"{label} must be an array")
    return value


def _require_str(value: Any, label: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str) or (not allow_empty and not value):
        raise ValueError(f"{label} must be a string")
    return value


def _require_int(value: Any, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise ValueError(f"{label} must be an integer")
    return value


def _require_number(value: Any, label: str) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        raise ValueError(f"{label} must be a finite number")
    return float(value)


def _bbox_from_dict(raw: Mapping[str, Any]) -> BoundingBox:
    _require_exact_keys(raw, {"left", "top", "right", "bottom", "unit"}, "bounding box")
    return BoundingBox(
        left=_require_number(raw["left"], "left"),
        top=_require_number(raw["top"], "top"),
        right=_require_number(raw["right"], "right"),
        bottom=_require_number(raw["bottom"], "bottom"),
        unit=GeometryUnit(raw["unit"]),
    )


def _block_from_dict(value: Any) -> TextBlock:
    raw = _require_mapping(value, "text block")
    _require_exact_keys(raw, {"page_number", "text", "source", "bounding_box", "confidence"}, "text block")
    return TextBlock(
        page_number=_require_int(raw["page_number"], "page_number"),
        text=_require_str(raw["text"], "block text"),
        source=ExtractionSource(raw["source"]),
        bounding_box=(
            _bbox_from_dict(_require_mapping(raw["bounding_box"], "bounding_box"))
            if raw["bounding_box"] is not None
            else None
        ),
        confidence=_require_number(raw["confidence"], "confidence") if raw["confidence"] is not None else None,
    )


def _quality_from_dict(raw: Mapping[str, Any]) -> NativeQualityEvidence:
    expected = {
        "native_character_count",
        "meaningful_character_count",
        "printable_ratio",
        "replacement_character_count",
        "text_object_count",
        "reasons",
    }
    _require_exact_keys(raw, expected, "quality evidence")
    reasons = _require_list(raw["reasons"], "quality reasons")
    return NativeQualityEvidence(
        native_character_count=_require_int(raw["native_character_count"], "native_character_count"),
        meaningful_character_count=_require_int(raw["meaningful_character_count"], "meaningful_character_count"),
        printable_ratio=_require_number(raw["printable_ratio"], "printable_ratio"),
        replacement_character_count=_require_int(raw["replacement_character_count"], "replacement_character_count"),
        text_object_count=_require_int(raw["text_object_count"], "text_object_count"),
        reasons=tuple(QualityReason(value) for value in reasons),
    )


def _provider_from_dict(raw: Mapping[str, Any]) -> ProviderInfo:
    expected = {"provider_id", "provider_version", "runtime_version", "model_version"}
    _require_exact_keys(raw, expected, "provider")
    return ProviderInfo(
        provider_id=_require_str(raw["provider_id"], "provider_id"),
        provider_version=(
            _require_str(raw["provider_version"], "provider_version", allow_empty=True)
            if raw["provider_version"] is not None
            else None
        ),
        runtime_version=(
            _require_str(raw["runtime_version"], "runtime_version", allow_empty=True)
            if raw["runtime_version"] is not None
            else None
        ),
        model_version=(
            _require_str(raw["model_version"], "model_version", allow_empty=True)
            if raw["model_version"] is not None
            else None
        ),
    )


def _warning_from_dict(value: Any) -> ExtractionWarning:
    raw = _require_mapping(value, "warning")
    _require_exact_keys(raw, {"code", "message"}, "warning")
    return ExtractionWarning(WarningCode(raw["code"]), _require_str(raw["message"], "warning message"))


def _error_from_dict(raw: Mapping[str, Any]) -> ExtractionError:
    _require_exact_keys(raw, {"code", "message"}, "error")
    return ExtractionError(ErrorCode(raw["code"]), _require_str(raw["message"], "error message"))
