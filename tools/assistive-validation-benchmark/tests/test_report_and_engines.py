import tempfile
import unittest
from pathlib import Path

from assistive_validation_benchmark.engines import _loopback_languagetool_url, tesseract_ocr
from assistive_validation_benchmark.report import export_review_evidence, render_markdown


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

    def test_unsupported_page_segmentation_mode_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / "empty.png"
            image.write_bytes(b"not an image")
            result = tesseract_ocr(image, psm="99")
        self.assertIn(result["status"], {"unavailable", "failed"})


class ReportTests(unittest.TestCase):
    def _report(self, results=None, decisions=None):
        return {
            "started_at": "2026-01-01T00:00:00+00:00", "completed_at": "2026-01-01T00:00:01+00:00",
            "command_context": {"tesseract_psm": "3"},
            "environment": {"benchmark_commit_sha": "abc", "benchmark_seed": 1, "corpus_version": "v2", "os": "test",
                            "architecture": "x64", "cpu": "cpu", "logical_cpu_count": 1, "total_ram_bytes": 1,
                            "python_version": "3.11", "node_version": None},
            "corpus": {"total_cases": 85, "document_cases": 39, "grammar_cases": 32, "duplicate_cases": 14,
                       "generation": {"resolved_fonts": {"sans:regular": "arial.ttf", "serif:regular": "times.ttf"}}},
            "results": results or {},
            "decisions": decisions or {"tesseract": {"classification": "INSUFFICIENT_EVIDENCE", "reason": "not run"}},
        }

    def test_report_generation_marks_missing_results_truthfully(self):
        markdown = render_markdown(self._report())
        self.assertIn("INSUFFICIENT_EVIDENCE", markdown)
        self.assertIn("All content is deterministic and synthetic", markdown)
        self.assertIn("arial.ttf", markdown)

    def test_ocr_cost_table_separates_cold_start_from_scored_latency(self):
        results = {"ocr": {"engines": {"paddle-small": {
            "execution_status": "executed", "title_recovery_rate": 1.0, "title_recovery_rate_blind": 0.9,
            "assistive_title_agreement_rate": 1.0, "mean_cer": 0.05, "mean_wer": 0.07,
            "clean_mean_wer": 0.01, "challenging_mean_wer": 0.1,
            "cold_start_ms": 9000.0, "warm_runtime": {"p50_ms": 100.0, "p95_ms": 50000.0},
            "scored_warm_runtime": {"p50_ms": 100.0, "p95_ms": 120.0},
            "peak_memory_bytes": 1024 ** 3, "memory_attribution": "process_cumulative",
            "memory_note": "cumulative", "slowest_cases": [
                {"case_id": "doc-018", "runtime_ms": 50000.0, "scored": False}],
        }}}}
        markdown = render_markdown(self._report(results))
        self.assertIn("Cold start", markdown)
        self.assertIn("Scored-case p95", markdown)
        self.assertIn("unscored control", markdown)
        self.assertIn("process_cumulative", markdown)

    def test_evidence_export_removes_local_paths_and_raw_transcripts(self):
        report = self._report(results={"ocr": {"engines": {"tesseract": {
            "engine": "tesseract", "execution_status": "executed", "title_recovery_rate": 0.85,
            "mean_wer": 0.16, "settings": {"executable": "C:\\Users\\Admin\\tesseract.exe"},
            "records": [{
                "case_id": "doc-001", "scored": True, "title_candidate": "Poster Title", "cer": 0.1, "wer": 0.2,
                "observation": {"status": "ok", "runtime_ms": 100, "text": "redundant raw OCR transcript"},
            }],
        }}}})
        report["command_context"]["output_dir"] = "C:\\Users\\Admin\\artifacts"
        evidence = export_review_evidence(report, decisions={"tesseract": {"classification": "DEFER", "role": "performance_leader"}})
        encoded = str(evidence)
        self.assertNotIn("C:\\Users\\Admin", encoded)
        self.assertNotIn("redundant raw OCR transcript", encoded)
        record = evidence["results"]["ocr"]["engines"]["tesseract"]["records"][0]
        self.assertEqual(record["case_id"], "doc-001")
        self.assertEqual(record["title_candidate"], "Poster Title")
        self.assertEqual(record["observation"]["runtime_ms"], 100)
        self.assertEqual(evidence["decisions"]["tesseract"]["role"], "performance_leader")


if __name__ == "__main__":
    unittest.main()
