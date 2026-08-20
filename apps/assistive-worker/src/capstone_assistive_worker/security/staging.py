from __future__ import annotations

from pathlib import Path, PurePath

from ..contract import ErrorCode
from .errors import ExtractionFailure


def resolve_staged_path(allowed_root: Path, relative_path: str) -> Path:
    """Resolve one untrusted relative path inside a trusted staging root."""

    if not isinstance(relative_path, str) or not relative_path or "\x00" in relative_path:
        raise ExtractionFailure(ErrorCode.STAGING_PATH_INVALID, "Staged document path is invalid.")
    untrusted = PurePath(relative_path.replace("\\", "/"))
    if untrusted.is_absolute() or ".." in untrusted.parts:
        raise ExtractionFailure(ErrorCode.STAGING_PATH_TRAVERSAL, "Staged document path escapes the allowed root.")

    try:
        root = allowed_root.resolve(strict=True)
    except OSError:
        raise ExtractionFailure(ErrorCode.STAGING_PATH_INVALID, "Trusted staging root is invalid.") from None
    if not root.is_dir():
        raise ExtractionFailure(ErrorCode.STAGING_PATH_INVALID, "Trusted staging root is not a directory.")
    candidate = (root / Path(*untrusted.parts)).resolve(strict=False)
    if not candidate.is_relative_to(root):
        raise ExtractionFailure(ErrorCode.STAGING_PATH_TRAVERSAL, "Staged document path escapes the allowed root.")
    if not candidate.exists():
        raise ExtractionFailure(ErrorCode.STAGED_FILE_NOT_FOUND, "Staged document does not exist.")
    try:
        resolved = candidate.resolve(strict=True)
    except OSError:
        raise ExtractionFailure(ErrorCode.STAGED_FILE_NOT_FOUND, "Staged document does not exist.") from None
    if not resolved.is_relative_to(root):
        raise ExtractionFailure(ErrorCode.STAGING_PATH_TRAVERSAL, "Staged document path escapes the allowed root.")
    if not resolved.is_file():
        raise ExtractionFailure(ErrorCode.STAGED_PATH_NOT_FILE, "Staged document is not a regular file.")
    return resolved


def read_staged_bytes(allowed_root: Path, relative_path: str, *, maximum_bytes: int) -> bytes:
    path = resolve_staged_path(allowed_root, relative_path)
    if path.stat().st_size > maximum_bytes:
        raise ExtractionFailure(ErrorCode.INPUT_TOO_LARGE, "Staged document exceeds the configured byte limit.")
    with path.open("rb") as handle:
        data = handle.read(maximum_bytes + 1)
    if len(data) > maximum_bytes:
        raise ExtractionFailure(ErrorCode.INPUT_TOO_LARGE, "Staged document exceeds the configured byte limit.")
    return data
