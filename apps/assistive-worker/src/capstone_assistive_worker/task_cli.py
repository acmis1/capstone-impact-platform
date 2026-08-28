from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from pathlib import Path
from typing import Any, Mapping

from .ocr.contract import OcrAvailabilityState
from .ocr.paddle_title import PaddleTitleOcrProvider
from .ocr.tesseract import TesseractProvider
from .service import extract_staged_document
from .task_contract import (
    MAX_TASK_BYTES,
    OcrProviderSelection,
    TaskErrorCode,
    WorkerTask,
    WorkerTaskError,
    WorkerTaskResult,
)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run one bounded assistive extraction task")
    parser.add_argument("--staging-root", type=Path)
    parser.add_argument("--tesseract-executable", type=Path)
    parser.add_argument("--paddle-models-dir", type=Path)
    parser.add_argument("--health", action="store_true")
    return parser


def _write_json(value: Mapping[str, Any]) -> None:
    sys.stdout.write(json.dumps(value, separators=(",", ":"), sort_keys=True))
    sys.stdout.write("\n")
    sys.stdout.flush()


def _parent_alive(parent_pid: int) -> bool:
    if os.getppid() != parent_pid:
        return False
    try:
        os.kill(parent_pid, 0)
    except (OSError, ProcessLookupError):
        return False
    return True


def _start_parent_watchdog() -> None:
    raw_parent_pid = os.environ.pop("CAPSTONE_ASSISTIVE_PARENT_PID", None)
    if raw_parent_pid is None:
        return
    try:
        parent_pid = int(raw_parent_pid)
    except ValueError:
        os._exit(143)
    if parent_pid < 1:
        os._exit(143)

    def watch() -> None:
        while True:
            time.sleep(1)
            if not _parent_alive(parent_pid):
                os._exit(143)

    threading.Thread(target=watch, name="assistive-parent-watchdog", daemon=True).start()


def _read_task() -> WorkerTask:
    payload = sys.stdin.buffer.read(MAX_TASK_BYTES + 1)
    if not payload or len(payload) > MAX_TASK_BYTES:
        raise ValueError("task input is empty or exceeds the byte limit")
    try:
        raw = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("task input is not valid UTF-8 JSON") from error
    if not isinstance(raw, dict):
        raise ValueError("task input must be an object")
    return WorkerTask.from_dict(raw)


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.health:
        provider_ready = args.paddle_models_dir is None or (
            PaddleTitleOcrProvider(models_dir=args.paddle_models_dir).availability().state
            is OcrAvailabilityState.AVAILABLE
        )
        _write_json({
            "schema_version": "assistive-worker-health/v1",
            "status": "OK" if provider_ready else "UNHEALTHY",
        })
        return 0 if provider_ready else 1
    if args.staging_root is None:
        _write_json(
            WorkerTaskResult(
                task_id=None,
                extraction=None,
                error=WorkerTaskError(TaskErrorCode.TASK_CONTRACT_REJECTED, "A staging root is required."),
                duration_ms=0,
            ).to_dict()
        )
        return 2

    _start_parent_watchdog()
    started = time.monotonic()
    try:
        task = _read_task()
    except ValueError:
        result = WorkerTaskResult(
            task_id=None,
            extraction=None,
            error=WorkerTaskError(
                TaskErrorCode.TASK_CONTRACT_REJECTED,
                "The worker task contract was rejected.",
            ),
            duration_ms=max(0, int((time.monotonic() - started) * 1000)),
        )
        _write_json(result.to_dict())
        return 2

    try:
        provider = None
        if task.ocr_provider is OcrProviderSelection.TESSERACT:
            provider = TesseractProvider(executable=args.tesseract_executable)
        elif task.ocr_provider is OcrProviderSelection.PADDLE_TITLE:
            provider = PaddleTitleOcrProvider(models_dir=args.paddle_models_dir)
        extraction = extract_staged_document(
            allowed_root=args.staging_root,
            relative_path=task.relative_path,
            claimed_media_type=task.document_type,
            ocr_provider=provider,
            raster_dpi=task.raster_dpi,
        )
        result = WorkerTaskResult(
            task_id=task.task_id,
            extraction=extraction,
            error=None,
            duration_ms=max(0, int((time.monotonic() - started) * 1000)),
        )
        _write_json(result.to_dict())
        return 0
    except Exception:
        result = WorkerTaskResult(
            task_id=task.task_id,
            extraction=None,
            error=WorkerTaskError(
                TaskErrorCode.TASK_EXECUTION_FAILED,
                "The worker task failed safely.",
            ),
            duration_ms=max(0, int((time.monotonic() - started) * 1000)),
        )
        _write_json(result.to_dict())
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
