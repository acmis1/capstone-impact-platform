from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Protocol, runtime_checkable

from ..contract import BoundingBox, MAX_CONTRACT_MESSAGE_CHARACTERS, ProviderInfo


class OcrAvailabilityState(str, Enum):
    AVAILABLE = "AVAILABLE"
    UNAVAILABLE = "UNAVAILABLE"


class OcrResultStatus(str, Enum):
    SUCCESS = "SUCCESS"
    FAILED = "FAILED"


class OcrProviderErrorCode(str, Enum):
    TIMEOUT = "TIMEOUT"
    EXECUTION_FAILED = "EXECUTION_FAILED"
    OUTPUT_INVALID = "OUTPUT_INVALID"
    OUTPUT_LIMIT_EXCEEDED = "OUTPUT_LIMIT_EXCEEDED"


class OcrWarningCode(str, Enum):
    PROVIDER_NOTICE = "PROVIDER_NOTICE"
    DEGRADED_OUTPUT = "DEGRADED_OUTPUT"


@dataclass(frozen=True, slots=True)
class OcrAvailability:
    state: OcrAvailabilityState
    provider: ProviderInfo
    message: str | None = None

    def __post_init__(self) -> None:
        if self.state is OcrAvailabilityState.UNAVAILABLE and not self.message:
            raise ValueError("unavailable provider must include a bounded message")
        if self.message is not None and len(self.message) > MAX_CONTRACT_MESSAGE_CHARACTERS:
            raise ValueError("availability message exceeds the contract bound")


@dataclass(frozen=True, slots=True)
class OcrInput:
    png_bytes: bytes
    page_number: int
    width: int
    height: int

    def __post_init__(self) -> None:
        if not self.png_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
            raise ValueError("OCR input must be a normalized PNG")
        if self.page_number < 1 or self.width < 1 or self.height < 1:
            raise ValueError("OCR input geometry is invalid")


@dataclass(frozen=True, slots=True)
class OcrBlock:
    page_number: int
    text: str
    bounding_box: BoundingBox | None = None
    confidence: float | None = None

    def __post_init__(self) -> None:
        if self.page_number < 1:
            raise ValueError("OCR block page must be one-based")
        if not self.text:
            raise ValueError("OCR block text must be non-empty")
        if self.confidence is not None and not 0.0 <= self.confidence <= 1.0:
            raise ValueError("OCR confidence must be between zero and one")


@dataclass(frozen=True, slots=True)
class OcrWarning:
    code: OcrWarningCode
    message: str

    def __post_init__(self) -> None:
        if not self.message or len(self.message) > MAX_CONTRACT_MESSAGE_CHARACTERS:
            raise ValueError("OCR warning message is invalid")


@dataclass(frozen=True, slots=True)
class OcrResult:
    status: OcrResultStatus
    provider: ProviderInfo
    text: str = ""
    blocks: tuple[OcrBlock, ...] = ()
    warnings: tuple[OcrWarning, ...] = ()
    error_code: OcrProviderErrorCode | None = None
    error_message: str | None = None

    def __post_init__(self) -> None:
        if self.status is OcrResultStatus.SUCCESS and (self.error_code or self.error_message):
            raise ValueError("successful OCR cannot include an error")
        if self.status is OcrResultStatus.FAILED and (self.error_code is None or not self.error_message):
            raise ValueError("failed OCR must include an error code and message")
        if self.error_message is not None and len(self.error_message) > MAX_CONTRACT_MESSAGE_CHARACTERS:
            raise ValueError("OCR error message exceeds the contract bound")


@runtime_checkable
class OcrProvider(Protocol):
    """Local OCR boundary. Callers select exactly one provider explicitly."""

    @property
    def provider_id(self) -> str: ...

    def availability(self) -> OcrAvailability: ...

    def extract(self, raster: OcrInput) -> OcrResult: ...
