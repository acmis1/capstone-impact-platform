from __future__ import annotations

import hashlib
import json
import re
import subprocess
from pathlib import Path
from typing import Any

from .policy import canonical_json_bytes

FREEZE_SCHEMA_VERSION = 1
FREEZE_RECORD_SCHEMA_VERSION = 1
HEX_40 = re.compile(r"[0-9a-f]{40}")
HEX_64 = re.compile(r"[0-9a-f]{64}")
HOLDOUT_RELATIVE_PATHS = (
    "tools/assistive-validation-benchmark/phase7/corpus/holdout.json",
    "tools/assistive-validation-benchmark/phase7/freeze-record.json",
    "tools/assistive-validation-benchmark/phase7/one-shot-state.json",
    "docs/assistive-validation/evidence/phase-7-report.json",
    "docs/assistive-validation/phase-7-language-recovery-benchmark.md",
)


def repository_root(tool_root: Path) -> Path:
    return tool_root.parents[1]


def normalised_text_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest()


def frozen_paths(tool_root: Path) -> list[Path]:
    source_root = tool_root / "src" / "assistive_validation_benchmark"
    paths = [
        tool_root / "package.json",
        tool_root / "package-lock.json",
        tool_root / "phase6" / "harper_runner.mjs",
        tool_root / "phase6" / "corpus" / "manifest.json",
        tool_root / "phase6" / "history" / "superseded-holdout-texts.json",
        tool_root / "corpus" / "manifest.json",
        source_root / "engines.py",
        source_root / "phase6" / "corpus.py",
        source_root / "phase6" / "grammar.py",
        source_root / "phase6" / "history.py",
        source_root / "phase6" / "metrics.py",
        tool_root / "phase7" / "corpus" / "calibration.json",
        tool_root / "phase7" / "policy.json",
        tool_root / "phase7" / "calibration-evidence.json",
        tool_root / "tests" / "test_phase7.py",
        *sorted((source_root / "phase7").glob("*.py")),
    ]
    unique = sorted(set(paths), key=lambda path: path.as_posix())
    missing = [path for path in unique if not path.is_file()]
    if missing:
        raise ValueError("Phase 7 freeze component is missing: " + ", ".join(str(path) for path in missing))
    return unique


def _tree_sha256(entries: list[dict[str, Any]]) -> str:
    digest = hashlib.sha256()
    for entry in entries:
        digest.update(entry["path"].encode("utf-8"))
        digest.update(b"\0")
        digest.update(bytes.fromhex(entry["sha256"]))
    return digest.hexdigest()


def build_freeze_manifest(tool_root: Path) -> dict[str, Any]:
    root = repository_root(tool_root)
    entries = [
        {
            "path": path.relative_to(root).as_posix(),
            "sha256": normalised_text_sha256(path),
        }
        for path in frozen_paths(tool_root)
    ]
    return {
        "schema_version": FREEZE_SCHEMA_VERSION,
        "freeze_role": "language_policy_scorer_matcher_candidate_and_evidence_schema",
        "hash_policy": "sha256_of_utf8_text_with_crlf_normalised_to_lf",
        "entries": entries,
        "freeze_tree_sha256": _tree_sha256(entries),
        "forbidden_at_freeze": list(HOLDOUT_RELATIVE_PATHS),
    }


def validate_freeze_manifest(value: Any, tool_root: Path) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {
        "schema_version", "freeze_role", "hash_policy", "entries", "freeze_tree_sha256", "forbidden_at_freeze"
    }:
        raise ValueError("Phase 7 freeze manifest schema is closed")
    if value.get("schema_version") != FREEZE_SCHEMA_VERSION:
        raise ValueError("Phase 7 freeze manifest schema version changed")
    expected = build_freeze_manifest(tool_root)
    if value != expected:
        raise ValueError("Phase 7 frozen policy tree differs from the freeze manifest")
    return value


def write_freeze_manifest(tool_root: Path, output: Path) -> Path:
    value = build_freeze_manifest(tool_root)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(canonical_json_bytes(value))
    return output


def load_freeze_manifest(path: Path, tool_root: Path) -> dict[str, Any]:
    return validate_freeze_manifest(json.loads(path.read_text(encoding="utf-8")), tool_root)


def _git(root: Path, arguments: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *arguments],
        cwd=root,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        encoding="utf-8",
        shell=False,
        check=check,
    )


def verify_freeze_commit(tool_root: Path, freeze_sha: str, manifest: dict[str, Any]) -> dict[str, Any]:
    root = repository_root(tool_root)
    if not HEX_40.fullmatch(freeze_sha):
        raise ValueError("Phase 7 freeze SHA must be a full lowercase commit SHA")
    resolved = _git(root, ["rev-parse", f"{freeze_sha}^{{commit}}"]).stdout.strip()
    if resolved != freeze_sha:
        raise ValueError("Phase 7 freeze SHA did not resolve exactly")
    if _git(root, ["merge-base", "--is-ancestor", freeze_sha, "HEAD"], check=False).returncode != 0:
        raise ValueError("Phase 7 final measurement must descend from the policy freeze commit")
    checked = 0
    for entry in manifest["entries"]:
        relative = entry["path"]
        frozen_blob = _git(root, ["rev-parse", f"{freeze_sha}:{relative}"]).stdout.strip()
        working_blob = _git(root, ["hash-object", "--path", relative, relative]).stdout.strip()
        if frozen_blob != working_blob:
            raise ValueError(f"Phase 7 frozen component changed after holdout exposure: {relative}")
        checked += 1
    for relative in HOLDOUT_RELATIVE_PATHS:
        if _git(root, ["cat-file", "-e", f"{freeze_sha}:{relative}"], check=False).returncode == 0:
            raise ValueError(f"Fresh Phase 7 holdout material existed at the policy freeze: {relative}")
    return {
        "policy_freeze_commit_sha": freeze_sha,
        "freeze_tree_sha256": manifest["freeze_tree_sha256"],
        "frozen_file_count": checked,
        "holdout_paths_absent_at_freeze": list(HOLDOUT_RELATIVE_PATHS),
    }


def validate_freeze_record(value: Any, manifest: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {
        "schema_version", "policy_freeze_commit_sha", "freeze_tree_sha256", "holdout_absent_at_freeze"
    }:
        raise ValueError("Phase 7 freeze record schema is closed")
    if value.get("schema_version") != FREEZE_RECORD_SCHEMA_VERSION:
        raise ValueError("Phase 7 freeze record version changed")
    if not HEX_40.fullmatch(str(value.get("policy_freeze_commit_sha", ""))):
        raise ValueError("Phase 7 freeze record needs a full commit SHA")
    if value.get("freeze_tree_sha256") != manifest["freeze_tree_sha256"]:
        raise ValueError("Phase 7 freeze record tree hash differs from the frozen manifest")
    if value.get("holdout_absent_at_freeze") is not True:
        raise ValueError("Phase 7 freeze record must state the mechanically verified absence")
    return value
