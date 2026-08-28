from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from PIL import Image

from ..engines import current_process_peak_memory
from ..ocr_failure_analysis.ordering import apply_order
from ..ocr_productionization.engine import _paddle_box, _paddle_data
from ..ocr_productionization.provision import verify_runtime_versions
from ..ocr_title_consistency.selector import evaluate_title_outcome, select_title_candidates
from .renderer import raster_path


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
        "enable_mkldnn": configuration["enable_mkldnn"],
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
            blocks.append({
                "page_number": 1,
                "text": text[:400],
                "box": _paddle_box(boxes[index]) if index < len(boxes) else None,
                "confidence": round(float(scores[index]), 6) if index < len(scores) else None,
            })
            texts.append(text)
            if len(blocks) > 5000:
                raise ValueError("PaddleOCR blocks exceed the frozen bound")
    if sum(len(value) for value in texts) > 100000:
        raise ValueError("PaddleOCR text exceeds the frozen bound")
    runtime_ms = (time.perf_counter() - started) * 1000
    stages = profiler.snapshot()
    stages["other_ocr_ms"] = round(max(0.0, runtime_ms - stages["detection_ms"] - stages["recognition_ms"]), 3)
    return {
        "text": "\n".join(texts),
        "blocks": blocks,
        "runtime_ms": runtime_ms,
        "stage_ms": stages,
        "peak_memory_bytes": current_process_peak_memory(),
    }


def fast_path_credible(
    candidates: list[Any],
    contract: dict[str, Any],
    *,
    blocks: list[dict[str, Any]] | None = None,
    crop_height: int | None = None,
) -> tuple[bool, str]:
    if not candidates:
        return False, "NO_CANDIDATE"
    if blocks is not None and crop_height is not None:
        boundary = crop_height - contract["crop_boundary_margin_pixels"]
        if any(
            str(block.get("text") or "").strip()
            and block.get("box") is not None
            and float(block["box"]["bottom"]) >= boundary
            for block in blocks
        ):
            return False, "OCR_TEXT_TOUCHES_CROP_BOUNDARY"
    first = candidates[0]
    words = first.text.split()
    if not contract["minimum_tokens"] <= len(words) <= contract["maximum_tokens"]:
        return False, "TOKEN_COUNT_OUT_OF_RANGE"
    if first.prominence < contract["minimum_candidate_prominence"]:
        return False, "INSUFFICIENT_PROMINENCE"
    if blocks is not None:
        ordered = apply_order(blocks, "geometry")
        confidences = [
            float(ordered[index]["confidence"])
            for index in first.block_indexes
            if index < len(ordered) and ordered[index].get("confidence") is not None
        ]
        if confidences and min(confidences) < contract["minimum_recognition_confidence"]:
            return False, "LOW_RECOGNITION_CONFIDENCE"
    letters = "".join(character for character in first.text if character.isalpha())
    if contract["reject_all_uppercase_candidate"] and letters and letters == letters.upper():
        return False, "ALL_UPPERCASE_ADMINISTRATIVE_CANDIDATE"
    indexes = set(first.block_indexes)
    for candidate in candidates[1:3]:
        independent = indexes.isdisjoint(candidate.block_indexes)
        candidate_letters = "".join(character for character in candidate.text if character.isalpha())
        if (
            independent
            and contract["reject_any_prominent_uppercase_candidate"]
            and candidate.prominence >= contract["minimum_candidate_prominence"]
            and candidate_letters
            and candidate_letters == candidate_letters.upper()
        ):
            return False, "PROMINENT_UPPERCASE_ADMINISTRATIVE_CANDIDATE"
        if independent and candidate.prominence >= first.prominence * contract["ambiguity_prominence_ratio"]:
            return False, "SIMILARLY_PROMINENT_INDEPENDENT_CANDIDATE"
    return True, "CREDIBLE_METADATA_BLIND_TITLE_REGION"


def restore_full_document_extent(
    blocks: list[dict[str, Any]], full_size: tuple[int, int]
) -> list[dict[str, Any]]:
    width, height = full_size
    return [
        *blocks,
        {
            "page_number": 1,
            "text": "",
            "box": {
                "left": 0.0,
                "top": float(max(0, height - 1)),
                "right": float(width),
                "bottom": float(height),
            },
            "geometry_role": "FULL_DOCUMENT_EXTENT_SENTINEL",
        },
    ]


def _crop_top(
    source: Path, target: Path, ratio: float
) -> tuple[tuple[int, int], tuple[int, int]]:
    target.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(source) as image:
        rgb = image.convert("RGB")
        height = max(1, round(rgb.height * ratio))
        crop = rgb.crop((0, 0, rgb.width, height))
        crop.save(target, format="PNG", optimize=False)
        size = crop.size
        full_size = rgb.size
        crop.close()
        rgb.close()
    return size, full_size


def run_case(
    instance: Any,
    profiler: PaddleStageProfiler,
    case: dict[str, Any],
    configuration: dict[str, Any],
    protocol: dict[str, Any],
    *,
    assets_dir: Path,
    rendered_dir: Path,
) -> dict[str, Any]:
    total_started = time.perf_counter()
    raster_started = time.perf_counter()
    full_path = raster_path(
        case,
        assets_dir,
        rendered_dir / "full",
        configuration["raster_dpi"],
        configuration["max_input_dimension"],
    )
    raster_ms = (time.perf_counter() - raster_started) * 1000
    fast_runtime_ms = 0.0
    fallback_runtime_ms = 0.0
    detection_ms = recognition_ms = other_ocr_ms = 0.0
    path_used = "FULL_PAGE"
    fallback_reason = None

    ratio = configuration.get("fast_region_ratio")
    if ratio is not None:
        crop_started = time.perf_counter()
        crop_path = rendered_dir / "fast" / f"{case['id']}.png"
        crop_size, full_size = _crop_top(full_path, crop_path, float(ratio))
        raster_ms += (time.perf_counter() - crop_started) * 1000
        fast = run_paddle(instance, profiler, crop_path)
        fast["blocks"] = restore_full_document_extent(fast["blocks"], full_size)
        fast_runtime_ms = fast["runtime_ms"]
        detection_ms += fast["stage_ms"]["detection_ms"]
        recognition_ms += fast["stage_ms"]["recognition_ms"]
        other_ocr_ms += fast["stage_ms"]["other_ocr_ms"]
        fast_candidates = select_title_candidates(fast["blocks"])
        accepted, reason = fast_path_credible(
            fast_candidates,
            protocol["fast_path_contract"],
            blocks=fast["blocks"],
            crop_height=crop_size[1],
        )
        if accepted:
            observation = fast
            path_used = "FAST_TITLE_REGION"
            fallback_reason = None
        else:
            fallback_reason = reason
            fallback = run_paddle(instance, profiler, full_path)
            fallback_runtime_ms = fallback["runtime_ms"]
            detection_ms += fallback["stage_ms"]["detection_ms"]
            recognition_ms += fallback["stage_ms"]["recognition_ms"]
            other_ocr_ms += fallback["stage_ms"]["other_ocr_ms"]
            observation = fallback
            path_used = "FULL_PAGE_FALLBACK"
    else:
        crop_size = None
        observation = run_paddle(instance, profiler, full_path)
        fallback_runtime_ms = observation["runtime_ms"]
        detection_ms = observation["stage_ms"]["detection_ms"]
        recognition_ms = observation["stage_ms"]["recognition_ms"]
        other_ocr_ms = observation["stage_ms"]["other_ocr_ms"]

    selection_started = time.perf_counter()
    candidates = select_title_candidates(observation["blocks"])
    selection_ms = (time.perf_counter() - selection_started) * 1000
    comparison_started = time.perf_counter()
    outcome = evaluate_title_outcome(case["metadata_title"], candidates)
    comparison_ms = (time.perf_counter() - comparison_started) * 1000
    total_ms = (time.perf_counter() - total_started) * 1000
    return {
        "case_id": case["id"],
        "runtime_ms": total_ms,
        "path_used": path_used,
        "fallback_reason": fallback_reason,
        "crop_size": list(crop_size) if crop_size else None,
        "selected_title": candidates[0].text if candidates else "",
        "outcome": outcome["outcome"],
        "reason": outcome["reason"],
        "lexical_score": outcome["score"],
        "blocks": observation["blocks"],
        "stage_ms": {
            "rasterization_ms": round(raster_ms, 3),
            "detection_ms": round(detection_ms, 3),
            "recognition_ms": round(recognition_ms, 3),
            "other_ocr_ms": round(other_ocr_ms, 3),
            "candidate_selection_ms": round(selection_ms, 3),
            "deterministic_comparison_ms": round(comparison_ms, 3),
            "fast_region_ocr_ms": round(fast_runtime_ms, 3),
            "fallback_ocr_ms": round(fallback_runtime_ms, 3),
        },
        "peak_memory_bytes": observation.get("peak_memory_bytes"),
    }
