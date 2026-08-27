from __future__ import annotations

import unittest

from assistive_validation_benchmark.ocr_productionization.title_safety import Candidate
from assistive_validation_benchmark.ocr_title_latency.corpus import build_calibration_corpus
from assistive_validation_benchmark.ocr_title_latency.evidence import calibration_non_reuse
from assistive_validation_benchmark.ocr_title_consistency.selector import select_title_candidates
from assistive_validation_benchmark.ocr_title_latency.pipeline import fast_path_credible, restore_full_document_extent
from assistive_validation_benchmark.ocr_title_latency.schema import data_root, load_json, validate_corpus, validate_protocol


class OcrTitleLatencyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.protocol = validate_protocol(load_json(data_root() / "protocol.json"))

    def test_corpus_is_balanced_and_fresh(self) -> None:
        corpus = validate_corpus(build_calibration_corpus())
        self.assertEqual(36, len([case for case in corpus["ocr_cases"] if case["split"] == "calibration"]))
        self.assertTrue(calibration_non_reuse(corpus)["passed"])

    def test_fast_path_acceptance_is_metadata_blind_and_conservative(self) -> None:
        contract = self.protocol["fast_path_contract"]
        credible = Candidate("Alpine Library Climate Ledger", 1, {"left": 1, "top": 80, "right": 700, "bottom": 140}, (0,), 54.0, 1)
        self.assertEqual((True, "CREDIBLE_METADATA_BLIND_TITLE_REGION"), fast_path_credible([credible], contract))
        administrative = Candidate("PROGRAM DELIVERY CONTROL SHEET", 1, {"left": 1, "top": 80, "right": 700, "bottom": 130}, (0,), 42.0, 1)
        self.assertEqual("ALL_UPPERCASE_ADMINISTRATIVE_CANDIDATE", fast_path_credible([administrative], contract)[1])
        competing = Candidate("Project Outcome Review", 1, {"left": 1, "top": 150, "right": 700, "bottom": 200}, (1,), 48.0, 2)
        self.assertEqual("SIMILARLY_PROMINENT_INDEPENDENT_CANDIDATE", fast_path_credible([credible, competing], contract)[1])
        uppercase_secondary = Candidate("PROJECT IMPACT REVIEW", 1, {"left": 1, "top": 150, "right": 700, "bottom": 200}, (1,), 31.0, 2)
        self.assertEqual("PROMINENT_UPPERCASE_ADMINISTRATIVE_CANDIDATE", fast_path_credible([credible, uppercase_secondary], contract)[1])
        clipped = [{"text": credible.text, "box": {"left": 1, "top": 280, "right": 700, "bottom": 330}, "confidence": 0.99}]
        self.assertEqual(
            "OCR_TEXT_TOUCHES_CROP_BOUNDARY",
            fast_path_credible([credible], contract, blocks=clipped, crop_height=330)[1],
        )

    def test_crop_selection_preserves_full_document_coordinate_extent(self) -> None:
        blocks = [
            {"page_number": 1, "text": "LOCAL CONTROL", "box": {"left": 40, "top": 30, "right": 300, "bottom": 50}},
            {"page_number": 1, "text": "Alpine Library Climate Ledger", "box": {"left": 200, "top": 150, "right": 1000, "bottom": 208}},
        ]
        self.assertNotEqual("Alpine Library Climate Ledger", select_title_candidates(blocks)[0].text)
        restored = restore_full_document_extent(blocks, (1600, 1100))
        self.assertEqual("Alpine Library Climate Ledger", select_title_candidates(restored)[0].text)


if __name__ == "__main__":
    unittest.main()
