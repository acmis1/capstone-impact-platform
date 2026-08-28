from __future__ import annotations

from pathlib import Path
from typing import Any

from ..ocr_iteration3.renderer import draw_poster, raster_path, reference_text
from ..ocr_iteration3.renderer import generate_assets as _generate_iteration3_assets
from .schema import canonical_json_bytes


RENDERER_ID = "pillow-noto-synthetic-poster/v4-reuse-iteration3-engine"


def generate_assets(corpus: dict[str, Any], output_dir: Path) -> dict[str, Any]:
    result = _generate_iteration3_assets(corpus, output_dir)
    result["schema_version"] = "pp1-ocr-iteration4-generation/v1"
    result["renderer_id"] = RENDERER_ID
    (output_dir / "generation.json").write_bytes(canonical_json_bytes(result))
    return result


__all__ = ["RENDERER_ID", "draw_poster", "generate_assets", "raster_path", "reference_text"]
