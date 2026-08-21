from __future__ import annotations

import ast
import re
from pathlib import Path
from typing import Any


def _enum_values(path: Path, class_name: str) -> list[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == class_name:
            values = []
            for child in node.body:
                if isinstance(child, ast.Assign) and len(child.targets) == 1 and isinstance(child.targets[0], ast.Name):
                    if isinstance(child.value, ast.Constant) and isinstance(child.value.value, str):
                        values.append(child.value.value)
            return values
    raise ValueError(f"production enum {class_name} was not found")


def check_production_boundary(repository_root: Path) -> dict[str, Any]:
    worker_root = repository_root / "apps" / "assistive-worker" / "src" / "capstone_assistive_worker"
    providers = _enum_values(worker_root / "task_contract.py", "OcrProviderSelection")
    if providers != ["NONE", "TESSERACT"]:
        raise ValueError(f"production OCR task providers changed: {providers}")
    coordinator = (
        repository_root / "apps" / "admin-cms" / "src" / "assistive-validation" / "services" / "assistiveCoordinator.ts"
    ).read_text(encoding="utf-8")
    selections = re.findall(r"ocrProvider:\s*'([A-Z]+)'", coordinator)
    if selections != ["NONE"]:
        raise ValueError(f"coordinator OCR selection changed: {selections}")
    process_contract = (
        repository_root / "apps" / "admin-cms" / "src" / "assistive-validation" / "services" / "pythonWorkerProcess.ts"
    ).read_text(encoding="utf-8")
    if "ocrProvider?: 'NONE' | 'TESSERACT';" not in process_contract:
        raise ValueError("Node worker OCR provider contract changed")
    production_python = list(worker_root.rglob("*.py"))
    forbidden = []
    for path in production_python:
        text = path.read_text(encoding="utf-8").lower()
        if "import paddleocr" in text or "from paddleocr" in text:
            forbidden.append(path.relative_to(repository_root).as_posix())
    if forbidden:
        raise ValueError(f"PaddleOCR import entered production worker packages: {forbidden}")
    migrations = sorted((repository_root / "infra" / "supabase" / "migrations").glob("*.sql"))
    if len(migrations) != 33:
        raise ValueError(f"migration count changed: {len(migrations)}")
    return {
        "production_ocr_task_providers": providers,
        "coordinator_ocr_selection": selections[0],
        "production_paddle_imports": 0,
        "migration_count": len(migrations),
        "production_provider_integration": False,
        "production_default_changed": False,
        "migration_34": False,
        "supabase_schema_changed": False,
    }
