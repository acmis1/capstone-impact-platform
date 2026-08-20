from __future__ import annotations

import importlib.util
import tempfile
from pathlib import Path


def generate_fixtures() -> tuple[tempfile.TemporaryDirectory[str], Path, dict]:
    script = Path(__file__).parent / "fixtures" / "generate.py"
    spec = importlib.util.spec_from_file_location("phase1_fixture_generator", script)
    if spec is None or spec.loader is None:
        raise RuntimeError("fixture generator could not be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    temporary = tempfile.TemporaryDirectory(prefix="capstone-phase1-fixtures-")
    output = Path(temporary.name)
    manifest = module.generate(output)
    return temporary, output, manifest
