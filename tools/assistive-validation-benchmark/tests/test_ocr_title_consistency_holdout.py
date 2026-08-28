from __future__ import annotations

import unittest

from assistive_validation_benchmark.ocr_title_consistency.evidence import non_reuse_evidence
from assistive_validation_benchmark.ocr_title_consistency.schema import (
    calibration_evidence_root,
    load_json,
    validate_corpus,
)
from assistive_validation_benchmark.ocr_title_consistency_holdout.corpus import build_holdout_corpus


class TitleConsistencyHoldoutTests(unittest.TestCase):
    def test_fresh_holdout_is_balanced_and_novel(self) -> None:
        corpus = validate_corpus(build_holdout_corpus(), expected_split="holdout", expected_count=45)
        cases = [case for case in corpus["ocr_cases"] if case["split"] == "holdout"]
        self.assertEqual(15, sum(case["expected_consistency"] == "INCONSISTENT" for case in cases))
        self.assertEqual(43, sum(case["expected_visible_title"] is not None for case in cases))
        self.assertEqual({"png", "jpeg", "scanned_pdf"}, {case["media"] for case in cases})
        self.assertEqual({"one_column", "two_column", "three_column"}, {case["layout"] for case in cases})
        calibration = load_json(calibration_evidence_root() / "calibration-report.json")["non_reuse"]["records"]
        evidence = non_reuse_evidence(corpus, split="holdout", additional=calibration)
        self.assertTrue(evidence["passed"])
        self.assertEqual(30, evidence["additional_prior_case_count"])


if __name__ == "__main__":
    unittest.main()
