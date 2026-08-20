from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


def _task_result(task_id: str | None, *, error_code: str | None = None) -> dict[str, Any]:
    extraction = None
    error = None
    if error_code is None:
        extraction = {
            "schema_version": "assistive-document-extraction/v1",
            "status": "OCR_REQUIRED",
            "source": "NONE",
            "document_type": "PNG",
            "page_count": 1,
            "text": "",
            "blocks": [],
            "native_quality": "NOT_APPLICABLE",
            "quality_evidence": None,
            "ocr_state": "REQUIRED_NOT_RUN",
            "provider": None,
            "warnings": [],
            "error": None,
        }
    else:
        error = {"code": error_code, "message": "Bounded test worker result."}
    return {
        "schema_version": "assistive-worker-task-result/v1",
        "task_id": task_id,
        "extraction": extraction,
        "error": error,
        "duration_ms": 1,
    }


def _write(value: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(value, separators=(",", ":")))
    sys.stdout.write("\n")
    sys.stdout.flush()


def main() -> int:
    scenario = sys.argv[1]
    task = json.load(sys.stdin)
    task_id = task.get("task_id")

    if scenario == "execution-failed":
        _write(_task_result(task_id, error_code="TASK_EXECUTION_FAILED"))
        return 1
    if scenario == "contract-rejected":
        _write(_task_result(None, error_code="TASK_CONTRACT_REJECTED"))
        return 2
    if scenario == "success-exit-one":
        _write(_task_result(task_id))
        return 1
    if scenario == "unexpected-exit":
        return 7
    if scenario == "signal":
        os.kill(os.getpid(), signal.SIGTERM)
        time.sleep(1)
        return 143
    if scenario == "malformed":
        sys.stdout.write("{\n")
        sys.stdout.flush()
        return 0
    if scenario == "oversized-stdout":
        sys.stdout.write("x" * ((4 * 1024 * 1024) + 1))
        sys.stdout.flush()
        return 0
    if scenario == "hang":
        marker = Path(sys.argv[2])
        subprocess.Popen(
            [
                sys.executable,
                "-c",
                "import pathlib,sys,time;time.sleep(1);pathlib.Path(sys.argv[1]).write_text('survived')",
                str(marker),
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        Path(f"{marker}.ready").write_text("ready", encoding="utf-8")
        while True:
            time.sleep(1)
    raise ValueError("unknown process shim scenario")


if __name__ == "__main__":
    raise SystemExit(main())
