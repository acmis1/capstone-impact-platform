from __future__ import annotations

import os
import platform
import time
from pathlib import Path
from typing import Any

from ..engines import current_process_peak_memory
from ..ocr_productionization.engine import _paddle_box, _paddle_data
from ..ocr_productionization.offline import enable_offline_guard
from ..ocr_productionization.provision import directory_bytes, tree_sha256
from .capture import _compact_blocks, verify_small_candidate
from .reading_order import apply_adaptive_order
from .renderer import generate_assets, raster_path


CAPTURE_SCHEMA = "pp1-ocr-iteration3-candidate-b-capture/v1"
LAYOUT_MODEL_NAME = "PP-DocLayout-S"
LAYOUT_THRESHOLD = 0.30
LAYOUT_ARCHIVE_SHA256 = "3f589aa473a5305a626705d94762fcb4ab3e43e6e48983c9b34b011a6c9d0394"
LAYOUT_TREE_SHA256 = "4d53cb80eecbabc3169e2bb4c32507420c6fadb7ced0d228f4faccfe72569162"
LAYOUT_ARTIFACT_BYTES = 5_146_359
LAYOUT_SOURCE = (
    "https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/"
    "paddle3.0.0/PP-DocLayout-S_infer.tar"
)


def _make_candidate_b(models_dir: Path, layout_model_dir: Path) -> Any:
    os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"
    from paddleocr import PPStructureV3

    return PPStructureV3(
        layout_detection_model_name=LAYOUT_MODEL_NAME,
        layout_detection_model_dir=str(layout_model_dir),
        text_detection_model_name="PP-OCRv6_small_det",
        text_detection_model_dir=str(models_dir / "PP-OCRv6_small_det_infer"),
        text_recognition_model_name="PP-OCRv6_small_rec",
        text_recognition_model_dir=str(models_dir / "PP-OCRv6_small_rec_infer"),
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        use_seal_recognition=False,
        use_table_recognition=False,
        use_formula_recognition=False,
        use_chart_recognition=False,
        use_region_detection=False,
        device="cpu",
        enable_mkldnn=False,
    )


def _ocr_blocks(value: Any) -> list[dict[str, Any]]:
    data = _paddle_data(value)
    texts = list(data.get("rec_texts") or data.get("texts") or [])
    boxes = list(data.get("rec_boxes") or data.get("rec_polys") or data.get("dt_polys") or [])
    blocks = []
    for index, value in enumerate(texts):
        text = str(value).strip()
        if text:
            blocks.append(
                {
                    "page_number": 1,
                    "text": text,
                    "box": _paddle_box(boxes[index]) if index < len(boxes) else None,
                }
            )
    if len(blocks) > 5000 or sum(len(block["text"]) for block in blocks) > 100000:
        raise ValueError("Candidate B OCR output exceeds the frozen worker bounds")
    return _compact_blocks(blocks)


def _compact_parsing(value: Any) -> list[dict[str, Any]]:
    items = list(value or [])
    if len(items) > 5000:
        raise ValueError("Candidate B parsing output exceeds the frozen block bound")
    result = []
    extracted_characters = 0
    for item in items:
        if not isinstance(item, dict):
            item = _paddle_data(item)
        bbox = list(item.get("block_bbox") or [])
        content = str(item.get("block_content") or "")
        extracted_characters += len(content)
        if extracted_characters > 100000:
            raise ValueError("Candidate B parsing output exceeds the frozen character bound")
        result.append(
            {
                "block_label": str(item.get("block_label") or "")[:80],
                "block_content": content,
                "block_bbox": [round(float(number), 1) for number in bbox[:4]],
                "block_order": int(item.get("block_order") or len(result) + 1),
            }
        )
    return result


def _run_candidate_b(instance: Any, path: Path) -> dict[str, Any]:
    started = time.perf_counter()
    blocks: list[dict[str, Any]] = []
    parsing: list[dict[str, Any]] = []
    for result in instance.predict(str(path), layout_threshold=LAYOUT_THRESHOLD):
        data = _paddle_data(result)
        blocks.extend(_ocr_blocks(data.get("overall_ocr_res")))
        parsing.extend(_compact_parsing(data.get("parsing_res_list")))
    return {
        "runtime_ms": (time.perf_counter() - started) * 1000,
        "peak_memory_bytes": current_process_peak_memory(),
        "blocks": blocks,
        "parsing_res_list": parsing,
    }


def _overlap_ratio(box: dict[str, Any], region: list[float]) -> float:
    left = max(float(box["left"]), region[0])
    top = max(float(box["top"]), region[1])
    right = min(float(box["right"]), region[2])
    bottom = min(float(box["bottom"]), region[3])
    intersection = max(0.0, right - left) * max(0.0, bottom - top)
    area = max(1.0, (float(box["right"]) - float(box["left"])) * (float(box["bottom"]) - float(box["top"])))
    return intersection / area


def pp_structure_assisted_order(
    blocks: list[dict[str, Any]], parsing_res_list: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Use PP-Structure region order while preserving every PP-OCRv6 block."""
    regions = sorted(parsing_res_list, key=lambda item: (item["block_order"], item["block_bbox"]))
    groups: dict[int, list[dict[str, Any]]] = {index: [] for index in range(len(regions))}
    unassigned = []
    for block in blocks:
        box = block.get("box")
        if not isinstance(box, dict):
            unassigned.append(block)
            continue
        scores = [
            _overlap_ratio(box, region["block_bbox"])
            if len(region["block_bbox"]) == 4
            else 0.0
            for region in regions
        ]
        best = max(range(len(scores)), key=scores.__getitem__) if scores else -1
        if best >= 0 and scores[best] >= 0.50:
            groups[best].append(block)
        else:
            unassigned.append(block)
    ordered = []
    for index in range(len(regions)):
        ordered.extend(apply_adaptive_order(groups[index]))
    ordered.extend(apply_adaptive_order(unassigned))
    if len(ordered) != len(blocks):
        raise ValueError("Candidate B ordering did not preserve every OCR block")
    return ordered


def capture_candidate_b(
    corpus: dict[str, Any],
    protocol: dict[str, Any],
    *,
    run_dir: Path,
    models_dir: Path,
    layout_model_dir: Path,
) -> dict[str, Any]:
    assets_dir = run_dir / "corpus"
    generation = generate_assets(corpus, assets_dir)
    small = verify_small_candidate(protocol, models_dir)
    layout_tree = tree_sha256(layout_model_dir)
    layout_bytes = directory_bytes(layout_model_dir)
    if layout_tree != LAYOUT_TREE_SHA256 or layout_bytes != LAYOUT_ARTIFACT_BYTES:
        raise ValueError("PP-DocLayout-S model tree differs from the frozen Candidate B identity")
    offline = enable_offline_guard()
    baseline_memory = current_process_peak_memory()
    started = time.perf_counter()
    instance = _make_candidate_b(models_dir, layout_model_dir)
    configuration = {
        **protocol["configuration"],
        "layout_model": LAYOUT_MODEL_NAME,
        "layout_threshold": LAYOUT_THRESHOLD,
        "optional_structure_modules": False,
    }
    rendered_dir = run_dir / "rendered"
    warmup = next(case for case in corpus["ocr_cases"] if case["split"] == "warmup")
    warmup_path = raster_path(
        warmup,
        assets_dir,
        rendered_dir,
        configuration["raster_dpi"],
        configuration["max_input_dimension"],
    )
    warmup_result = _run_candidate_b(instance, warmup_path)
    cold_start_ms = (time.perf_counter() - started) * 1000
    records = []
    failures = []
    cases = [case for case in corpus["ocr_cases"] if case["split"] == "calibration"]
    for case in cases:
        path = raster_path(
            case,
            assets_dir,
            rendered_dir,
            configuration["raster_dpi"],
            configuration["max_input_dimension"],
        )
        try:
            observation = _run_candidate_b(instance, path)
        except Exception as error:
            failures.append(
                {
                    "case_id": case["id"],
                    "error_type": type(error).__name__,
                    "message": str(error)[:300],
                }
            )
            continue
        records.append({"case_id": case["id"], **observation})
    provisioning = {
        "small_ocr": small,
        "layout_model": LAYOUT_MODEL_NAME,
        "layout_source": LAYOUT_SOURCE,
        "layout_archive_sha256": LAYOUT_ARCHIVE_SHA256,
        "layout_tree_sha256": layout_tree,
        "layout_artifact_bytes": layout_bytes,
        "artifact_footprint_bytes": small["artifact_footprint_bytes"] + layout_bytes,
        "downloaded_during_capture": False,
    }
    return {
        "schema_version": CAPTURE_SCHEMA,
        "candidate": "PP-OCRv6 Small + PP-StructureV3 PP-DocLayout-S",
        "configuration": configuration,
        "versions": small["runtime"],
        "offline": offline,
        "environment": {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "machine": platform.machine(),
            "processor": platform.processor(),
            "cpu_count": os.cpu_count(),
        },
        "generation": generation,
        "provisioning": provisioning,
        "cold_start_ms": cold_start_ms,
        "warmup_runtime_ms": warmup_result["runtime_ms"],
        "memory_baseline_bytes": baseline_memory,
        "peak_working_set_bytes": max(
            [warmup_result.get("peak_memory_bytes") or 0, current_process_peak_memory() or 0]
            + [record.get("peak_memory_bytes") or 0 for record in records]
        ),
        "artifact_footprint_bytes": provisioning["artifact_footprint_bytes"],
        "case_count": len(cases),
        "failures": failures,
        "records": records,
    }
