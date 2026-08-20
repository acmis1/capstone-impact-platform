import unittest

from assistive_validation_benchmark.runner import (
    _candidate_title,
    _candidate_title_blind,
    _score_findings,
    _score_separation,
    _summarize_ocr_engine,
    evaluate_title,
)


class CandidateTitleTests(unittest.TestCase):
    def test_blind_candidate_takes_the_first_non_empty_line(self):
        self.assertEqual(_candidate_title_blind("\n\n  Poster Title \nbody text"), "Poster Title")
        self.assertEqual(_candidate_title_blind("   \n\n"), "")

    def test_guided_candidate_can_join_wrapped_title_lines(self):
        text = "Autonomous Greenhouse\nController\nA body sentence."
        self.assertEqual(_candidate_title(text, "Autonomous Greenhouse Controller"),
                         "Autonomous Greenhouse Controller")


class TitleTrackTests(unittest.TestCase):
    def _cases(self):
        return [
            {"id": "a", "split": "calibration", "metadata_title": "Alpha Sensor", "poster_title": "Alpha Sensor",
             "expected_title_match": True, "title_variant": "exact"},
            {"id": "b", "split": "calibration", "metadata_title": "Alpha Sensor", "poster_title": "Bravo Sensor",
             "expected_title_match": False, "title_variant": "material_single_token"},
            {"id": "c", "split": "holdout", "metadata_title": "Charlie Sensor", "poster_title": "Charlie Sensor",
             "expected_title_match": True, "title_variant": "exact"},
        ]

    def test_extracted_track_uses_supplied_candidates_not_manifest_labels(self):
        cases = self._cases()
        result = evaluate_title(cases, {"engine:blind": {"a": "Completely Different", "c": "Charlie Sensor"}})
        track = result["extracted_candidate_tracks"]["engine:blind"]
        self.assertEqual(track["case_count"], 2)
        record = next(item for item in track["records"] if item["case_id"] == "a")
        self.assertEqual(record["candidate_title"], "Completely Different")
        self.assertFalse(record["assistive_match"])
        # The manifest-label track still sees the declared poster title, so the two must differ.
        self.assertTrue(next(item for item in result["records"] if item["case_id"] == "a")["assistive_match"])

    def test_degenerate_calibration_is_reported_rather_than_hidden(self):
        cases = [case for case in self._cases() if case["title_variant"] == "exact"]
        result = evaluate_title(cases)
        self.assertTrue(result["calibration_is_degenerate"])
        self.assertIn("tie-break", result["calibration_degeneracy_note"])


class ScoreSeparationTests(unittest.TestCase):
    def test_overlapping_ranges_are_flagged(self):
        records = [
            {"classification": "mismatch", "expected_match": True, "score": 0.77},
            {"classification": "mismatch", "expected_match": True, "score": 0.83},
            {"classification": "mismatch", "expected_match": False, "score": 0.82},
            {"classification": "exact_normalized", "expected_match": True, "score": 1.0},
        ]
        separation = _score_separation(records)
        self.assertTrue(separation["ranges_overlap"])
        self.assertEqual(separation["positive_case_count"], 2)
        self.assertEqual(separation["negative_case_count"], 1)
        self.assertAlmostEqual(separation["closest_confusable_gap"], 0.01, places=6)

    def test_separated_ranges_are_not_flagged_as_overlapping(self):
        records = [
            {"classification": "mismatch", "expected_match": True, "score": 0.90},
            {"classification": "mismatch", "expected_match": False, "score": 0.40},
        ]
        self.assertFalse(_score_separation(records)["ranges_overlap"])


class GrammarScoringTests(unittest.TestCase):
    def test_clean_case_findings_are_counted_as_false_positives_per_split(self):
        cases = [
            {"id": "clean", "split": "calibration", "text": "The FPGA runs the FFT pipeline.",
             "expected_issues": [], "tags": ["clean"]},
            {"id": "faulty", "split": "holdout", "text": "The results is displayed.",
             "expected_issues": [{"text": "is", "type": "grammar"}], "tags": ["grammar"]},
        ]
        findings = [[{"start": 4, "end": 8}], [{"start": 12, "end": 14}]]
        scored = _score_findings(cases, findings)
        self.assertEqual(scored["false_positives"], 1)
        self.assertEqual(scored["true_findings"], 1)
        self.assertEqual(scored["clean_case_false_positives"], 1)
        self.assertEqual(scored["by_split"]["calibration"]["false_positives"], 1)
        self.assertEqual(scored["by_split"]["holdout"]["true_findings"], 1)


class OcrSummaryTests(unittest.TestCase):
    def _record(self, case_id, runtime, scored, cold=False):
        return {"case_id": case_id, "quality": "high", "layout": "single_column", "tags": [], "scored": scored,
                "title_candidate": "", "title_candidate_blind": "", "title_recovered_exact": True,
                "title_recovered_exact_blind": True, "title_assistive_match": True,
                "title_assistive_decision": "match", "cer": 0.0, "wer": 0.0,
                "observation": {"status": "ok", "runtime_ms": runtime, "cold_start_included": cold}}

    def test_unscored_control_is_excluded_from_scored_latency(self):
        records = [self._record("cold", 9000, True, cold=True),
                   self._record("normal", 100, True),
                   self._record("oversized", 50000, False)]
        summary = _summarize_ocr_engine("paddle-small", records, memory_baseline=None)
        self.assertEqual(summary["cold_start_ms"], 9000)
        self.assertEqual(summary["scored_warm_runtime"]["count"], 1)
        self.assertEqual(summary["scored_warm_runtime"]["p95_ms"], 100)
        self.assertEqual(summary["warm_runtime"]["p95_ms"], 50000)
        self.assertEqual(summary["memory_attribution"], "process_cumulative")

    def test_child_process_engines_are_labelled_as_such(self):
        summary = _summarize_ocr_engine("tesseract", [self._record("a", 100, True)], memory_baseline=None)
        self.assertEqual(summary["memory_attribution"], "child_process_peak")


if __name__ == "__main__":
    unittest.main()
