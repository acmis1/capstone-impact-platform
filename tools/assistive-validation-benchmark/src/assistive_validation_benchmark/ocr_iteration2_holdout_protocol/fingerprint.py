"""Canonical renderer environment identity and the deterministic renderer fingerprint.

The merged Iteration 2 calibration proved byte-deterministic regeneration *within* one renderer
environment but not across operating systems or FreeType builds. This module closes that gap
without inventing infrastructure the repository does not have, and it does so by measurement
rather than assertion.

The pinned wheel toolchain is platform independent: an exact Python minor version, an exact
Pillow (which vendors its own FreeType, so the host font stack is never consulted), an exact
pypdfium2 (which vendors its own pdfium), the repository-pinned Noto Sans blob and the renderer
source itself. Those components are *binding everywhere* — a mismatch is always a failure.

The rendered pixels are not assumed to be platform independent. A reference fixture is rendered
and hashed, and the single canonical generation platform has an exact decoded-pixel profile.
Other platforms verify the platform-independent binding and repeat the measurement to prove
within-run determinism, but they are never authorised to generate the holdout.

Within a profile the binding digests are decoded-pixel digests, because decoded pixels are what
an OCR engine consumes. Encoded byte digests are recorded alongside them as attestation: an
image compressor may take a different optimised code path and emit different valid bytes for
identical pixels, and treating that as a renderer failure would be a false alarm.
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


ENVIRONMENT_SCHEMA_VERSION = "pp1-ocr-canonical-renderer-environment/v2"
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
PLATFORM_PROFILE_FIELDS = {
    "platform_id",
    "system",
    "machine",
    "python",
    "attested_at",
    "role",
    "reference_fixture_binding_digests",
    "reference_fixture_encoded_digests",
}


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


def platform_id() -> str:
    """Stable identity of a rendering platform profile."""
    return f"{platform.system()}-{platform.machine()}-cpython{sys.version_info.major}.{sys.version_info.minor}".lower()


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
    }
    profile = {
        "platform_id": platform_id(),
        "system": platform.system(),
        "machine": platform.machine(),
        "python": platform.python_version(),
        "reference_fixture_binding_digests": fixture["binding"],
        "reference_fixture_encoded_digests": fixture["attestation"],
    }
    return {
        "schema_version": ENVIRONMENT_SCHEMA_VERSION,
        "binding": binding,
        "fingerprint_sha256": value_sha256(binding),
        "measured_platform_profile": profile,
        "platform_fingerprint_sha256": value_sha256(
            {"platform_id": profile["platform_id"], "digests": fixture["binding"]}
        ),
    }


def _attested_index(value: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {entry["platform_id"]: entry for entry in value["attested_platforms"]}


def validate_environment(value: dict[str, Any]) -> dict[str, Any]:
    """Reject a canonical-renderer definition that is unpinned, unattested or host-font driven."""
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
    if value.get("render_digests_are_platform_specific") is not True:
        raise ValueError("the canonical renderer must state that rendered pixels are platform specific")
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
        raise ValueError("the canonical renderer must record at least one attested platform profile")
    seen: set[str] = set()
    for entry in platforms:
        if not isinstance(entry, dict) or set(entry) != PLATFORM_PROFILE_FIELDS:
            raise ValueError("an attested platform profile uses an unknown or missing field")
        if entry["platform_id"] in seen:
            raise ValueError(f"attested platform profile is duplicated: {entry['platform_id']}")
        seen.add(entry["platform_id"])
        for key in ("reference_fixture_binding_digests", "reference_fixture_encoded_digests"):
            if not isinstance(entry[key], dict) or not entry[key]:
                raise ValueError(f"attested platform profile {entry['platform_id']} has no {key}")
    generation = value.get("canonical_generation_platform")
    if generation not in seen:
        raise ValueError("the canonical generation platform must be one of the attested profiles")
    cross_platform = value.get("continuous_cross_platform_attestation", {})
    expected_policy = {
        "platform_independent_binding_required": True,
        "canonical_render_digest_parity_required": True,
        "noncanonical_render_digest_parity_required": False,
        "within_run_determinism_required": True,
    }
    for key, expected_value in expected_policy.items():
        if cross_platform.get(key) is not expected_value:
            raise ValueError(f"cross-platform renderer policy {key} must remain {expected_value}")
    return value


def _compare(expected: dict[str, Any], observed: dict[str, Any]) -> list[str]:
    return sorted(key for key in set(expected) | set(observed) if expected.get(key) != observed.get(key))


def verify_fingerprint(environment: dict[str, Any] | None = None) -> dict[str, Any]:
    """Compare the measured environment with the freeze and report every divergence.

    The platform-independent binding must always match. The canonical generation platform must
    additionally match its exact frozen decoded-pixel profile. A non-canonical platform may verify
    the freeze, but it may never generate holdout assets and its pixels are reported rather than
    compared with the canonical profile.
    """
    stored = validate_environment(environment if environment is not None else load_json(environment_path()))
    observed = compute_fingerprint()
    profile = observed["measured_platform_profile"]
    measured_id = profile["platform_id"]
    divergent = _compare(stored["fingerprint"]["binding"], observed["binding"])
    attested = _attested_index(stored)
    entry = attested.get(measured_id)
    divergent_digests = (
        _compare(entry["reference_fixture_binding_digests"], profile["reference_fixture_binding_digests"])
        if entry is not None
        else []
    )
    encoded_parity = (
        entry["reference_fixture_encoded_digests"] == profile["reference_fixture_encoded_digests"]
        if entry is not None
        else False
    )
    canonical = measured_id == stored["canonical_generation_platform"]
    platform_profile_matches = entry is not None and not divergent_digests
    binding_matches = not divergent
    return {
        "environment_id": stored["environment_id"],
        "expected_fingerprint_sha256": stored["fingerprint"]["fingerprint_sha256"],
        "observed_fingerprint_sha256": observed["fingerprint_sha256"],
        "binding_matches": binding_matches,
        "divergent_binding_components": divergent,
        "measured_platform_id": measured_id,
        "platform_attested": entry is not None,
        "divergent_platform_render_digests": divergent_digests,
        "render_digests_match_attested_profile": platform_profile_matches,
        "canonical_generation_platform": stored["canonical_generation_platform"],
        "is_canonical_generation_platform": canonical,
        "attested_platform_ids": sorted(attested),
        "matches_verification_environment": binding_matches and (not canonical or platform_profile_matches),
        "matches_attested_renderer": binding_matches and platform_profile_matches,
        "matches_canonical_renderer": binding_matches and canonical and platform_profile_matches,
        "encoded_byte_parity": encoded_parity,
        "encoded_byte_parity_is_binding": False,
        "measured_platform": {
            "system": profile["system"],
            "machine": profile["machine"],
            "python": profile["python"],
        },
        "measured_render_digests": profile["reference_fixture_binding_digests"],
        "measured_encoded_digests": profile["reference_fixture_encoded_digests"],
    }


def _refusal(result: dict[str, Any]) -> str:
    if result["divergent_binding_components"]:
        return "pinned toolchain diverges: " + ", ".join(result["divergent_binding_components"])
    if not result["platform_attested"]:
        return (
            f"platform {result['measured_platform_id']} is not an attested renderer profile; "
            f"attested: {', '.join(result['attested_platform_ids'])}"
        )
    if result["divergent_platform_render_digests"]:
        return "rendered pixels diverge from the attested profile: " + ", ".join(
            result["divergent_platform_render_digests"]
        )
    return (
        f"platform {result['measured_platform_id']} is attested but is not the canonical generation "
        f"platform {result['canonical_generation_platform']}"
    )


def require_verification_environment(environment: dict[str, Any] | None = None) -> dict[str, Any]:
    """Require the pinned binding, plus exact pixels when running on the canonical platform."""
    result = verify_fingerprint(environment)
    if not result["matches_verification_environment"]:
        raise RendererFingerprintMismatch("renderer verification environment diverged; " + _refusal(result))
    return result


def require_canonical_renderer(environment: dict[str, Any] | None = None) -> dict[str, Any]:
    """Refuse to continue unless this is the single canonical holdout generation environment.

    Every future holdout generation path calls this before drawing a single pixel. Being an
    attested platform is not enough: rendered pixels are platform specific, so exactly one
    profile may produce the holdout assets.
    """
    result = verify_fingerprint(environment)
    if not result["matches_canonical_renderer"]:
        raise RendererFingerprintMismatch(
            "refusing to generate holdout assets outside the canonical renderer; " + _refusal(result)
        )
    return {"fingerprint_sha256": result["observed_fingerprint_sha256"], **result}
