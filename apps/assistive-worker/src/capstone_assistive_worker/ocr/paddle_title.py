"""Optional, frozen PP-OCRv6 Small full-page title provider.

The provider is selected explicitly, uses only operator-provisioned local model bytes, and
fails closed when the runtime or model identity differs from the qualified Issue #214
candidate. It performs one full-page OCR pass; there is no crop, cascade, cloud fallback, or
model download.
"""

from __future__ import annotations

import hashlib
import io
import socket
import tempfile
import time
from pathlib import Path
from typing import Any

from ..contract import BoundingBox, GeometryUnit, ProviderInfo
from ..security.limits import DEFAULT_LIMITS, ExtractionLimits
from .contract import (
    OcrAvailability,
    OcrAvailabilityState,
    OcrBlock,
    OcrInput,
    OcrProviderErrorCode,
    OcrResult,
    OcrResultStatus,
)


PROVIDER_ID = "paddleocr-local"
DETECTION_MODEL = "PP-OCRv6_small_det"
RECOGNITION_MODEL = "PP-OCRv6_small_rec"
DETECTION_TREE_SHA256 = "8af984562965b7be9bd5d1c8acb52f6d0bf37de475947b520d876ed8640eb29a"
RECOGNITION_TREE_SHA256 = "0ee2c443863549fabdb1120d7a58df5e8afa0d67bce0827b75529f105c993eae"
FROZEN_RUNTIME = {"paddleocr": "3.7.0", "paddlepaddle": "3.3.0", "paddlex": "3.7.2"}
MODEL_VERSION = "PP-OCRv6 Small (det+rec)"
FROZEN_CPU_THREADS = 4
FROZEN_MKLDNN_CACHE_CAPACITY = 10
MAX_INPUT_DIMENSION = 1920
MAX_LINE_CHARACTERS = 400


class OfflineNetworkBlocked(OSError):
    """Raised if a Paddle title task attempts an outbound socket connection."""


_offline_guard_enabled = False


def enable_offline_guard() -> None:
    """Deny process-wide socket connections before Paddle constructs any pipeline."""
    global _offline_guard_enabled
    if _offline_guard_enabled:
        return

    def blocked(*_args: Any, **_kwargs: Any) -> Any:
        raise OfflineNetworkBlocked("network disabled for local assistive OCR")

    socket.create_connection = blocked  # type: ignore[assignment]
    socket.socket.connect = blocked  # type: ignore[method-assign]
    socket.socket.connect_ex = blocked  # type: ignore[method-assign]
    try:
        socket.create_connection(("127.0.0.1", 9), timeout=0.01)
    except OfflineNetworkBlocked:
        _offline_guard_enabled = True
        return
    raise RuntimeError("assistive OCR offline guard self-test failed")


def tree_sha256(directory: Path) -> str:
    """Digest a model tree from sorted relative paths and per-file byte hashes."""
    digest = hashlib.sha256()
    for path in sorted(item for item in directory.rglob("*") if item.is_file()):
        digest.update(path.relative_to(directory).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(path.stat().st_size).encode("ascii"))
        digest.update(b"\0")
        digest.update(hashlib.sha256(path.read_bytes()).digest())
        digest.update(b"\0")
    return digest.hexdigest()


class PaddleTitleOcrProvider:
    """Exact frozen local PP-OCRv6 Small adapter; never selected automatically."""

    def __init__(
        self,
        *,
        models_dir: str | Path | None = None,
        limits: ExtractionLimits = DEFAULT_LIMITS,
    ) -> None:
        self._models_dir = Path(models_dir) if models_dir else None
        self._limits = limits
        self._instance: Any | None = None

    @property
    def provider_id(self) -> str:
        return PROVIDER_ID

    def _observed_runtime(self) -> dict[str, str] | None:
        try:
            import paddle
            import paddleocr
            import paddlex
        except Exception:
            return None
        try:
            return {
                "paddleocr": str(paddleocr.__version__),
                "paddlepaddle": str(paddle.__version__),
                "paddlex": str(paddlex.__version__),
            }
        except Exception:
            return None

    def _model_directories(self) -> tuple[Path, Path] | None:
        if self._models_dir is None:
            return None
        detection = self._models_dir / f"{DETECTION_MODEL}_infer"
        recognition = self._models_dir / f"{RECOGNITION_MODEL}_infer"
        if not detection.is_dir() or not recognition.is_dir():
            return None
        return detection, recognition

    def _unavailable(self, message: str) -> OcrAvailability:
        return OcrAvailability(
            OcrAvailabilityState.UNAVAILABLE,
            ProviderInfo(provider_id=self.provider_id, model_version=MODEL_VERSION),
            message,
        )

    def availability(self) -> OcrAvailability:
        directories = self._model_directories()
        if directories is None:
            return self._unavailable("PP-OCRv6 Small model directories are not provisioned for this worker.")
        runtime = self._observed_runtime()
        if runtime is None:
            return self._unavailable("The PaddleOCR runtime is not installed for this worker.")
        if runtime != FROZEN_RUNTIME:
            return self._unavailable("The installed PaddleOCR runtime differs from the frozen identity.")
        detection, recognition = directories
        if tree_sha256(detection) != DETECTION_TREE_SHA256 or tree_sha256(recognition) != RECOGNITION_TREE_SHA256:
            return self._unavailable("The provisioned PP-OCRv6 Small model bytes differ from the frozen identity.")
        return OcrAvailability(
            OcrAvailabilityState.AVAILABLE,
            ProviderInfo(
                provider_id=self.provider_id,
                provider_version=f"paddleocr {runtime['paddleocr']}",
                runtime_version=f"paddlepaddle {runtime['paddlepaddle']}, paddlex {runtime['paddlex']}",
                model_version=MODEL_VERSION,
            ),
        )

    def _engine(self, detection: Path, recognition: Path) -> Any:
        if self._instance is None:
            enable_offline_guard()
            from paddleocr import PaddleOCR

            self._instance = PaddleOCR(
                text_detection_model_name=DETECTION_MODEL,
                text_recognition_model_name=RECOGNITION_MODEL,
                text_detection_model_dir=str(detection),
                text_recognition_model_dir=str(recognition),
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=False,
                device="cpu",
                enable_mkldnn=False,
                mkldnn_cache_capacity=FROZEN_MKLDNN_CACHE_CAPACITY,
                enable_hpi=False,
                cpu_threads=FROZEN_CPU_THREADS,
            )
        return self._instance

    def extract(self, raster: OcrInput) -> OcrResult:
        availability = self.availability()
        if availability.state is OcrAvailabilityState.UNAVAILABLE:
            return OcrResult(
                status=OcrResultStatus.FAILED,
                provider=availability.provider,
                error_code=OcrProviderErrorCode.EXECUTION_FAILED,
                error_message="The PP-OCRv6 Small provider is unavailable.",
            )
        directories = self._model_directories()
        if directories is None:
            return OcrResult(
                status=OcrResultStatus.FAILED,
                provider=availability.provider,
                error_code=OcrProviderErrorCode.EXECUTION_FAILED,
                error_message="The PP-OCRv6 Small provider is unavailable.",
            )
        deadline = time.monotonic() + self._limits.provider_timeout_seconds
        try:
            engine = self._engine(*directories)
            ppm_bytes = self._decode_ppm(raster)
        except Exception:
            return OcrResult(
                status=OcrResultStatus.FAILED,
                provider=availability.provider,
                error_code=OcrProviderErrorCode.EXECUTION_FAILED,
                error_message="The PP-OCRv6 Small provider failed to start safely.",
            )
        try:
            with tempfile.TemporaryDirectory(prefix="capstone-paddle-title-") as directory:
                page_path = Path(directory) / "page.ppm"
                page_path.write_bytes(ppm_bytes)
                blocks = self._predict(engine, str(page_path), raster, deadline)
        except _ProviderError as error:
            return OcrResult(
                status=OcrResultStatus.FAILED,
                provider=availability.provider,
                error_code=error.code,
                error_message=error.safe_message,
            )
        except Exception:
            return OcrResult(
                status=OcrResultStatus.FAILED,
                provider=availability.provider,
                error_code=OcrProviderErrorCode.EXECUTION_FAILED,
                error_message="The PP-OCRv6 Small provider failed safely.",
            )
        return OcrResult(
            status=OcrResultStatus.SUCCESS,
            provider=availability.provider,
            text="\n".join(block.text for block in blocks),
            blocks=tuple(blocks),
        )

    def _decode_ppm(self, raster: OcrInput) -> bytes:
        from PIL import Image

        with Image.open(io.BytesIO(raster.png_bytes)) as decoded:
            width, height = decoded.size
            if (width, height) != (raster.width, raster.height):
                raise ValueError("OCR input geometry differs from the normalized PNG")
            if width > self._limits.max_raster_width or height > self._limits.max_raster_height:
                raise ValueError("OCR input dimensions exceed the configured raster limit")
            if width * height > self._limits.max_raster_pixels_per_page:
                raise ValueError("OCR input pixels exceed the configured raster limit")
            decoded.load()
            page = decoded.convert("RGB")
        try:
            longest = max(page.size)
            if longest > MAX_INPUT_DIMENSION:
                scale = MAX_INPUT_DIMENSION / longest
                resized = page.resize(
                    (max(1, round(page.width * scale)), max(1, round(page.height * scale))),
                    resample=Image.Resampling.LANCZOS,
                )
                page.close()
                page = resized
            header = f"P6\n{page.width} {page.height}\n255\n".encode("ascii")
            return header + page.tobytes()
        finally:
            page.close()

    def _predict(self, engine: Any, page: Any, raster: OcrInput, deadline: float) -> list[OcrBlock]:
        blocks: list[OcrBlock] = []
        characters = 0
        for result in engine.predict(page):
            if time.monotonic() > deadline:
                raise _ProviderError(OcrProviderErrorCode.TIMEOUT, "PP-OCRv6 Small extraction timed out.")
            data = _result_data(result)
            texts = list(data.get("rec_texts") or data.get("texts") or [])
            scores = list(data.get("rec_scores") or data.get("scores") or [])
            boxes = list(data.get("rec_boxes") or data.get("rec_polys") or data.get("dt_polys") or [])
            for index, value in enumerate(texts):
                raw_text = str(value).strip()
                if not raw_text:
                    continue
                characters += len(raw_text)
                if characters > self._limits.max_extracted_characters:
                    raise _ProviderError(
                        OcrProviderErrorCode.OUTPUT_LIMIT_EXCEEDED,
                        "PP-OCRv6 Small text exceeded the configured character limit.",
                    )
                if len(blocks) >= self._limits.max_text_blocks:
                    raise _ProviderError(
                        OcrProviderErrorCode.OUTPUT_LIMIT_EXCEEDED,
                        "PP-OCRv6 Small text blocks exceeded the configured limit.",
                    )
                confidence = None
                if index < len(scores):
                    confidence = min(1.0, max(0.0, float(scores[index])))
                blocks.append(
                    OcrBlock(
                        page_number=raster.page_number,
                        text=raw_text[:MAX_LINE_CHARACTERS],
                        bounding_box=_bounding_box(boxes[index]) if index < len(boxes) else None,
                        confidence=confidence,
                    )
                )
        if time.monotonic() > deadline:
            raise _ProviderError(OcrProviderErrorCode.TIMEOUT, "PP-OCRv6 Small extraction timed out.")
        return blocks


class _ProviderError(Exception):
    def __init__(self, code: OcrProviderErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.safe_message = message


def _result_data(result: Any) -> dict[str, Any]:
    for attribute in ("json", "res"):
        value = getattr(result, attribute, None)
        if isinstance(value, dict):
            return value.get("res", value) if attribute == "json" else value
    if isinstance(result, dict):
        return result.get("res", result)
    raise _ProviderError(
        OcrProviderErrorCode.OUTPUT_INVALID,
        "PP-OCRv6 Small returned an unrecognised result structure.",
    )


def _bounding_box(box: Any) -> BoundingBox | None:
    try:
        values = [float(value) for value in _flatten(box)]
    except (TypeError, ValueError):
        return None
    if len(values) == 4:
        left, top, right, bottom = values
    elif len(values) >= 8 and len(values) % 2 == 0:
        xs, ys = values[0::2], values[1::2]
        left, top, right, bottom = min(xs), min(ys), max(xs), max(ys)
    else:
        return None
    if right < left or bottom < top:
        return None
    return BoundingBox(
        left=left,
        top=top,
        right=right,
        bottom=bottom,
        unit=GeometryUnit.IMAGE_PIXELS_TOP_LEFT,
    )


def _flatten(value: Any) -> list[Any]:
    if hasattr(value, "tolist"):
        value = value.tolist()
    if isinstance(value, (list, tuple)):
        result: list[Any] = []
        for item in value:
            result.extend(_flatten(item))
        return result
    return [value]
