from __future__ import annotations

import hashlib
import importlib.metadata
import os
import shutil
import tarfile
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path, PurePosixPath
from typing import Any

from .schema import file_sha256, load_json, validate_artifact_manifest, value_sha256


MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
MAX_EXTRACTED_BYTES = 1024 * 1024 * 1024
MAX_ARCHIVE_MEMBERS = 32
OFFICIAL_MODEL_HOST = "paddle-model-ecology.bj.bcebos.com"


def tree_sha256(path: Path) -> str:
    if not path.is_dir():
        raise ValueError(f"model directory is missing: {path.name}")
    digest = hashlib.sha256()
    files = sorted(item for item in path.rglob("*") if item.is_file())
    if not files:
        raise ValueError(f"model directory is empty: {path.name}")
    for file in files:
        relative = file.relative_to(path).as_posix()
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(str(file.stat().st_size).encode("ascii"))
        digest.update(b"\0")
        digest.update(bytes.fromhex(file_sha256(file)))
        digest.update(b"\0")
    return digest.hexdigest()


def directory_bytes(path: Path) -> int:
    return sum(item.stat().st_size for item in path.rglob("*") if item.is_file())


def _download(artifact: dict[str, Any], archive_path: Path) -> None:
    parsed = urllib.parse.urlparse(artifact["url"])
    if parsed.scheme != "https" or parsed.hostname != OFFICIAL_MODEL_HOST or parsed.username or parsed.password:
        raise ValueError("model artifact URL is outside the official allowlist")
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            prefix="pp1-ocr-",
            suffix=".tar",
            dir=archive_path.parent,
            delete=False,
        ) as output:
            temporary = Path(output.name)
            request = urllib.request.Request(artifact["url"], headers={"User-Agent": "pp1-ocr-provision/v1"})
            with urllib.request.urlopen(request, timeout=60) as response:
                total = 0
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_ARCHIVE_BYTES:
                        raise ValueError("model archive exceeded the provisioning byte limit")
                    output.write(chunk)
            output.flush()
            os.fsync(output.fileno())
        if total != artifact["archive_bytes"] or file_sha256(temporary) != artifact["archive_sha256"]:
            raise ValueError("downloaded model archive failed frozen size or SHA-256 verification")
        temporary.replace(archive_path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _safe_extract(artifact: dict[str, Any], archive_path: Path, models_dir: Path) -> Path:
    expected_root = artifact["layout"]
    destination = models_dir / expected_root
    if destination.exists():
        if not destination.is_dir():
            raise ValueError("model destination exists but is not a directory")
        return destination
    models_dir.mkdir(parents=True, exist_ok=True)
    temporary_root = Path(tempfile.mkdtemp(prefix=f".{expected_root}-", dir=models_dir))
    try:
        with tarfile.open(archive_path, mode="r:") as archive:
            members = archive.getmembers()
            if not members or len(members) > MAX_ARCHIVE_MEMBERS:
                raise ValueError("model archive member count is outside the provisioning bound")
            total = 0
            for member in members:
                path = PurePosixPath(member.name)
                if path.is_absolute() or ".." in path.parts or not path.parts or path.parts[0] != expected_root:
                    raise ValueError("model archive contains an unsafe or unexpected path")
                if member.issym() or member.islnk() or member.isdev():
                    raise ValueError("model archive links and device entries are forbidden")
                if not (member.isdir() or member.isfile()):
                    raise ValueError("model archive contains an unsupported member type")
                total += member.size
                if total > MAX_EXTRACTED_BYTES:
                    raise ValueError("model archive exceeds the extracted byte limit")
                target = temporary_root.joinpath(*path.parts)
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                source = archive.extractfile(member)
                if source is None:
                    raise ValueError("model archive file could not be read")
                with source, target.open("xb") as output:
                    shutil.copyfileobj(source, output, length=1024 * 1024)
        extracted = temporary_root / expected_root
        if not extracted.is_dir():
            raise ValueError("model archive did not produce the expected root")
        extracted.replace(destination)
        return destination
    finally:
        shutil.rmtree(temporary_root, ignore_errors=True)


def prepare_models(
    manifest_path: Path,
    *,
    archives_dir: Path,
    models_dir: Path,
    allow_download: bool,
    allow_unfrozen_trees: bool = False,
) -> dict[str, Any]:
    manifest = validate_artifact_manifest(load_json(manifest_path), allow_unfrozen_trees=allow_unfrozen_trees)
    results = []
    for artifact in manifest["artifacts"]:
        archive_path = archives_dir / f"{artifact['id']}.tar"
        if not archive_path.is_file():
            if not allow_download:
                raise ValueError(f"archive is absent in offline mode: {archive_path.name}")
            _download(artifact, archive_path)
        if archive_path.stat().st_size != artifact["archive_bytes"] or file_sha256(archive_path) != artifact["archive_sha256"]:
            raise ValueError(f"archive verification failed: {archive_path.name}")
        destination = _safe_extract(artifact, archive_path, models_dir)
        observed_tree = tree_sha256(destination)
        expected_tree = artifact["tree_sha256"]
        if expected_tree != "TO_BE_FROZEN_AFTER_SAFE_EXTRACTION" and observed_tree != expected_tree:
            raise ValueError(f"extracted model tree verification failed: {artifact['id']}")
        results.append(
            {
                "id": artifact["id"],
                "archive_bytes": archive_path.stat().st_size,
                "archive_sha256": file_sha256(archive_path),
                "tree_sha256": observed_tree,
                "extracted_bytes": directory_bytes(destination),
                "layout": artifact["layout"],
            }
        )
    return {
        "schema_version": "pp1-ocr-provisioning-result/v1",
        "artifact_manifest_sha256": value_sha256(manifest),
        "allow_download": allow_download,
        "archives_retained": True,
        "models": results,
    }


def verify_runtime_versions() -> dict[str, str]:
    observed = {
        "paddleocr": importlib.metadata.version("paddleocr"),
        "paddlepaddle": importlib.metadata.version("paddlepaddle"),
        "paddlex": importlib.metadata.version("paddlex"),
    }
    if observed != {"paddleocr": "3.7.0", "paddlepaddle": "3.3.0", "paddlex": "3.7.2"}:
        raise ValueError(f"Paddle runtime version mismatch: {observed}")
    return observed
