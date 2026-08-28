from __future__ import annotations

import inspect
import unittest

from assistive_validation_benchmark.ocr_title_fullpage_holdout_v2 import one_shot
from assistive_validation_benchmark.ocr_title_fullpage_holdout_v2.corpus import (
    HOLDOUT_SEED,
    build_holdout_corpus,
)
from assistive_validation_benchmark.ocr_title_fullpage_holdout_v2.seal import (
    holdout_non_reuse,
    validate_holdout_corpus,
)


class OcrTitleFullpageHoldoutV2Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.corpus = validate_holdout_corpus(build_holdout_corpus())

    def test_post_freeze_seed_and_composition_are_fixed(self) -> None:
        self.assertEqual(32, len(HOLDOUT_SEED))
        self.assertNotEqual("2026082783", HOLDOUT_SEED)
        scored = [case for case in self.corpus["ocr_cases"] if case["split"] == "holdout"]
        warmups = [case for case in self.corpus["ocr_cases"] if case["split"] == "warmup"]
        self.assertEqual(60, len(scored))
        self.assertEqual(1, len(warmups))
        self.assertGreaterEqual(
            sum(case["expected_consistency"] == "INCONSISTENT" for case in scored),
            20,
        )

    def test_media_layout_cells_are_balanced(self) -> None:
        scored = [case for case in self.corpus["ocr_cases"] if case["split"] == "holdout"]
        cells = {
            (media, layout): sum(case["media"] == media and case["layout"] == layout for case in scored)
            for media in ("png", "jpeg", "scanned_pdf")
            for layout in ("one_column", "two_column", "three_column")
        }
        self.assertLessEqual(max(cells.values()) - min(cells.values()), 1)

    def test_non_reuse_includes_history_calibration_and_exposed_fingerprints(self) -> None:
        evidence = holdout_non_reuse(self.corpus)
        self.assertTrue(evidence["passed"])
        self.assertEqual(0, evidence["prohibited_reuse_count"])
        self.assertEqual(12, evidence["historical_corpus_count"])
        self.assertEqual(64, evidence["exposed_invalid_holdout"]["fingerprint_case_count"])
        self.assertEqual(45, evidence["current_calibration"]["calibration_case_count"])
        self.assertEqual(0, evidence["current_calibration"]["prohibited_reuse_count"])

    def test_one_shot_claim_precedes_candidate_capture(self) -> None:
        source = inspect.getsource(one_shot.run_once)
        self.assertLess(source.index("_write_state(claimed)"), source.index("capture = capture_holdout("))
        self.assertIn('"run_count": 1', source)


if __name__ == "__main__":
    unittest.main()
