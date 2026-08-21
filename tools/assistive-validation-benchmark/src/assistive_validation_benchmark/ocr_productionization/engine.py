from __future__ import annotations

import csv
import importlib.metadata
import json
import os
import platform
import shutil
import subprocess
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any, Callable

from ..core import levenshtein_distance, normalize_metric_text
from ..engines import current_process_peak_memory, run_command_measured
from .corpus import raster_path
from .offline import enable_offline_guard
from .provision import directory_bytes, verify_runtime_versions
from .title_safety import evaluate_title_safety, extract_title_candidates, normalize_metric_title


PADDLE_MODELS = {
    "paddle-tiny": ("PP-OCRv6_tiny_det", "PP-OCRv6_tiny_rec"),
    "paddle-small": ("PP-OCRv6_small_det", "PP-OCRv6_small_rec"),
    "paddle-medium": ("PP-OCRv6_medium_det", "PP-OCRv6_medium_rec"),
}


def _reference_text(case: dict[str, Any]) -> str:
    columns = {"one_column": 1, "two_column": 2, "three_column": 3}[case["layout"]]
    headings = " ".join(["BACKGROUND", "METHOD", "EVIDENCE"][:columns])
    return f"{case['title']}\n{headings}\n{case['body']}"


def _edit_counts(reference: str, hypothesis: str) -> dict[str, Any]:
    normalized_reference = normalize_metric_text(reference)
    normalized_hypothesis = normalize_metric_text(hypothesis)
    character_edits = levenshtein_distance(normalized_reference, normalized_hypothesis)
    reference_characters = len(normalized_reference)
    reference_words = normalized_reference.split()
    hypothesis_words = normalized_hypothesis.split()
    word_edits = levenshtein_distance(reference_words, hypothesis_words)
    return {
        "character_edits": character_edits,
        "reference_characters": reference_characters,
        "cer": character_edits / max(1, reference_characters),
        "word_edits": word_edits,
        "reference_words": len(reference_words),
        "wer": word_edits / max(1, len(reference_words)),
    }


def _tesseract_executable(configured: str | None) -> str:
    candidates = [configured, os.environ.get("TESSERACT_CMD"), shutil.which("tesseract")]
    if os.name == "nt":
        candidates.append(r"C:\Program Files\Tesseract-OCR\tesseract.exe")
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return str(Path(candidate).resolve())
    raise ValueError("Tesseract 5.5.3 executable is not provisioned")


def _parse_tesseract_tsv(payload: str) -> tuple[str, list[dict[str, Any]]]:
    lines: OrderedDict[tuple[str, str, str, str], list[dict[str, Any]]] = OrderedDict()
    rows = csv.DictReader(payload.splitlines(), delimiter="\t")
    for row in rows:
        text = (row.get("text") or "").strip()
        if not text:
            continue
        key = tuple(str(row.get(name, "")) for name in ("page_num", "block_num", "par_num", "line_num"))
        lines.setdefault(key, []).append(
            {
                "text": text,
                "left": int(row["left"]),
                "top": int(row["top"]),
                "width": int(row["width"]),
                "height": int(row["height"]),
            }
        )
        if len(lines) > 5000:
            raise ValueError("Tesseract line output exceeds the worker block bound")
    blocks = []
    for words in lines.values():
        left = min(word["left"] for word in words)
        top = min(word["top"] for word in words)
        right = max(word["left"] + word["width"] for word in words)
        bottom = max(word["top"] + word["height"] for word in words)
        blocks.append(
            {
                "page_number": 1,
                "text": " ".join(word["text"] for word in words),
                "box": {"left": left, "top": top, "right": right, "bottom": bottom},
            }
        )
    return "\n".join(block["text"] for block in blocks), blocks


def _run_tesseract(path: Path, executable: str, psm: int) -> dict[str, Any]:
    result = run_command_measured(
        [executable, str(path), "stdout", "--psm", str(psm), "-l", "eng", "tsv"],
        timeout=90,
    )
    if result["returncode"] != 0:
        raise ValueError("Tesseract returned a non-zero status")
    text, blocks = _parse_tesseract_tsv(result["stdout"])
    if len(text) > 100000:
        raise ValueError("Tesseract text exceeds the worker character bound")
    return {
        "text": text,
        "blocks": blocks,
        "runtime_ms": result["runtime_ms"],
        "peak_memory_bytes": result["peak_memory_bytes"],
    }


def _paddle_data(result: Any) -> dict[str, Any]:
    value = getattr(result, "json", result)
    value = value() if callable(value) else value
    if isinstance(value, str):
        value = json.loads(value)
    if isinstance(value, dict) and isinstance(value.get("res"), dict):
        value = value["res"]
    return value if isinstance(value, dict) else {}


def _paddle_box(value: Any) -> dict[str, float] | None:
    if hasattr(value, "tolist"):
        value = value.tolist()
    if not isinstance(value, list):
        return None
    if len(value) == 4 and all(isinstance(item, (int, float)) for item in value):
        left, top, right, bottom = value
        return {"left": float(left), "top": float(top), "right": float(right), "bottom": float(bottom)}
    points = [point.tolist() if hasattr(point, "tolist") else point for point in value]
    if points and all(isinstance(point, list) and len(point) >= 2 for point in points):
        xs, ys = [float(point[0]) for point in points], [float(point[1]) for point in points]
        return {"left": min(xs), "top": min(ys), "right": max(xs), "bottom": max(ys)}
    return None


def _make_paddle(engine: str, models_dir: Path) -> tuple[Any, dict[str, Any]]:
    versions = verify_runtime_versions()
    detection, recognition = PADDLE_MODELS[engine]
    from paddleocr import PaddleOCR

    instance = PaddleOCR(
        text_detection_model_name=detection,
        text_recognition_model_name=recognition,
        text_detection_model_dir=str(models_dir / f"{detection}_infer"),
        text_recognition_model_dir=str(models_dir / f"{recognition}_infer"),
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        device="cpu",
        enable_mkldnn=False,
    )
    return instance, {
        "paddleocr": versions["paddleocr"],
        "paddlepaddle": versions["paddlepaddle"],
        "paddlex": versions["paddlex"],
        "detection": detection,
        "recognition": recognition,
    }


def _run_paddle(instance: Any, path: Path) -> dict[str, Any]:
    started = time.perf_counter()
    texts: list[str] = []
    blocks: list[dict[str, Any]] = []
    for result in instance.predict(str(path)):
        data = _paddle_data(result)
        result_texts = list(data.get("rec_texts") or data.get("texts") or [])
        boxes = list(data.get("rec_boxes") or data.get("rec_polys") or data.get("dt_polys") or [])
        for index, value in enumerate(result_texts):
            text = str(value).strip()
            if not text:
                continue
            texts.append(text)
            blocks.append(
                {
                    "page_number": 1,
                    "text": text,
                    "box": _paddle_box(boxes[index]) if index < len(boxes) else None,
                }
            )
            if len(blocks) > 5000:
                raise ValueError("PaddleOCR block output exceeds the worker bound")
    text = "\n".join(texts)
    if len(text) > 100000:
        raise ValueError("PaddleOCR text exceeds the worker character bound")
    return {
        "text": text,
        "blocks": blocks,
        "runtime_ms": (time.perf_counter() - started) * 1000,
        "peak_memory_bytes": current_process_peak_memory(),
    }


def _case_record(case: dict[str, Any], observation: dict[str, Any]) -> dict[str, Any]:
    candidates = extract_title_candidates(observation["blocks"])
    candidate = candidates[0].text if candidates else ""
    recovery_safety = evaluate_title_safety(case["title"], candidates)
    downstream = evaluate_title_safety(case["metadata_title"], candidates)
    metrics = _edit_counts(_reference_text(case), observation["text"])
    return {
        "case_id": case["id"],
        "media": case["media"],
        "layout": case["layout"],
        "difficulty": case["difficulty"],
        "tags": case["tags"],
        "expected_agreement": case["expected_agreement"],
        "title_candidate": candidate,
        "title_exact": bool(candidate) and normalize_metric_title(candidate) == normalize_metric_title(case["title"]),
        "title_assistive": recovery_safety["outcome"] in {"AGREES", "REVIEW"},
        "downstream_outcome": downstream["outcome"],
        "downstream_reason": downstream["reason"],
        "downstream_score": downstream["score"],
        "runtime_ms": observation["runtime_ms"],
        "runtime_peak_memory_bytes": observation.get("peak_memory_bytes"),
        "block_count": len(observation["blocks"]),
        **metrics,
    }


def run_engine(
    engine: str,
    *,
    cases: list[dict[str, Any]],
    warmup_case: dict[str, Any],
    assets_dir: Path,
    rendered_dir: Path,
    models_dir: Path,
    raster_dpi: int,
    max_input_dimension: int,
    tesseract_psm: int,
    tesseract_executable: str | None,
    offline: bool,
) -> dict[str, Any]:
    if engine not in {"tesseract", *PADDLE_MODELS}:
        raise ValueError("unknown OCR engine")
    offline_result = enable_offline_guard() if offline else {"enabled": False, "self_test_passed": False}
    baseline_memory = current_process_peak_memory()
    cold_started = time.perf_counter()
    if engine == "tesseract":
        executable = _tesseract_executable(tesseract_executable)
        version = subprocess.run(
            [executable, "--version"],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=10,
            shell=False,
            check=True,
        ).stdout.splitlines()[0]
        if not version.startswith("tesseract v5.5.3"):
            raise ValueError(f"Tesseract version differs from the frozen baseline: {version}")
        runner: Callable[[Path], dict[str, Any]] = lambda path: _run_tesseract(path, executable, tesseract_psm)
        engine_versions = {"tesseract": version}
        footprint_paths = [Path(executable), Path(executable).parent / "tessdata" / "eng.traineddata"]
    else:
        instance, engine_versions = _make_paddle(engine, models_dir)
        runner = lambda path: _run_paddle(instance, path)
        detection, recognition = PADDLE_MODELS[engine]
        footprint_paths = [models_dir / f"{detection}_infer", models_dir / f"{recognition}_infer"]
    warmup_path = raster_path(warmup_case, assets_dir, rendered_dir, raster_dpi, max_input_dimension)
    warmup = runner(warmup_path)
    cold_start_ms = (time.perf_counter() - cold_started) * 1000

    records = []
    failures = []
    for case in cases:
        path = raster_path(case, assets_dir, rendered_dir, raster_dpi, max_input_dimension)
        try:
            observation = runner(path)
            records.append(_case_record(case, observation))
        except Exception as error:
            failures.append({"case_id": case["id"], "error_type": type(error).__name__, "message": str(error)[:300]})
    footprint = sum(path.stat().st_size if path.is_file() else directory_bytes(path) for path in footprint_paths)
    return {
        "schema_version": "pp1-ocr-engine-observation/v1",
        "engine": engine,
        "status": "executed" if not failures else "failed",
        "environment": {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "machine": platform.machine(),
            "processor": platform.processor(),
            "cpu_count": os.cpu_count(),
        },
        "versions": engine_versions,
        "configuration": {
            "device": "cpu",
            "raster_dpi": raster_dpi,
            "max_input_dimension": max_input_dimension,
            "tesseract_psm": tesseract_psm if engine == "tesseract" else None,
            "enable_mkldnn": False if engine in PADDLE_MODELS else None,
            "explicit_model_directories": engine in PADDLE_MODELS,
        },
        "offline": offline_result,
        "warmup_case_id": warmup_case["id"],
        "warmup_runtime_ms": warmup["runtime_ms"],
        "cold_start_ms": cold_start_ms,
        "memory_baseline_bytes": baseline_memory,
        "peak_working_set_bytes": max(
            [warmup.get("peak_memory_bytes") or 0]
            + [record.get("runtime_peak_memory_bytes") or 0 for record in records]
            + [current_process_peak_memory() or 0]
        ),
        "artifact_footprint_bytes": footprint,
        "case_count": len(cases),
        "failures": failures,
        "records": records,
    }
