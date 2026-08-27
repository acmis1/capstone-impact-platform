"""Full-page-only PP-OCRv6 Small execution. There is no crop, fast region or second pass."""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from ..engines import current_process_peak_memory
from ..ocr_productionization.engine import _paddle_box, _paddle_data
from ..ocr_productionization.provision import verify_runtime_versions
from .renderer import raster_path


MAX_OCR_BLOCKS = 5000
MAX_OCR_TEXT_CHARACTERS = 100000


def make_paddle(models_dir: Path, configuration: dict[str, Any]) -> tuple[Any, dict[str, str], dict[str, Any]]:
    versions = verify_runtime_versions()
    from paddleocr import PaddleOCR

    kwargs: dict[str, Any] = {
        "text_detection_model_name": "PP-OCRv6_small_det",
        "text_recognition_model_name": "PP-OCRv6_small_rec",
        "text_detection_model_dir": str(models_dir / "PP-OCRv6_small_det_infer"),
        "text_recognition_model_dir": str(models_dir / "PP-OCRv6_small_rec_infer"),
        "use_doc_orientation_classify": False,
        "use_doc_unwarping": False,
        "use_textline_orientation": False,
        "device": "cpu",
        "enable_mkldnn": False,
        "mkldnn_cache_capacity": configuration["mkldnn_cache_capacity"],
        "enable_hpi": False,
    }
    if configuration.get("cpu_threads") is not None:
        kwargs["cpu_threads"] = configuration["cpu_threads"]
    instance = PaddleOCR(**kwargs)
    observed = {name: versions[name] for name in ("paddleocr", "paddlepaddle", "paddlex")}
    effective = dict(instance._common_args)  # noqa: SLF001 - captured compatibility evidence
    return instance, observed, effective


class PaddleStageProfiler:
    """Bounded detection/recognition timing hook used only to explain measured latency."""

    def __init__(self, instance: Any) -> None:
        pipeline = instance.paddlex_pipeline._pipeline  # noqa: SLF001 - bounded profiling hook
        self._durations = {"detection_ms": 0.0, "recognition_ms": 0.0}
        self._wrap(pipeline.text_det_model, "detection_ms")
        self._wrap(pipeline.text_rec_model, "recognition_ms")

    def _wrap(self, model: Any, key: str) -> None:
        original = model.apply

        def measured(*args: Any, **kwargs: Any):
            started = time.perf_counter()
            try:
                yield from original(*args, **kwargs)
            finally:
                self._durations[key] += (time.perf_counter() - started) * 1000

        model.apply = measured

    def reset(self) -> None:
        self._durations = {"detection_ms": 0.0, "recognition_ms": 0.0}

    def snapshot(self) -> dict[str, float]:
        return {key: round(value, 3) for key, value in self._durations.items()}


def run_paddle(instance: Any, profiler: PaddleStageProfiler, path: Path) -> dict[str, Any]:
    profiler.reset()
    started = time.perf_counter()
    texts: list[str] = []
    blocks: list[dict[str, Any]] = []
    for result in instance.predict(str(path)):
        data = _paddle_data(result)
        result_texts = list(data.get("rec_texts") or data.get("texts") or [])
        scores = list(data.get("rec_scores") or data.get("scores") or [])
        boxes = list(data.get("rec_boxes") or data.get("rec_polys") or data.get("dt_polys") or [])
        for index, value in enumerate(result_texts):
            text = str(value).strip()
            if not text:
                continue
            blocks.append(
                {
                    "page_number": 1,
                    "text": text[:400],
                    "box": _paddle_box(boxes[index]) if index < len(boxes) else None,
                    "confidence": round(float(scores[index]), 6) if index < len(scores) else None,
                }
            )
            texts.append(text)
            if len(blocks) > MAX_OCR_BLOCKS:
                raise ValueError("PaddleOCR blocks exceed the frozen bound")
    if sum(len(value) for value in texts) > MAX_OCR_TEXT_CHARACTERS:
        raise ValueError("PaddleOCR text exceeds the frozen bound")
    runtime_ms = (time.perf_counter() - started) * 1000
    stages = profiler.snapshot()
    stages["other_ocr_ms"] = round(max(0.0, runtime_ms - stages["detection_ms"] - stages["recognition_ms"]), 3)
    return {
        "blocks": blocks,
        "runtime_ms": runtime_ms,
        "stage_ms": stages,
        "peak_memory_bytes": current_process_peak_memory(),
    }


def run_case(
    instance: Any,
    profiler: PaddleStageProfiler,
    case: dict[str, Any],
    configuration: dict[str, Any],
    *,
    assets_dir: Path,
    rendered_dir: Path,
    selector_id: str,
) -> dict[str, Any]:
    """Rasterize, OCR the whole page once, then rank and compare. One OCR pass per case."""
    from .selectors import resolve

    select, evaluate = resolve(selector_id)
    total_started = time.perf_counter()
    raster_started = time.perf_counter()
    page_path = raster_path(
        case,
        assets_dir,
        rendered_dir,
        configuration["raster_dpi"],
        configuration["max_input_dimension"],
    )
    raster_ms = (time.perf_counter() - raster_started) * 1000
    observation = run_paddle(instance, profiler, page_path)
    selection_started = time.perf_counter()
    candidates = select(observation["blocks"])
    selection_ms = (time.perf_counter() - selection_started) * 1000
    comparison_started = time.perf_counter()
    outcome = evaluate(case["metadata_title"], candidates)
    comparison_ms = (time.perf_counter() - comparison_started) * 1000
    total_ms = (time.perf_counter() - total_started) * 1000
    return {
        "case_id": case["id"],
        "runtime_ms": total_ms,
        "page_scope": "FULL_PAGE",
        "selector_id": selector_id,
        "selected_title": candidates[0].text if candidates else "",
        "outcome": outcome["outcome"],
        "reason": outcome["reason"],
        "blocks": observation["blocks"],
        "stage_ms": {
            "rasterization_ms": round(raster_ms, 3),
            "detection_ms": observation["stage_ms"]["detection_ms"],
            "recognition_ms": observation["stage_ms"]["recognition_ms"],
            "other_ocr_ms": observation["stage_ms"]["other_ocr_ms"],
            "ocr_ms": round(observation["runtime_ms"], 3),
            "candidate_selection_ms": round(selection_ms, 3),
            "deterministic_comparison_ms": round(comparison_ms, 3),
        },
        "peak_memory_bytes": observation.get("peak_memory_bytes"),
    }
