from __future__ import annotations

import io
import warnings
from dataclasses import dataclass

from PIL import Image, UnidentifiedImageError

from ..contract import DocumentType, ErrorCode
from .errors import ExtractionFailure
from .limits import ExtractionLimits


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
JPEG_SIGNATURE = b"\xff\xd8\xff"
PDF_SIGNATURE = b"%PDF-"


@dataclass(frozen=True, slots=True)
class ValidatedDocument:
    document_type: DocumentType
    byte_count: int
    width: int | None = None
    height: int | None = None


def detect_document_type(data: bytes) -> DocumentType | None:
    """Detect the supported type from authoritative leading bytes only."""

    if data.startswith(PNG_SIGNATURE):
        return DocumentType.PNG
    if data.startswith(JPEG_SIGNATURE):
        return DocumentType.JPEG
    if data.startswith(PDF_SIGNATURE):
        return DocumentType.PDF
    return None


def validate_document_bytes(
    data: bytes,
    *,
    limits: ExtractionLimits,
    claimed_media_type: DocumentType | None = None,
) -> ValidatedDocument:
    if not isinstance(data, bytes):
        raise TypeError("document input must be bytes")
    if not data:
        raise ExtractionFailure(ErrorCode.EMPTY_INPUT, "Document input is empty.")

    document_type = detect_document_type(data)
    if document_type is None:
        raise ExtractionFailure(
            ErrorCode.UNSUPPORTED_MEDIA_TYPE,
            "Document signature is not a supported PDF, PNG, or JPEG type.",
        )
    if claimed_media_type is not None and claimed_media_type is not document_type:
        raise ExtractionFailure(
            ErrorCode.MIME_SIGNATURE_MISMATCH,
            "Claimed media type does not match the document signature.",
        )

    maximum_bytes = limits.max_pdf_bytes if document_type is DocumentType.PDF else limits.max_image_bytes
    if len(data) > maximum_bytes:
        raise ExtractionFailure(
            ErrorCode.INPUT_TOO_LARGE,
            f"{document_type.value} input exceeds the configured byte limit.",
        )
    if document_type is DocumentType.PDF:
        return ValidatedDocument(document_type=document_type, byte_count=len(data))

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as image:
                expected_format = "PNG" if document_type is DocumentType.PNG else "JPEG"
                if image.format != expected_format:
                    raise ExtractionFailure(
                        ErrorCode.MIME_SIGNATURE_MISMATCH,
                        "Decoded image format does not match the document signature.",
                    )
                width, height = image.size
                if width <= 0 or height <= 0:
                    raise ExtractionFailure(ErrorCode.IMAGE_MALFORMED, "Image dimensions are invalid.")
                if width > limits.max_image_width or height > limits.max_image_height:
                    raise ExtractionFailure(
                        ErrorCode.IMAGE_DIMENSIONS_EXCEEDED,
                        "Image dimensions exceed the configured limit.",
                    )
                if width * height > limits.max_decoded_pixels:
                    raise ExtractionFailure(
                        ErrorCode.IMAGE_PIXELS_EXCEEDED,
                        "Decoded image pixels exceed the configured limit.",
                    )
                image.load()
    except ExtractionFailure:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise ExtractionFailure(
            ErrorCode.IMAGE_PIXELS_EXCEEDED,
            "Decoded image pixels exceed a safe decoder limit.",
        ) from None
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError):
        raise ExtractionFailure(ErrorCode.IMAGE_MALFORMED, "Image data is malformed or truncated.") from None

    return ValidatedDocument(
        document_type=document_type,
        byte_count=len(data),
        width=width,
        height=height,
    )


def normalized_image_png(data: bytes, validated: ValidatedDocument) -> bytes:
    """Decode a validated image and return a provider-neutral RGB PNG."""

    if validated.document_type not in {DocumentType.PNG, DocumentType.JPEG}:
        raise ValueError("normalized_image_png requires a validated image")
    try:
        with Image.open(io.BytesIO(data)) as image:
            rgb = image.convert("RGB")
            output = io.BytesIO()
            rgb.save(output, format="PNG", optimize=False)
            rgb.close()
            return output.getvalue()
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError):
        raise ExtractionFailure(ErrorCode.IMAGE_MALFORMED, "Image data could not be decoded for OCR.") from None
