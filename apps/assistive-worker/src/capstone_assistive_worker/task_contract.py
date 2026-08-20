from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from pathlib import PurePosixPath
from typing import Any, Mapping
from uuid import UUID

from .contract import DocumentType, ExtractionResult


TASK_SCHEMA_VERSION = "assistive-worker-task/v1"
TASK_RESULT_SCHEMA_VERSION = "assistive-worker-task-result/v1"
MAX_TASK_BYTES = 4096


class OcrProviderSelection(str, Enum):
    NONE = "NONE"
    TESSERACT = "TESSERACT"


class TaskErrorCode(str, Enum):
    TASK_CONTRACT_REJECTED = "TASK_CONTRACT_REJECTED"
    TASK_EXECUTION_FAILED = "TASK_EXECUTION_FAILED"


@dataclass(frozen=True, slots=True)
class WorkerTask:
    task_id: UUID
    relative_path: str
    document_type: DocumentType
    ocr_provider: OcrProviderSelection
    raster_dpi: int | None
    schema_version: str = TASK_SCHEMA_VERSION

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "WorkerTask":
        expected = {
            "schema_version",
            "task_id",
            "relative_path",
            "document_type",
            "ocr_provider",
            "raster_dpi",
        }
        if set(raw) != expected:
            raise ValueError("task contains unknown or missing fields")
        if raw["schema_version"] != TASK_SCHEMA_VERSION:
            raise ValueError("unsupported task schema version")
        try:
            task_id = UUID(str(raw["task_id"]))
        except (TypeError, ValueError, AttributeError) as error:
            raise ValueError("task_id must be a UUID") from error
        if str(task_id) != raw["task_id"]:
            raise ValueError("task_id must use canonical UUID form")

        relative_path = raw["relative_path"]
        if not isinstance(relative_path, str):
            raise ValueError("relative_path must be a string")
        path = PurePosixPath(relative_path)
        allowed_paths = {
            "document.pdf": DocumentType.PDF,
            "document.png": DocumentType.PNG,
            "document.jpg": DocumentType.JPEG,
        }
        if path.is_absolute() or relative_path not in allowed_paths:
            raise ValueError("relative_path is not an allowed staged filename")

        try:
            document_type = DocumentType(raw["document_type"])
            ocr_provider = OcrProviderSelection(raw["ocr_provider"])
        except (TypeError, ValueError) as error:
            raise ValueError("task enum value is invalid") from error
        if allowed_paths[relative_path] is not document_type:
            raise ValueError("document_type does not match relative_path")

        raster_dpi = raw["raster_dpi"]
        if raster_dpi is not None and (
            not isinstance(raster_dpi, int)
            or isinstance(raster_dpi, bool)
            or raster_dpi < 72
            or raster_dpi > 200
        ):
            raise ValueError("raster_dpi must be null or between 72 and 200")
        if ocr_provider is OcrProviderSelection.NONE and raster_dpi is not None:
            raise ValueError("raster_dpi requires an explicit OCR provider")

        return cls(
            task_id=task_id,
            relative_path=relative_path,
            document_type=document_type,
            ocr_provider=ocr_provider,
            raster_dpi=raster_dpi,
        )


@dataclass(frozen=True, slots=True)
class WorkerTaskError:
    code: TaskErrorCode
    message: str

    def to_dict(self) -> dict[str, str]:
        return {"code": self.code.value, "message": self.message[:300]}


@dataclass(frozen=True, slots=True)
class WorkerTaskResult:
    task_id: UUID | None
    extraction: ExtractionResult | None
    error: WorkerTaskError | None
    duration_ms: int
    schema_version: str = TASK_RESULT_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.duration_ms < 0:
            raise ValueError("duration_ms cannot be negative")
        if (self.extraction is None) == (self.error is None):
            raise ValueError("task result requires exactly one result branch")

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "task_id": str(self.task_id) if self.task_id else None,
            "extraction": self.extraction.to_dict() if self.extraction else None,
            "error": self.error.to_dict() if self.error else None,
            "duration_ms": self.duration_ms,
        }
