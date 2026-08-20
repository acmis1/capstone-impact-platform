import unittest

from assistive_validation_benchmark.core import (
    character_error_rate,
    duplicate_metrics,
    levenshtein_distance,
    match_title,
    normalize_title,
    rank_duplicate_candidates,
    word_error_rate,
)


class MetricTests(unittest.TestCase):
    def test_levenshtein_and_empty_error_rates(self):
        self.assertEqual(levenshtein_distance("kitten", "sitting"), 3)
        self.assertEqual(character_error_rate("", ""), 0)
        self.assertEqual(character_error_rate("", "x"), 1)
        self.assertEqual(word_error_rate("one two", "one too"), 0.5)

    def test_ocr_normalization_does_not_hide_punctuation_or_case_errors(self):
        self.assertGreater(character_error_rate("Title: Safe", "title Safe"), 0)


class TitleTests(unittest.TestCase):
    def test_normalizes_spacing_case_and_punctuation(self):
        self.assertEqual(normalize_title("  LOW\u2010Cost\nBridge\u2014Inspection  "), "low cost bridge inspection")
        self.assertTrue(match_title("Low-Cost Bridge Inspection", "LOW Cost Bridge Inspection").matched)

    def test_equality_alias_and_subtitle_are_confident_matches(self):
        for result in (
            match_title("Low-Cost Bridge Inspection", "LOW Cost Bridge Inspection"),
            match_title("Building Information Model Review", "BIM Review", aliases=["BIM Review"]),
            match_title("Circular Materials Exchange", "Circular Materials Exchange: Local Prototype", allow_subtitle=True),
        ):
            self.assertEqual(result.decision, "match")
            self.assertTrue(result.matched)

    def test_critical_material_mismatch_is_not_a_match(self):
        result = match_title("AI-Enabled Flood Warning System", "AI-Enabled Fire Warning System")
        self.assertFalse(result.matched)
        self.assertEqual(result.decision, "mismatch")

    def test_glyph_confusion_is_a_review_decision_not_a_confident_match(self):
        result = match_title("Smart Grid Anomaly Analyzer", "Smart Grid Anomaiy Analyzer")
        self.assertTrue(result.matched)
        self.assertEqual(result.decision, "review")
        self.assertEqual(result.classification, "ocr_glyph_confusion")

    def test_narrow_glyph_rule_does_not_admit_material_single_token_substitutions(self):
        # Regression guard. An earlier revision also accepted any single differing token pair whose
        # SequenceMatcher ratio reached 0.80, which matched these materially different titles.
        for metadata, candidate in (
            ("Waste Stream Classification Table", "Water Stream Classification Table"),
            ("Urban Heat Island Explorer", "Urban Heat Inland Explorer"),
            ("Adaptive Water Quality Monitor", "Adaptive Water Quantity Monitor"),
            ("Bridge Inspection Drone Phase 1", "Bridge Inspection Drone Phase 2"),
        ):
            with self.subTest(candidate=candidate):
                self.assertFalse(match_title(metadata, candidate).matched)

    def test_ocr_positives_and_material_negatives_are_not_separable_by_score(self):
        # The measured Phase 0 finding: the weighted lexical score alone cannot decide these.
        positive = match_title("Solar Microgrid Health Monitor", "Solar Microgrid Heaith Monitor")
        negative = match_title("Urban Heat Island Explorer", "Urban Heat Inland Explorer")
        self.assertAlmostEqual(positive.score, negative.score, delta=0.02)
        self.assertTrue(positive.matched)
        self.assertFalse(negative.matched)


class DuplicateTests(unittest.TestCase):
    def _case(self):
        return {"id": "x", "split": "calibration", "query_title": "Local Sensor",
                "query_text": "Measures water temperature", "candidates": [
                    {"id": "topic", "title": "Water Dashboard", "text": "Shows river temperature",
                     "relevant": False, "relation": "same_topic"},
                    {"id": "exact", "title": "Local Sensor", "text": "Measures water temperature",
                     "relevant": True, "relation": "exact"},
                    {"id": "other", "title": "Robot", "text": "Moves boxes",
                     "relevant": False, "relation": "unrelated"},
                ]}

    def test_ranking_is_deterministic_and_exact_duplicate_wins(self):
        case = self._case()
        first = rank_duplicate_candidates(case)
        self.assertEqual(first, rank_duplicate_candidates(case))
        self.assertEqual(first[0]["id"], "exact")
        metrics = duplicate_metrics([case])
        self.assertEqual(metrics["exact_duplicate_detection"], 1)
        self.assertEqual(metrics["recall_at_1"], 1)

    def test_ranking_ignores_relevance_and_relation_labels(self):
        case = self._case()
        flipped = self._case()
        for candidate in flipped["candidates"]:
            candidate["relevant"] = not candidate["relevant"]
            candidate["relation"] = "inverted"
        original = [(item["id"], item["score"]) for item in rank_duplicate_candidates(case)]
        inverted = [(item["id"], item["score"]) for item in rank_duplicate_candidates(flipped)]
        self.assertEqual(original, inverted)

    def test_metrics_rank_against_shared_candidate_pool_and_report_splits(self):
        cases = [
            {"id": "first", "split": "calibration", "query_title": "Flood Sensor",
             "query_text": "Measures creek depth", "candidates": [
                 {"id": "first-exact", "title": "Flood Sensor", "text": "Measures creek depth",
                  "relevant": True, "relation": "exact"},
                 {"id": "first-other", "title": "Garden Robot", "text": "Moves seed trays",
                  "relevant": False, "relation": "unrelated"}]},
            {"id": "second", "split": "holdout", "query_title": "Heat Map",
             "query_text": "Maps urban temperature", "candidates": [
                 {"id": "second-exact", "title": "Heat Map", "text": "Maps urban temperature",
                  "relevant": True, "relation": "exact"},
                 {"id": "second-other", "title": "Transit Board", "text": "Shows bus arrivals",
                  "relevant": False, "relation": "unrelated"}]},
        ]

        metrics = duplicate_metrics(cases)

        self.assertEqual(metrics["candidate_pool_size"], 4)
        self.assertTrue(all(len(item["ranking"]) == 4 for item in metrics["rankings"]))
        first_ranking = metrics["rankings"][0]["ranking"]
        self.assertFalse(next(item for item in first_ranking if item["id"] == "second-exact")["relevant"])
        self.assertEqual(metrics["by_split"]["calibration"]["case_count"], 1)
        self.assertEqual(metrics["by_split"]["holdout"]["case_count"], 1)

    def test_threshold_is_selected_on_calibration_only(self):
        cases = [
            {"id": "cal", "split": "calibration", "query_title": "Alpha Sensor", "query_text": "Alpha text",
             "candidates": [{"id": "cal-exact", "title": "Alpha Sensor", "text": "Alpha text",
                             "relevant": True, "relation": "exact"}] * 1 + [
                            {"id": "cal-other", "title": "Zulu Robot", "text": "Zulu text",
                             "relevant": False, "relation": "unrelated"}]},
            {"id": "hold", "split": "holdout", "query_title": "Beta Sensor", "query_text": "Beta text",
             "candidates": [{"id": "hold-exact", "title": "Beta Sensor", "text": "Beta text",
                             "relevant": True, "relation": "exact"},
                            {"id": "hold-other", "title": "Yankee Robot", "text": "Yankee text",
                             "relevant": False, "relation": "unrelated"}]},
        ]
        metrics = duplicate_metrics(cases)
        swept = {entry["threshold"] for entry in metrics["threshold_sweep_calibration"]}
        self.assertIn(metrics["candidate_threshold"], swept)
        self.assertEqual({entry["case_count"] for entry in metrics["threshold_sweep_calibration"]}, {1})
        self.assertIn("threshold_at_sweep_boundary", metrics)


if __name__ == "__main__":
    unittest.main()
