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
        self.assertEqual(normalize_title("  LOW‑Cost\nBridge—Inspection  "), "low cost bridge inspection")
        self.assertTrue(match_title("Low-Cost Bridge Inspection", "LOW Cost Bridge Inspection").matched)

    def test_accepts_explicit_alias_and_subtitle_policy(self):
        self.assertTrue(match_title("Building Information Model Review", "BIM Review", aliases=["BIM Review"]).matched)
        self.assertTrue(match_title("Circular Materials Exchange", "Circular Materials Exchange: Local Prototype", allow_subtitle=True).matched)

    def test_critical_material_mismatch_is_not_a_match(self):
        result = match_title("AI-Enabled Flood Warning System", "AI-Enabled Fire Warning System")
        self.assertFalse(result.matched)

    def test_single_ocr_like_typo_can_match(self):
        result = match_title("Smart Grid Anomaly Analyzer", "Smart Grid Anomaiy Analyzer")
        self.assertTrue(result.matched)

    def test_narrow_glyph_confusion_can_match_without_weakening_material_negative(self):
        self.assertTrue(match_title("AI-Enabled Fire Warning System", "Al-Enabled Fire Warning System").matched)
        self.assertFalse(match_title("AI-Enabled Flood Warning System", "AI-Enabled Fire Warning System").matched)


class DuplicateTests(unittest.TestCase):
    def test_ranking_is_deterministic_and_exact_duplicate_wins(self):
        case = {"id": "x", "query_title": "Local Sensor", "query_text": "Measures water temperature", "candidates": [
            {"id": "topic", "title": "Water Dashboard", "text": "Shows river temperature", "relevant": False, "relation": "same_topic"},
            {"id": "exact", "title": "Local Sensor", "text": "Measures water temperature", "relevant": True, "relation": "exact"},
            {"id": "other", "title": "Robot", "text": "Moves boxes", "relevant": False, "relation": "unrelated"},
        ]}
        first = rank_duplicate_candidates(case)
        self.assertEqual(first, rank_duplicate_candidates(case))
        self.assertEqual(first[0]["id"], "exact")
        metrics = duplicate_metrics([case])
        self.assertEqual(metrics["exact_duplicate_detection"], 1)
        self.assertEqual(metrics["recall_at_1"], 1)

    def test_metrics_rank_against_shared_candidate_pool(self):
        cases = [
            {
                "id": "first",
                "query_title": "Flood Sensor",
                "query_text": "Measures creek depth",
                "candidates": [
                    {"id": "first-exact", "title": "Flood Sensor", "text": "Measures creek depth", "relevant": True, "relation": "exact"},
                    {"id": "first-other", "title": "Garden Robot", "text": "Moves seed trays", "relevant": False, "relation": "unrelated"},
                ],
            },
            {
                "id": "second",
                "query_title": "Heat Map",
                "query_text": "Maps urban temperature",
                "candidates": [
                    {"id": "second-exact", "title": "Heat Map", "text": "Maps urban temperature", "relevant": True, "relation": "exact"},
                    {"id": "second-other", "title": "Transit Board", "text": "Shows bus arrivals", "relevant": False, "relation": "unrelated"},
                ],
            },
        ]

        metrics = duplicate_metrics(cases)

        self.assertEqual(metrics["candidate_pool_size"], 4)
        self.assertTrue(all(len(item["ranking"]) == 4 for item in metrics["rankings"]))
        first_ranking = metrics["rankings"][0]["ranking"]
        self.assertFalse(next(item for item in first_ranking if item["id"] == "second-exact")["relevant"])


if __name__ == "__main__":
    unittest.main()
