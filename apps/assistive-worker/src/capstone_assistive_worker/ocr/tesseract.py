from __future__ import annotations

import csv
import os
import shutil
import subprocess
import tempfile
import time
from collections import OrderedDict
from pathlib import Path
from typing import BinaryIO

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


class _BoundedCommandError(Exception):
    def __init__(self, code: OcrProviderErrorCode, message: str):
        super().__init__(message)
        self.code = code
        self.safe_message = message


class TesseractProvider:
    """Optional local Tesseract adapter; never selected automatically."""

    def __init__(
        self,
        *,
        executable: str | Path | None = None,
        language: str = "eng",
        page_segmentation_mode: int = 3,
        limits: ExtractionLimits = DEFAULT_LIMITS,
    ) -> None:
        if not language.isascii() or not language.replace("_", "").replace("-", "").isalnum():
            raise ValueError("Tesseract language must be a bounded language identifier")
        if page_segmentation_mode not in range(0, 14):
            raise ValueError("Tesseract page segmentation mode must be between 0 and 13")
        self._configured_executable = str(executable) if executable is not None else None
        self._language = language
        self._psm = page_segmentation_mode
        self._limits = limits

    @property
    def provider_id(self) -> str:
        return "tesseract-local"

    def _resolve_executable(self) -> str | None:
        configured = self._configured_executable or os.environ.get("TESSERACT_CMD")
        if configured:
            path = Path(configured)
            return str(path.resolve()) if path.is_file() else None
        return shutil.which("tesseract")

    def availability(self) -> OcrAvailability:
        executable = self._resolve_executable()
        base = ProviderInfo(provider_id=self.provider_id, model_version=f"{self._language} traineddata")
        if executable is None:
            return OcrAvailability(
                OcrAvailabilityState.UNAVAILABLE,
                base,
                "Tesseract executable is not provisioned for this worker.",
            )
        try:
            version_payload = self._run_bounded(
                [executable, "--version"],
                timeout_seconds=min(10.0, self._limits.provider_timeout_seconds),
            )
        except _BoundedCommandError:
            return OcrAvailability(
                OcrAvailabilityState.UNAVAILABLE,
                base,
                "Tesseract executable could not be started safely.",
            )
        version_output = version_payload[:1024].decode("utf-8", errors="replace")
        version_line = version_output.splitlines()[0].strip()[:300] if version_output else None
        return OcrAvailability(
            OcrAvailabilityState.AVAILABLE,
            ProviderInfo(
                provider_id=self.provider_id,
                provider_version=version_line,
                runtime_version="tesseract-cli",
                model_version=f"{self._language} traineddata",
            ),
        )

    def extract(self, raster: OcrInput) -> OcrResult:
        availability = self.availability()
        if availability.state is OcrAvailabilityState.UNAVAILABLE:
            return OcrResult(
                status=OcrResultStatus.FAILED,
                provider=availability.provider,
                error_code=OcrProviderErrorCode.EXECUTION_FAILED,
                error_message="Tesseract became unavailable before extraction.",
            )
        executable = self._resolve_executable()
        if executable is None:
            return OcrResult(
                status=OcrResultStatus.FAILED,
                provider=availability.provider,
                error_code=OcrProviderErrorCode.EXECUTION_FAILED,
                error_message="Tesseract executable is unavailable.",
            )

        with tempfile.TemporaryDirectory(prefix="capstone-ocr-") as directory:
            input_path = Path(directory) / "input.png"
            input_path.write_bytes(raster.png_bytes)
            command = [
                executable,
                str(input_path),
                "stdout",
                "--psm",
                str(self._psm),
                "-l",
                self._language,
                "tsv",
            ]
            try:
                stdout = self._run_bounded(command)
                text, blocks = self._parse_tsv(stdout, raster)
            except _BoundedCommandError as error:
                return OcrResult(
                    status=OcrResultStatus.FAILED,
                    provider=availability.provider,
                    error_code=error.code,
                    error_message=error.safe_message,
                )
            return OcrResult(
                status=OcrResultStatus.SUCCESS,
                provider=availability.provider,
                text=text,
                blocks=tuple(blocks),
            )

    def _run_bounded(self, command: list[str], *, timeout_seconds: float | None = None) -> bytes:
        timeout = self._limits.provider_timeout_seconds if timeout_seconds is None else timeout_seconds
        with tempfile.TemporaryFile() as stdout_file, tempfile.TemporaryFile() as stderr_file:
            try:
                process = subprocess.Popen(
                    command,
                    stdin=subprocess.DEVNULL,
                    stdout=stdout_file,
                    stderr=stderr_file,
                    shell=False,
                )
            except OSError:
                raise _BoundedCommandError(
                    OcrProviderErrorCode.EXECUTION_FAILED,
                    "Tesseract process could not be started.",
                ) from None
            started = time.monotonic()
            try:
                while process.poll() is None:
                    if time.monotonic() - started > timeout:
                        process.kill()
                        raise _BoundedCommandError(
                            OcrProviderErrorCode.TIMEOUT,
                            "Tesseract extraction exceeded the configured timeout.",
                        )
                    if _stream_size(stdout_file) > self._limits.max_provider_output_bytes:
                        process.kill()
                        raise _BoundedCommandError(
                            OcrProviderErrorCode.OUTPUT_LIMIT_EXCEEDED,
                            "Tesseract output exceeded the configured byte limit.",
                        )
                    if _stream_size(stderr_file) > self._limits.max_provider_stderr_bytes:
                        process.kill()
                        raise _BoundedCommandError(
                            OcrProviderErrorCode.OUTPUT_LIMIT_EXCEEDED,
                            "Tesseract diagnostic output exceeded the configured byte limit.",
                        )
                    time.sleep(0.02)
            finally:
                process.wait()
            if process.returncode != 0:
                raise _BoundedCommandError(
                    OcrProviderErrorCode.EXECUTION_FAILED,
                    "Tesseract extraction returned a non-zero status.",
                )
            if _stream_size(stdout_file) > self._limits.max_provider_output_bytes:
                raise _BoundedCommandError(
                    OcrProviderErrorCode.OUTPUT_LIMIT_EXCEEDED,
                    "Tesseract output exceeded the configured byte limit.",
                )
            if _stream_size(stderr_file) > self._limits.max_provider_stderr_bytes:
                raise _BoundedCommandError(
                    OcrProviderErrorCode.OUTPUT_LIMIT_EXCEEDED,
                    "Tesseract diagnostic output exceeded the configured byte limit.",
                )
            stdout_file.seek(0)
            return stdout_file.read(self._limits.max_provider_output_bytes + 1)

    def _parse_tsv(self, payload: bytes, raster: OcrInput) -> tuple[str, list[OcrBlock]]:
        try:
            decoded = payload.decode("utf-8", errors="strict")
            rows = csv.DictReader(decoded.splitlines(), delimiter="\t")
            lines: OrderedDict[tuple[str, str, str, str], list[tuple[str, int, int, int, int, float | None]]] = OrderedDict()
            for row in rows:
                value = (row.get("text") or "").strip()
                if not value:
                    continue
                key = tuple(row[name] for name in ("page_num", "block_num", "par_num", "line_num"))
                left = int(row["left"])
                top = int(row["top"])
                width = int(row["width"])
                height = int(row["height"])
                raw_confidence = float(row["conf"])
                confidence = raw_confidence / 100.0 if raw_confidence >= 0 else None
                lines.setdefault(key, []).append((value, left, top, width, height, confidence))
                if len(lines) > self._limits.max_text_blocks:
                    raise _BoundedCommandError(
                        OcrProviderErrorCode.OUTPUT_LIMIT_EXCEEDED,
                        "Tesseract text blocks exceeded the configured limit.",
                    )
        except _BoundedCommandError:
            raise
        except (KeyError, TypeError, ValueError, UnicodeDecodeError):
            raise _BoundedCommandError(
                OcrProviderErrorCode.OUTPUT_INVALID,
                "Tesseract returned malformed structured output.",
            ) from None

        blocks: list[OcrBlock] = []
        total_characters = 0
        for words in lines.values():
            text = " ".join(word[0] for word in words)
            total_characters += len(text)
            if total_characters > self._limits.max_extracted_characters:
                raise _BoundedCommandError(
                    OcrProviderErrorCode.OUTPUT_LIMIT_EXCEEDED,
                    "Tesseract text exceeded the configured character limit.",
                )
            left = min(word[1] for word in words)
            top = min(word[2] for word in words)
            right = max(word[1] + word[3] for word in words)
            bottom = max(word[2] + word[4] for word in words)
            confidences = [word[5] for word in words if word[5] is not None]
            blocks.append(
                OcrBlock(
                    page_number=raster.page_number,
                    text=text,
                    bounding_box=BoundingBox(
                        left=float(left),
                        top=float(top),
                        right=float(right),
                        bottom=float(bottom),
                        unit=GeometryUnit.IMAGE_PIXELS_TOP_LEFT,
                    ),
                    confidence=sum(confidences) / len(confidences) if confidences else None,
                )
            )
        return "\n".join(block.text for block in blocks), blocks


def _stream_size(stream: BinaryIO) -> int:
    return os.fstat(stream.fileno()).st_size
