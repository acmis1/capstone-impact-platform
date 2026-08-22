"""The machine-readable protocol-freeze manifest and its commit-identity proof.

The manifest binds the exact content of every component whose later change could move a
holdout result: the protocol, the holdout schema and generator, the selected model artifacts,
the runtime pins, the raster/selector/reading-order/title-safety/metric sources, the
operational gate implementation, the canonical renderer definition and the pinned font. It
deliberately binds no production code.

Identity is content-addressed first. ``main`` squash-merges, so the freeze commit created on
this branch does not survive as an ancestor of ``main``; ``freeze_tree_sha256`` does. The
commit SHA is recorded as supporting evidence and verified only while the object is reachable.
"""

from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path
from typing import Any

from .schema import (
    HOLDOUT_CASE_ID,
    canonical_json_bytes,
    data_root,
    file_sha256,
    normalized_text_file_sha256,
    repository_root,
    tool_root,
    value_sha256,
)


MANIFEST_SCHEMA_VERSION = "pp1-ocr-iteration2-holdout-freeze-manifest/v1"
FREEZE_COMMIT_SCHEMA_VERSION = "pp1-ocr-iteration2-holdout-freeze-commit/v2"
TEXT_SUFFIXES = {".py", ".json", ".toml", ".txt", ".md"}

SUPERSEDED_FREEZE = {
    "protocol_freeze_commit_sha": "ab9ee241c6ea70f00c8e4fe063ef28c73b37802a",
    "chronology_commit_sha": "b08c8fa3723a9c16157944de8f3d4a362fa03bc6",
    "freeze_manifest_sha256": "c7c5783bd8f75a904f25613aa03c247b54b833517d2754f8b8d3bb8ccb1bc318",
    "freeze_tree_sha256": "41493ccd8c2dea0057740af6fe514255fbbbf70318e8e35bfd0cae0424131fe5",
    "freeze_commit_record_sha256": "5473d41c1bc1572a9735450640062b3d2e0eda2b7d83ce338990c8d3eb5bb62f",
    "component_count": 29,
    "holdout_absent_at_freeze": True,
    "superseded": True,
    "supersession_reason": (
        "the first exact-head Ubuntu CI run disproved the original cross-platform render-pixel "
        "equality assertion before any fresh holdout existed"
    ),
}

# Roles make the manifest auditable: a reviewer can see *why* each file is bound.
FROZEN_ROLES: tuple[tuple[str, str], ...] = (
    ("ocr-iteration2-holdout-protocol/protocol.json", "protocol_file"),
    ("ocr-iteration2-holdout-protocol/renderer-environment.json", "canonical_renderer_definition"),
    ("src/assistive_validation_benchmark/ocr_iteration2_holdout_protocol/__init__.py", "protocol_freeze_source"),
    ("src/assistive_validation_benchmark/ocr_iteration2_holdout_protocol/schema.py", "protocol_freeze_source"),
    ("src/assistive_validation_benchmark/ocr_iteration2_holdout_protocol/holdout_contract.py", "holdout_schema_and_generator_contract"),
    ("src/assistive_validation_benchmark/ocr_iteration2_holdout_protocol/renderer.py", "renderer_and_reference_fixture"),
    ("src/assistive_validation_benchmark/ocr_iteration2_holdout_protocol/fingerprint.py", "renderer_fingerprint"),
    ("src/assistive_validation_benchmark/ocr_iteration2_holdout_protocol/manifest.py", "freeze_manifest"),
    ("src/assistive_validation_benchmark/ocr_iteration2_holdout_protocol/report.py", "freeze_evidence"),
    ("src/assistive_validation_benchmark/ocr_iteration2_holdout_protocol/__main__.py", "freeze_command_surface"),
    ("ocr-productionization/artifact-manifest.json", "ocr_candidate_artifact_manifest"),
    ("src/assistive_validation_benchmark/ocr_productionization/schema.py", "artifact_manifest_validation"),
    ("src/assistive_validation_benchmark/ocr_productionization/provision.py", "offline_provisioning_and_artifact_verification"),
    ("src/assistive_validation_benchmark/ocr_productionization/offline.py", "offline_network_guard"),
    ("src/assistive_validation_benchmark/ocr_productionization/engine.py", "ocr_engine_runtime_configuration"),
    ("src/assistive_validation_benchmark/ocr_productionization/title_safety.py", "title_normalization_and_safety"),
    ("src/assistive_validation_benchmark/ocr_failure_analysis/selectors.py", "title_candidate_selector"),
    ("src/assistive_validation_benchmark/ocr_failure_analysis/ordering.py", "deterministic_reading_order"),
    ("src/assistive_validation_benchmark/ocr_iteration2_calibration/scoring.py", "metrics_and_operational_gate"),
    ("src/assistive_validation_benchmark/ocr_iteration2_calibration/capture.py", "raster_and_capture_pipeline"),
    ("src/assistive_validation_benchmark/ocr_iteration2_calibration/corpus.py", "renderer_primitives_and_raster_adapter"),
    ("src/assistive_validation_benchmark/ocr_iteration2_calibration/schema.py", "calibration_bounds_and_hashing"),
    ("src/assistive_validation_benchmark/core.py", "word_error_rate_normalization_and_edit_distance"),
    ("src/assistive_validation_benchmark/engines.py", "process_memory_measurement"),
    ("ocr-iteration2-calibration/protocol.json", "calibration_ceilings_and_raster_matrix"),
    ("ocr-iteration2-calibration/font/manifest.json", "pinned_font_manifest"),
    ("ocr-iteration2-calibration/font/NotoSans-Regular.ttf", "pinned_font_blob"),
    ("ocr-iteration2-calibration/font/OFL.txt", "pinned_font_license"),
    ("pyproject.toml", "benchmark_runtime_dependency_pins"),
)


def frozen_paths() -> list[Path]:
    return [tool_root() / relative for relative, _ in FROZEN_ROLES]


def _content(path: Path) -> bytes:
    """Git-normalised content: LF for tracked text, raw bytes for binary."""
    data = path.read_bytes()
    return data.replace(b"\r\n", b"\n") if path.suffix.casefold() in TEXT_SUFFIXES else data


def _git_blob_sha1(path: Path) -> str:
    """Git blob id of the normalised content, computed without invoking git."""
    data = _content(path)
    return hashlib.sha1(b"blob " + str(len(data)).encode("ascii") + b"\0" + data).hexdigest()


def _content_sha256(path: Path) -> str:
    if path.suffix.casefold() in TEXT_SUFFIXES:
        return normalized_text_file_sha256(path)
    return file_sha256(path)


def build_entries() -> dict[str, dict[str, Any]]:
    root = repository_root()
    entries: dict[str, dict[str, Any]] = {}
    for relative, role in FROZEN_ROLES:
        path = tool_root() / relative
        if not path.is_file():
            raise ValueError(f"frozen protocol component is missing: {relative}")
        entries[path.relative_to(root).as_posix()] = {
            "role": role,
            "bytes": len(_content(path)),
            "sha256": _content_sha256(path),
            "git_blob_sha1": _git_blob_sha1(path),
        }
    return entries


def freeze_tree_sha256(entries: dict[str, dict[str, Any]]) -> str:
    """One content-addressed digest over every frozen file. Survives a squash merge."""
    digest = hashlib.sha256()
    for relative in sorted(entries):
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(bytes.fromhex(entries[relative]["sha256"]))
        digest.update(b"\0")
    return digest.hexdigest()


def build_freeze_manifest() -> dict[str, Any]:
    from . import PROTOCOL_VERSION

    entries = build_entries()
    return {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "protocol_version": PROTOCOL_VERSION,
        "binds_production_code": False,
        "hash_algorithms": {
            "sha256": "SHA-256 over git-normalised content (LF for text, raw bytes for binary)",
            "git_blob_sha1": "git blob object id over the same normalised content",
        },
        "component_count": len(entries),
        "components": entries,
        "freeze_tree_sha256": freeze_tree_sha256(entries),
    }


def manifest_path() -> Path:
    return data_root() / "freeze-manifest.json"


def verify_freeze_manifest(stored: dict[str, Any]) -> dict[str, Any]:
    """Recompute every bound component and name the first one that changed."""
    if stored.get("schema_version") != MANIFEST_SCHEMA_VERSION:
        raise ValueError("unsupported freeze manifest schema")
    if stored.get("binds_production_code") is not False:
        raise ValueError("the freeze manifest may not bind production code")
    observed = build_entries()
    stored_components = stored.get("components", {})
    if set(stored_components) != set(observed):
        difference = sorted(set(stored_components) ^ set(observed))
        raise ValueError(f"freeze manifest component set changed: {difference}")
    for relative, entry in observed.items():
        if stored_components[relative] != entry:
            raise ValueError(f"frozen protocol component changed after the freeze: {relative}")
    expected_tree = freeze_tree_sha256(observed)
    if stored.get("freeze_tree_sha256") != expected_tree:
        raise ValueError("stored freeze tree digest does not follow its own components")
    if stored.get("component_count") != len(observed):
        raise ValueError("stored freeze component count does not follow its own components")
    return {
        "component_count": len(observed),
        "freeze_tree_sha256": expected_tree,
        "freeze_manifest_sha256": value_sha256(stored),
        "binds_production_code": False,
    }


def _git(arguments: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *arguments],
        cwd=repository_root(),
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        encoding="utf-8",
        shell=False,
        check=check,
    )


def _holdout_paths_at(commit: str) -> list[str]:
    relative_root = data_root().relative_to(repository_root()).as_posix()
    listing = _git(["ls-tree", "-r", "--name-only", commit, "--", relative_root], check=False)
    if listing.returncode != 0:
        return []
    forbidden = []
    for line in listing.stdout.splitlines():
        name = Path(line).name
        if name.casefold() == "holdout.json" or HOLDOUT_CASE_ID.fullmatch(Path(line).stem):
            forbidden.append(line)
    return forbidden


def verify_freeze_commit(commit: str, *, require_commit_object: bool = False) -> dict[str, Any]:
    """Prove the frozen files existed, unchanged, at the freeze commit, before any holdout.

    After a squash merge the branch commit is no longer reachable from ``main``. That is
    expected, not a failure: the content-addressed tree digest remains the durable proof, and
    this function reports the commit check as unavailable rather than inventing a result.
    """
    manifest = build_freeze_manifest()
    resolved = _git(["rev-parse", "--verify", "--quiet", f"{commit}^{{commit}}"], check=False)
    reachable = resolved.returncode == 0 and resolved.stdout.strip() == commit
    if not reachable:
        if require_commit_object:
            raise ValueError(f"protocol freeze commit is not a reachable full commit SHA: {commit}")
        return {
            "protocol_freeze_commit_sha": commit,
            "commit_object_reachable": False,
            "verification_basis": "content_addressed_freeze_tree_only",
            "freeze_tree_sha256": manifest["freeze_tree_sha256"],
            "component_count": manifest["component_count"],
            "holdout_absent_at_freeze": None,
        }
    checked = 0
    for relative, entry in manifest["components"].items():
        frozen = _git(["rev-parse", f"{commit}:{relative}"], check=False)
        if frozen.returncode != 0:
            raise ValueError(f"frozen component did not exist at the freeze commit: {relative}")
        if frozen.stdout.strip() != entry["git_blob_sha1"]:
            raise ValueError(f"frozen component changed after the protocol freeze commit: {relative}")
        checked += 1
    forbidden = _holdout_paths_at(commit)
    if forbidden:
        raise ValueError(f"fresh holdout content already existed at the protocol freeze commit: {forbidden}")
    return {
        "protocol_freeze_commit_sha": commit,
        "commit_object_reachable": True,
        "verification_basis": "git_blob_identity_and_content_addressed_freeze_tree",
        "freeze_tree_sha256": manifest["freeze_tree_sha256"],
        "component_count": checked,
        "holdout_absent_at_freeze": True,
    }


def _validate_superseded_record(stored: dict[str, Any]) -> None:
    if stored.get("schema_version") != "pp1-ocr-iteration2-holdout-freeze-commit/v1":
        raise ValueError("the superseded chronology record is not the preserved v1 record")
    if value_sha256(stored) != SUPERSEDED_FREEZE["freeze_commit_record_sha256"]:
        raise ValueError("the superseded chronology record changed before correction")
    for key in (
        "protocol_freeze_commit_sha",
        "freeze_manifest_sha256",
        "freeze_tree_sha256",
        "component_count",
        "holdout_absent_at_freeze",
    ):
        if stored.get(key) != SUPERSEDED_FREEZE[key]:
            raise ValueError(f"the superseded chronology record changed: {key}")


def build_freeze_commit_record(commit: str, superseded_record: dict[str, Any]) -> dict[str, Any]:
    from . import PROTOCOL_VERSION

    _validate_superseded_record(superseded_record)
    manifest = build_freeze_manifest()
    verification = verify_freeze_commit(commit, require_commit_object=True)
    return {
        "schema_version": FREEZE_COMMIT_SCHEMA_VERSION,
        "protocol_version": PROTOCOL_VERSION,
        "recorded_by": "iteration 2B2 corrected freeze chronology commit D",
        "chronology": (
            "commits A and B preserve the original pre-review freeze and record; exact-head CI then "
            "exposed a renderer-platform defect before any holdout existed; commit C is the corrected "
            "authoritative freeze and commit D adds only this supersession record"
        ),
        "durable_identity": "freeze_tree_sha256",
        "commit_sha_is_branch_local": True,
        "freeze_manifest_sha256": value_sha256(manifest),
        "original_history_preserved": True,
        "supersedes": SUPERSEDED_FREEZE,
        **verification,
    }


def validate_freeze_commit_record(stored: dict[str, Any]) -> dict[str, Any]:
    if stored.get("schema_version") != FREEZE_COMMIT_SCHEMA_VERSION:
        raise ValueError("unsupported freeze commit record schema")
    manifest = build_freeze_manifest()
    if stored.get("freeze_tree_sha256") != manifest["freeze_tree_sha256"]:
        raise ValueError("recorded freeze tree digest no longer matches the frozen components")
    if stored.get("freeze_manifest_sha256") != value_sha256(manifest):
        raise ValueError("recorded freeze manifest digest no longer matches the frozen components")
    if stored.get("component_count") != manifest["component_count"]:
        raise ValueError("recorded freeze component count no longer matches the frozen components")
    if stored.get("holdout_absent_at_freeze") is not True:
        raise ValueError("the freeze commit record does not prove holdout absence at the corrected freeze")
    if stored.get("original_history_preserved") is not True:
        raise ValueError("the corrected freeze must preserve the original A/B history")
    if stored.get("supersedes") != SUPERSEDED_FREEZE:
        raise ValueError("the corrected freeze supersession record changed")
    reachable = verify_freeze_commit(stored["protocol_freeze_commit_sha"])
    if reachable["commit_object_reachable"] and reachable["holdout_absent_at_freeze"] is not True:
        raise ValueError("fresh holdout content existed at the corrected freeze commit")
    return {
        "protocol_freeze_commit_sha": stored["protocol_freeze_commit_sha"],
        "freeze_tree_sha256": stored["freeze_tree_sha256"],
        "content_addressed_match": True,
        "holdout_absent_at_freeze": True,
        "superseded_protocol_freeze_commit_sha": SUPERSEDED_FREEZE["protocol_freeze_commit_sha"],
        "original_history_preserved": True,
    }


def verify_candidate_artifacts(protocol: dict[str, Any], models_dir: Path) -> dict[str, Any]:
    """Verify the frozen PP-OCRv6 Small model trees offline. No download, no other candidate.

    The future holdout run calls this before OCR so a substituted, upgraded or corrupted model
    cannot silently produce the one-shot result.
    """
    from ..ocr_productionization.provision import directory_bytes, tree_sha256

    candidate = protocol["candidate"]
    pairs = (
        (candidate["detection_artifact"], candidate["detection_tree_sha256"]),
        (candidate["recognition_artifact"], candidate["recognition_tree_sha256"]),
    )
    observed = []
    footprint = 0
    for artifact, expected in pairs:
        directory = models_dir / artifact
        digest = tree_sha256(directory)
        if digest != expected:
            raise ValueError(f"frozen candidate model tree verification failed: {artifact}")
        extracted = directory_bytes(directory)
        footprint += extracted
        observed.append({"artifact": artifact, "tree_sha256": digest, "extracted_bytes": extracted})
    if footprint != candidate["artifact_footprint_bytes"]:
        raise ValueError(f"frozen candidate footprint changed: {footprint}")
    return {
        "engine": candidate["engine"],
        "artifacts": observed,
        "artifact_footprint_bytes": footprint,
        "downloaded_during_verification": False,
    }


def write_freeze_manifest() -> Path:
    target = manifest_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(canonical_json_bytes(build_freeze_manifest()))
    return target
