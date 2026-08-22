"""Canonical renderer environment identity and the deterministic renderer fingerprint.

The merged Iteration 2 calibration proved byte-deterministic regeneration *within* one
renderer environment but not across operating systems or FreeType builds. This module closes
that gap without inventing infrastructure the repository does not have.

The canonical environment is the repository-pinned wheel toolchain: an exact Python minor
version, an exact Pillow (which vendors its own FreeType, so the host font stack is never
consulted), an exact pypdfium2, and the repository-pinned Noto Sans blob. Its identity is not
asserted by a label; it is *measured*, by rendering a tiny synthetic fixture and hashing the
result.

The binding digests are decoded-pixel digests, because decoded pixels are what an OCR engine
consumes. Encoded byte digests are recorded as attestation: an image compressor may select a
different optimised code path on a different CPU and emit different valid bytes for identical
pixels, and treating that as a canonical-renderer failure would be a false alarm.
"""

from __future__ import annotations

import importlib.metadata
import platform
import sys
from pathlib import Path
from typing import Any

from PIL import features

from .renderer import REFERENCE_FIXTURE, reference_digests
from .schema import (
    file_sha256,
    load_json,
    normalized_text_file_sha256,
    tool_root,
    value_sha256,
)


ENVIRONMENT_SCHEMA_VERSION = "pp1-ocr-canonical-renderer-environment/v1"
ENVIRONMENT_ID = "pp1-ocr-canonical-renderer-v1"
CANONICAL_PYTHON_MAJOR_MINOR = "3.11"
CANONICAL_PILLOW = "12.3.0"
CANONICAL_FREETYPE = "2.14.3"
CANONICAL_PYPDFIUM2 = "5.13.0"

# Text sources are hashed LF-normalised so a Windows CRLF checkout cannot change renderer
# identity; the font blob is hashed raw because it is binary.
RENDERER_TEXT_SOURCES = (
    "src/assistive_validation_benchmark/ocr_iteration2_holdout_protocol/renderer.py",
    "src/assistive_validation_benchmark/ocr_iteration2_calibration/corpus.py",
    "ocr-iteration2-calibration/font/manifest.json",
)
RENDERER_BINARY_SOURCES = ("ocr-iteration2-calibration/font/NotoSans-Regular.ttf",)


class RendererFingerprintMismatch(ValueError):
    """Raised when the running environment is not the frozen canonical renderer."""


def environment_path() -> Path:
    return tool_root() / "ocr-iteration2-holdout-protocol" / "renderer-environment.json"


def renderer_source_digests() -> dict[str, str]:
    digests: dict[str, str] = {}
    for relative in RENDERER_TEXT_SOURCES:
        digests[relative] = normalized_text_file_sha256(tool_root() / relative)
    for relative in RENDERER_BINARY_SOURCES:
        digests[relative] = file_sha256(tool_root() / relative)
    return digests


def _installed(package: str) -> str:
    try:
        return importlib.metadata.version(package)
    except importlib.metadata.PackageNotFoundError:  # pragma: no cover - absent dependency
        return "absent"


def compute_fingerprint() -> dict[str, Any]:
    """Measure the running renderer environment. No value here is read from a stored file."""
    if not features.check("freetype2"):
        raise RendererFingerprintMismatch("Pillow was built without FreeType; glyph rendering is not canonical")
    sources = renderer_source_digests()
    fixture = reference_digests()
    binding = {
        "environment_id": ENVIRONMENT_ID,
        "python_major_minor": f"{sys.version_info.major}.{sys.version_info.minor}",
        "pillow": _installed("Pillow"),
        "freetype": features.version("freetype2"),
        "pypdfium2": _installed("pypdfium2"),
        "font_sha256": sources["ocr-iteration2-calibration/font/NotoSans-Regular.ttf"],
        "renderer_source_sha256": sources,
        "reference_fixture_spec_sha256": value_sha256(REFERENCE_FIXTURE),
        "reference_fixture_binding_digests": fixture["binding"],
    }
    return {
        "schema_version": ENVIRONMENT_SCHEMA_VERSION,
        "binding": binding,
        "fingerprint_sha256": value_sha256(binding),
        "attestation": {
            "reference_fixture_encoded_digests": fixture["attestation"],
            "measured_platform": {
                "system": platform.system(),
                "machine": platform.machine(),
                "python": platform.python_version(),
            },
        },
    }


def validate_environment(value: dict[str, Any]) -> dict[str, Any]:
    """Reject a canonical-renderer definition that is unpinned or permits a host font stack."""
    if value.get("schema_version") != ENVIRONMENT_SCHEMA_VERSION:
        raise ValueError("unsupported canonical renderer environment schema")
    if value.get("environment_id") != ENVIRONMENT_ID:
        raise ValueError("canonical renderer environment identity changed")
    pinned = value.get("pinned_toolchain", {})
    expected = {
        "python_major_minor": CANONICAL_PYTHON_MAJOR_MINOR,
        "pillow": CANONICAL_PILLOW,
        "freetype": CANONICAL_FREETYPE,
        "pypdfium2": CANONICAL_PYPDFIUM2,
    }
    if pinned != expected:
        raise ValueError(f"canonical renderer toolchain is not the reviewed pinned set: {pinned}")
    for key in ("system_font_fallback", "runtime_font_download", "network_during_generation"):
        if value.get(key) is not False:
            raise ValueError(f"canonical renderer must keep {key} false")
    if value.get("floating_version_tags_permitted") is not False:
        raise ValueError("the canonical renderer may not depend on a floating or latest version tag")
    font = value.get("font", {})
    for key in ("path", "sha256", "family", "style", "version", "license"):
        if not isinstance(font.get(key), str) or not font[key]:
            raise ValueError(f"canonical renderer font {key} is not pinned")
    fingerprint = value.get("fingerprint", {})
    binding = fingerprint.get("binding")
    if not isinstance(binding, dict) or not binding:
        raise ValueError("canonical renderer fingerprint has no frozen binding")
    if fingerprint.get("fingerprint_sha256") != value_sha256(binding):
        raise ValueError("stored renderer fingerprint digest does not follow its own binding")
    platforms = value.get("attested_platforms")
    if not isinstance(platforms, list) or not platforms:
        raise ValueError("the canonical renderer must record at least one attested platform")
    return value


def _compare(expected: dict[str, Any], observed: dict[str, Any]) -> list[str]:
    divergent = []
    for key in sorted(set(expected) | set(observed)):
        if expected.get(key) != observed.get(key):
            divergent.append(key)
    return divergent


def verify_fingerprint(environment: dict[str, Any] | None = None) -> dict[str, Any]:
    """Compare the measured environment with the frozen one and report every divergence."""
    stored = validate_environment(environment if environment is not None else load_json(environment_path()))
    observed = compute_fingerprint()
    expected_binding = stored["fingerprint"]["binding"]
    divergent = _compare(expected_binding, observed["binding"])
    matches = not divergent
    expected_encoded = stored.get("attestation", {}).get("reference_fixture_encoded_digests", {})
    observed_encoded = observed["attestation"]["reference_fixture_encoded_digests"]
    return {
        "environment_id": stored["environment_id"],
        "expected_fingerprint_sha256": stored["fingerprint"]["fingerprint_sha256"],
        "observed_fingerprint_sha256": observed["fingerprint_sha256"],
        "matches_canonical_renderer": matches,
        "divergent_binding_components": divergent,
        "encoded_byte_parity": expected_encoded == observed_encoded,
        "encoded_byte_parity_is_binding": False,
        "measured_platform": observed["attestation"]["measured_platform"],
    }


def require_canonical_renderer(environment: dict[str, Any] | None = None) -> dict[str, Any]:
    """Refuse to continue unless the running environment is the frozen canonical renderer.

    Every future holdout generation path calls this before drawing a single pixel.
    """
    result = verify_fingerprint(environment)
    if not result["matches_canonical_renderer"]:
        raise RendererFingerprintMismatch(
            "renderer environment does not match the frozen canonical renderer; divergent components: "
            + ", ".join(result["divergent_binding_components"])
        )
    return {"fingerprint_sha256": result["observed_fingerprint_sha256"], **result}
