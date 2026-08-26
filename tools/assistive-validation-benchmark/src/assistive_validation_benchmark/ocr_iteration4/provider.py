from __future__ import annotations

import html
import importlib.metadata
import os
import re
import time
import unicodedata
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

from ..engines import current_process_peak_memory
from ..ocr_productionization.engine import _paddle_data
from ..ocr_productionization.title_safety import Candidate, normalize_metric_title
from .schema import canonical_tree, load_json, value_sha256


MODEL_REPOSITORY = "PaddlePaddle/PaddleOCR-VL-1.6"
MODEL_REVISION = "c5630abae1d940eafe0697512a0325494b02ab42"
LAYOUT_REPOSITORY = "PaddlePaddle/PP-DocLayoutV3"
LAYOUT_REVISION = "7b48a7566925fa464281f930c58eee04fe2c862a"
EXPECTED_RUNTIME = {"paddleocr": "3.7.0", "paddlepaddle": "3.3.1", "paddlex": "3.7.2"}
MAX_BLOCKS = 5_000
MAX_CHARACTERS = 100_000
MAX_BLOCK_CHARACTERS = 20_000
TITLE_LABELS = {"doc_title", "document_title", "title"}
FALLBACK_TITLE_LABELS = {"paragraph_title", "text"}
MARKDOWN_LINK = re.compile(r"!?\[([^\]]*)\]\([^)]*\)")
HTML_TAG = re.compile(r"</?[A-Za-z][^>]*>")
MARKDOWN_SEPARATOR = re.compile(r"^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$")


class _PlainTextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        self.parts.append(data)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        del attrs
        if tag in {"br", "p", "div", "li", "tr", "td", "th", "table", "h1", "h2", "h3", "h4", "h5", "h6"}:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"p", "div", "li", "tr", "td", "th", "table", "h1", "h2", "h3", "h4", "h5", "h6"}:
            self.parts.append("\n")


def sanitize_document_text(value: Any) -> str:
    """Convert untrusted model markup to bounded visible plain text without executing it."""

    text = unicodedata.normalize("NFKC", str(value or ""))
    text = "".join(character for character in text if character in "\n\t" or unicodedata.category(character) != "Cc")
    if HTML_TAG.search(text):
        parser = _PlainTextParser()
        parser.feed(text)
        parser.close()
        text = "".join(parser.parts)
    text = html.unescape(text)
    text = MARKDOWN_LINK.sub(lambda match: match.group(1), text)
    lines = []
    for raw_line in text.replace("\r", "\n").split("\n"):
        if MARKDOWN_SEPARATOR.fullmatch(raw_line):
            continue
        line = raw_line.replace("|", " ")
        line = re.sub(r"^\s{0,3}#{1,6}\s+", "", line)
        line = re.sub(r"^\s*[-*+]\s+", "", line)
        line = line.replace("**", "").replace("__", "").replace("`", "")
        line = " ".join(line.split())
        if line:
            lines.append(line)
    result = "\n".join(lines)
    if len(result) > MAX_BLOCK_CHARACTERS:
        raise ValueError("PaddleOCR-VL block content exceeds the frozen bound")
    return result


def runtime_versions() -> dict[str, str]:
    observed = {name: importlib.metadata.version(name) for name in EXPECTED_RUNTIME}
    if observed != EXPECTED_RUNTIME:
        raise ValueError(f"PaddleOCR-VL runtime differs from the frozen identity: {observed}")
    return observed


def build_model_manifest(model_dir: Path, layout_dir: Path) -> dict[str, Any]:
    model_tree, model_bytes, model_files = canonical_tree(model_dir)
    layout_tree, layout_bytes, layout_files = canonical_tree(layout_dir)
    return {
        "schema_version": "pp1-ocr-iteration4-model-manifest/v1",
        "license": "Apache-2.0",
        "artifacts": [
            {
                "id": "PaddleOCR-VL-1.6-0.9B",
                "repository": MODEL_REPOSITORY,
                "revision": MODEL_REVISION,
                "tree_sha256": model_tree,
                "bytes": model_bytes,
                "files": model_files,
            },
            {
                "id": "PP-DocLayoutV3",
                "repository": LAYOUT_REPOSITORY,
                "revision": LAYOUT_REVISION,
                "tree_sha256": layout_tree,
                "bytes": layout_bytes,
                "files": layout_files,
            },
        ],
        "artifact_footprint_bytes": model_bytes + layout_bytes,
        "cache_metadata_excluded": True,
        "official_sources": [
            "https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6",
            "https://huggingface.co/PaddlePaddle/PP-DocLayoutV3",
            "https://www.paddleocr.ai/latest/en/version3.x/pipeline_usage/PaddleOCR-VL.html",
            "https://github.com/PaddlePaddle/PaddleOCR/blob/main/paddleocr/_pipelines/paddleocr_vl.py",
            "https://github.com/PaddlePaddle/PaddleX/blob/release/3.7/paddlex/configs/pipelines/PaddleOCR-VL-1.6.yaml",
        ],
    }


def verify_model_manifest(manifest: dict[str, Any], model_dir: Path, layout_dir: Path) -> dict[str, Any]:
    observed = build_model_manifest(model_dir, layout_dir)
    if manifest != observed:
        raise ValueError("local PaddleOCR-VL artifacts differ from the frozen model manifest")
    if manifest["artifact_footprint_bytes"] > 3 * 1024**3:
        raise ValueError("PaddleOCR-VL artifact footprint exceeds the pre-frozen ceiling")
    return {
        "model_manifest_sha256": value_sha256(manifest),
        "artifact_footprint_bytes": manifest["artifact_footprint_bytes"],
        "artifacts": [
            {
                "id": item["id"],
                "repository": item["repository"],
                "revision": item["revision"],
                "tree_sha256": item["tree_sha256"],
                "bytes": item["bytes"],
            }
            for item in manifest["artifacts"]
        ],
        "downloaded_during_capture": False,
        "local_directories_explicit": True,
    }


def load_and_verify_model_manifest(manifest_path: Path, model_dir: Path, layout_dir: Path) -> dict[str, Any]:
    return verify_model_manifest(load_json(manifest_path), model_dir, layout_dir)


def make_pipeline(model_dir: Path, layout_dir: Path) -> Any:
    os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"
    os.environ["PADDLE_PDX_CPU_NUM_THREADS"] = "10"
    from paddleocr import PaddleOCRVL

    return PaddleOCRVL(
        pipeline_version="v1.6",
        layout_detection_model_name="PP-DocLayoutV3",
        layout_detection_model_dir=str(layout_dir),
        layout_threshold=0.3,
        vl_rec_model_name="PaddleOCR-VL-1.6-0.9B",
        vl_rec_model_dir=str(model_dir),
        vl_rec_backend="native",
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_layout_detection=True,
        use_chart_recognition=False,
        use_seal_recognition=False,
        use_ocr_for_image_block=False,
        format_block_content=False,
        merge_layout_blocks=True,
        use_queues=False,
        device="cpu",
        cpu_threads=10,
        enable_mkldnn=True,
    )


def _box(value: Any) -> dict[str, float] | None:
    if hasattr(value, "tolist"):
        value = value.tolist()
    if not isinstance(value, (list, tuple)) or len(value) < 4:
        return None
    try:
        left, top, right, bottom = (float(number) for number in value[:4])
    except (TypeError, ValueError):
        return None
    if right < left or bottom < top:
        return None
    return {"left": left, "top": top, "right": right, "bottom": bottom}


def compact_parsing_blocks(value: Any, *, page_number: int = 1) -> list[dict[str, Any]]:
    items = list(value or [])
    if len(items) > MAX_BLOCKS:
        raise ValueError("PaddleOCR-VL output exceeds the frozen block bound")
    blocks = []
    total_characters = 0
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            item = _paddle_data(item)
        text = sanitize_document_text(item.get("block_content"))
        if not text:
            continue
        total_characters += len(text)
        if total_characters > MAX_CHARACTERS:
            raise ValueError("PaddleOCR-VL output exceeds the frozen character bound")
        order = item.get("block_order")
        blocks.append(
            {
                "page_number": page_number,
                "label": str(item.get("block_label") or "")[:80].casefold(),
                "text": text,
                "box": _box(item.get("block_bbox")),
                "order": int(order) if isinstance(order, int) and not isinstance(order, bool) else index + 1,
            }
        )
    return sorted(blocks, key=lambda block: (block["page_number"], block["order"]))


def run_pipeline(instance: Any, path: Path) -> dict[str, Any]:
    started = time.perf_counter()
    blocks: list[dict[str, Any]] = []
    for result in instance.predict(str(path)):
        data = _paddle_data(result)
        page_index = data.get("page_index")
        page_number = int(page_index) + 1 if isinstance(page_index, int) else 1
        blocks.extend(compact_parsing_blocks(data.get("parsing_res_list"), page_number=page_number))
        if len(blocks) > MAX_BLOCKS or sum(len(block["text"]) for block in blocks) > MAX_CHARACTERS:
            raise ValueError("PaddleOCR-VL combined output exceeds the frozen bounds")
    if not blocks:
        raise ValueError("PaddleOCR-VL returned no visible text blocks")
    return {
        "runtime_ms": (time.perf_counter() - started) * 1000,
        "peak_memory_bytes": current_process_peak_memory(),
        "blocks": blocks,
        "text": "\n".join(block["text"] for block in blocks),
    }


def _candidate(block: dict[str, Any], rank: int) -> Candidate:
    box = block.get("box")
    height = float(box["bottom"] - box["top"]) if box else 0.0
    return Candidate(
        text=block["text"],
        page_number=int(block["page_number"]),
        box=box,
        block_indexes=(int(block["order"]),),
        prominence=round(height, 3),
        rank=rank,
    )


def select_title_candidates(blocks: list[dict[str, Any]]) -> list[Candidate]:
    labelled = [block for block in blocks if block["label"] in TITLE_LABELS]
    if not labelled:
        located = [block for block in blocks if block.get("box")]
        if located:
            page_bottom = max(float(block["box"]["bottom"]) for block in located)
            labelled = [
                block
                for block in located
                if block["label"] in FALLBACK_TITLE_LABELS and float(block["box"]["top"]) <= page_bottom * 0.30
            ]
    ranked = sorted(
        labelled,
        key=lambda block: (
            float(block["box"]["top"]) if block.get("box") else float("inf"),
            -(float(block["box"]["bottom"]) - float(block["box"]["top"])) if block.get("box") else 0.0,
            block["order"],
        ),
    )
    result = []
    seen: set[str] = set()
    for block in ranked:
        normalized = normalize_metric_title(block["text"])
        if normalized and normalized not in seen:
            seen.add(normalized)
            result.append(_candidate(block, len(result) + 1))
        if len(result) == 8:
            break
    return result
