import tempfile
import unittest
from pathlib import Path

from assistive_validation_benchmark.engines import _loopback_languagetool_url, tesseract_ocr
from assistive_validation_benchmark.report import render_markdown


class EngineBoundaryTests(unittest.TestCase):
    def test_languagetool_refuses_non_loopback_url(self):
        with self.assertRaises(ValueError):
            _loopback_languagetool_url("https://api.languagetool.org")

    def test_missing_tesseract_is_reported_without_crashing(self):
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / "empty.png"
            image.write_bytes(b"not an image")
            result = tesseract_ocr(image, executable="definitely-not-a-real-tesseract-command")
        self.assertIn(result["status"], {"unavailable", "failed"})


class ReportTests(unittest.TestCase):
    def test_report_generation_marks_missing_results_truthfully(self):
        report = {
            "started_at": "2026-01-01T00:00:00+00:00", "completed_at": "2026-01-01T00:00:01+00:00",
            "environment": {"benchmark_commit_sha": "abc", "benchmark_seed": 1, "corpus_version": "v1", "os": "test",
                            "architecture": "x64", "cpu": "cpu", "logical_cpu_count": 1, "total_ram_bytes": 1,
                            "python_version": "3.11", "node_version": None},
            "corpus": {"total_cases": 40, "document_cases": 26, "grammar_cases": 8, "duplicate_cases": 6},
            "results": {},
            "decisions": {"tesseract": {"classification": "INSUFFICIENT_EVIDENCE", "reason": "not run"}},
        }
        markdown = render_markdown(report)
        self.assertIn("INSUFFICIENT_EVIDENCE", markdown)
        self.assertIn("All content is deterministic and synthetic", markdown)


if __name__ == "__main__":
    unittest.main()
