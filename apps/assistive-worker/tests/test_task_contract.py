from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from capstone_assistive_worker.task_contract import WorkerTask
from tests.fixture_support import generate_fixtures


TASK_ID = "11111111-1111-4111-8111-111111111111"


def valid_task(**overrides):
    task = {
        "schema_version": "assistive-worker-task/v1",
        "task_id": TASK_ID,
        "relative_path": "document.pdf",
        "document_type": "PDF",
        "ocr_provider": "NONE",
        "raster_dpi": None,
    }
    task.update(overrides)
    return task


class TaskContractTests(unittest.TestCase):
    def test_valid_task_is_accepted(self) -> None:
        self.assertEqual(str(WorkerTask.from_dict(valid_task()).task_id), TASK_ID)

    def test_unknown_field_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            WorkerTask.from_dict(valid_task(extra=True))

    def test_unknown_version_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            WorkerTask.from_dict(valid_task(schema_version="assistive-worker-task/v2"))

    def test_traversal_and_unlisted_paths_are_rejected(self) -> None:
        for relative_path in ("../document.pdf", "nested/document.pdf", "other.pdf", "C:/document.pdf"):
            with self.subTest(relative_path=relative_path), self.assertRaises(ValueError):
                WorkerTask.from_dict(valid_task(relative_path=relative_path))

    def test_document_type_must_match_fixed_filename(self) -> None:
        with self.assertRaises(ValueError):
            WorkerTask.from_dict(valid_task(document_type="PNG"))

    def test_ocr_is_explicit_and_dpi_is_bounded(self) -> None:
        with self.assertRaises(ValueError):
            WorkerTask.from_dict(valid_task(raster_dpi=150))
        with self.assertRaises(ValueError):
            WorkerTask.from_dict(valid_task(ocr_provider="TESSERACT", raster_dpi=201))
        accepted = WorkerTask.from_dict(valid_task(ocr_provider="TESSERACT", raster_dpi=150))
        self.assertEqual(accepted.raster_dpi, 150)


class TaskCliTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.generated, cls.fixtures, _ = generate_fixtures()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.generated.cleanup()

    def run_task(self, task: dict, fixture_name: str) -> tuple[subprocess.CompletedProcess[str], dict]:
        with tempfile.TemporaryDirectory(prefix="capstone-task-test-") as root:
            destination = Path(root) / task.get("relative_path", "document.pdf")
            if destination.parent == Path(root):
                destination.write_bytes((self.fixtures / fixture_name).read_bytes())
            env = copy.copy(os.environ)
            env["SUPABASE_SERVICE_ROLE_KEY"] = "must-not-be-printed"
            env["SUPABASE_SECRET_KEY"] = "must-not-be-printed-either"
            result = subprocess.run(
                [sys.executable, "-m", "capstone_assistive_worker.task_cli", "--staging-root", root],
                input=json.dumps(task),
                text=True,
                capture_output=True,
                timeout=20,
                check=False,
                env=env,
            )
        self.assertNotIn("must-not-be-printed", result.stdout + result.stderr)
        self.assertEqual(len(result.stdout.splitlines()), 1)
        return result, json.loads(result.stdout)

    def test_success_is_one_strict_json_result(self) -> None:
        result, output = self.run_task(valid_task(), "born-digital-one-page.pdf")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(output["schema_version"], "assistive-worker-task-result/v1")
        self.assertEqual(output["task_id"], TASK_ID)
        self.assertEqual(output["extraction"]["status"], "COMPLETED")
        self.assertIsNone(output["error"])
        self.assertEqual(result.stderr, "")

    def test_ocr_required_is_a_valid_extraction_result(self) -> None:
        task = valid_task(relative_path="document.png", document_type="PNG")
        result, output = self.run_task(task, "valid.png")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(output["extraction"]["status"], "OCR_REQUIRED")
        self.assertEqual(output["extraction"]["ocr_state"], "REQUIRED_NOT_RUN")

    def test_extraction_failure_stays_inside_the_extraction_contract(self) -> None:
        result, output = self.run_task(valid_task(), "corrupt.pdf")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(output["extraction"]["status"], "FAILED")
        self.assertEqual(output["extraction"]["error"]["code"], "CORRUPT_PDF")

    def test_rejected_task_returns_only_a_bounded_contract_error(self) -> None:
        result, output = self.run_task(valid_task(extra="rejected"), "born-digital-one-page.pdf")
        self.assertEqual(result.returncode, 2)
        self.assertIsNone(output["task_id"])
        self.assertIsNone(output["extraction"])
        self.assertEqual(output["error"]["code"], "TASK_CONTRACT_REJECTED")

    def test_health_contract_is_bounded(self) -> None:
        result = subprocess.run(
            [sys.executable, "-m", "capstone_assistive_worker.task_cli", "--health"],
            text=True,
            capture_output=True,
            timeout=10,
            check=False,
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(
            json.loads(result.stdout),
            {"schema_version": "assistive-worker-health/v1", "status": "OK"},
        )
        self.assertEqual(result.stderr, "")


if __name__ == "__main__":
    unittest.main()
