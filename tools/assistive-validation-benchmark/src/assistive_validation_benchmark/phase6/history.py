from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

HISTORY_SCHEMA_VERSION = 1
LOCK_SCHEMA_VERSION = 1


def history_dir(tool_root: Path) -> Path:
    return tool_root / "phase6" / "history"


def normalise_holdout_text(text: str) -> str:
    """Whitespace- and case-insensitive form used to compare holdout texts across iterations."""
    return " ".join(text.split()).casefold()


def holdout_text_digest(text: str) -> str:
    return hashlib.sha256(normalise_holdout_text(text).encode("utf-8")).hexdigest()


def load_benchmark_history(tool_root: Path) -> dict[str, Any]:
    data = json.loads((history_dir(tool_root) / "benchmark-history.json").read_text(encoding="utf-8"))
    if data.get("history_schema_version") != HISTORY_SCHEMA_VERSION:
        raise ValueError("Phase 6 benchmark history schema is invalid")
    superseded = data.get("superseded")
    if not isinstance(superseded, list) or not superseded:
        raise ValueError("Phase 6 benchmark history must preserve every superseded attempt")
    versions = [entry.get("corpus_version") for entry in superseded]
    if len(versions) != len(set(versions)) or not all(isinstance(value, str) and value for value in versions):
        raise ValueError("Superseded corpus versions must be unique non-empty strings")
    for entry in superseded:
        if not str(entry.get("superseded_reason", "")).strip():
            raise ValueError(f"{entry.get('corpus_version')} needs an explicit supersession reason")
        if not str(entry.get("manifest_sha256", "")).strip():
            raise ValueError(f"{entry.get('corpus_version')} needs its frozen manifest hash")
    return data


def load_exposed_holdout_texts(tool_root: Path) -> dict[str, list[str]]:
    """Return every already-scored holdout text digest mapped to the iterations that used it."""
    data = json.loads((history_dir(tool_root) / "superseded-holdout-texts.json").read_text(encoding="utf-8"))
    if data.get("lock_schema_version") != LOCK_SCHEMA_VERSION:
        raise ValueError("Phase 6 superseded holdout lock schema is invalid")
    exposed = data.get("exposed_texts")
    if not isinstance(exposed, list) or not exposed:
        raise ValueError("Phase 6 superseded holdout lock must list the exposed texts")
    digests: dict[str, list[str]] = {}
    for entry in exposed:
        digest = entry.get("normalised_sha256")
        if not isinstance(digest, str) or len(digest) != 64:
            raise ValueError("Exposed holdout entries need a SHA-256 digest")
        digests[digest] = list(entry.get("case_ids", []))
    return digests


def check_holdout_independence(manifest: dict[str, Any], exposed: dict[str, list[str]]) -> dict[str, Any]:
    """Reject any holdout case whose text was already scored in a *different* iteration.

    A corpus that is itself recorded in the lock is being re-checked against its own texts, so
    only exposure by another corpus version counts as reuse.
    """
    version = manifest["corpus_version"]
    foreign = {
        digest: case_ids
        for digest, case_ids in exposed.items()
        if not any(case_id.split(":", 1)[0] == version for case_id in case_ids)
    }
    holdout = [case for case in manifest["grammar_cases"] if case["split"] == "holdout"]
    reused: list[str] = []
    for case in holdout:
        digest = holdout_text_digest(case["source_text"])
        if digest in foreign:
            reused.append(f"{case['id']} reuses text previously scored as {', '.join(foreign[digest])}")
    if reused:
        raise ValueError("Fresh holdout reuses superseded holdout text: " + "; ".join(reused))
    digests = [holdout_text_digest(case["source_text"]) for case in holdout]
    if len(digests) != len(set(digests)):
        raise ValueError("Holdout cases must not duplicate each other")
    return {
        "holdout_cases": len(holdout),
        "exposed_texts_checked": len(foreign),
        "reused_texts": 0,
    }


def load_policy_freeze(tool_root: Path) -> dict[str, Any] | None:
    """Read the recorded policy-freeze commit, which only exists once a holdout has been measured."""
    path = history_dir(tool_root) / "policy-freeze.json"
    if not path.is_file():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    sha = data.get("policy_freeze_commit_sha")
    if not isinstance(sha, str) or len(sha) != 40 or not all(char in "0123456789abcdef" for char in sha):
        raise ValueError("policy_freeze_commit_sha must be a full lowercase commit SHA")
    return data


def check_policy_freeze(tool_root: Path, policy_path: Path) -> dict[str, Any]:
    """Confirm the frozen policy on disk is byte-identical to the one recorded at the freeze commit."""
    freeze = load_policy_freeze(tool_root)
    if freeze is None:
        raise ValueError("Phase 6 policy freeze record is missing; a final holdout may not be published")
    actual = hashlib.sha256(policy_path.read_bytes()).hexdigest()
    if freeze.get("vocabulary_policy_sha256") != actual:
        raise ValueError(
            "Vocabulary policy changed after the recorded freeze commit "
            f"({freeze.get('vocabulary_policy_sha256')} recorded, {actual} on disk)"
        )
    return freeze
