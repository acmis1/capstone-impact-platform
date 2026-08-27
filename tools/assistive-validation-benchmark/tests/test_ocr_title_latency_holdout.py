from __future__ import annotations

import unittest

from assistive_validation_benchmark.ocr_title_latency.schema import load_json
from assistive_validation_benchmark.ocr_title_latency_holdout.corpus import build_holdout_corpus
from assistive_validation_benchmark.ocr_title_latency_holdout.one_shot import check_result
from assistive_validation_benchmark.ocr_title_latency_holdout.seal import (
    EVIDENCE_ROOT,
    STATE_PATH,
    check_seal,
    holdout_non_reuse,
    validate_holdout_corpus,
)


class OcrTitleLatencyHoldoutTests(unittest.TestCase):
    def test_corpus_is_balanced_deterministic_and_fresh(self) -> None:
        corpus = validate_holdout_corpus(build_holdout_corpus())
        scored = [case for case in corpus["ocr_cases"] if case["split"] == "holdout"]
        self.assertEqual(54, len(scored))
        self.assertEqual(21, sum(case["expected_consistency"] == "INCONSISTENT" for case in scored))
        self.assertTrue(holdout_non_reuse(corpus)["passed"])

    def test_seal_recomputes_without_running_ocr(self) -> None:
        seal = check_seal()
        self.assertEqual("SEALED_UNCONSUMED", seal["status"])
        self.assertEqual(54, seal["scored_case_count"])
        state = load_json(STATE_PATH)
        self.assertIn(state["status"], {"SEALED_UNCONSUMED", "CONSUMED_RECORDED"})
        self.assertIn(state["run_count"], {0, 1})

    def test_recorded_result_recomputes_when_present(self) -> None:
        if not EVIDENCE_ROOT.exists():
            self.skipTest("one-shot output is intentionally absent before the sealed run")
        report = check_result()
        self.assertIn(
            report["final_decision"],
            {"READY_FOR_TITLE_OCR_INTEGRATION", "OCR_TITLE_PROVIDER_DEFERRED", "HOLDOUT_INVALID_PROTOCOL_BUG"},
        )


if __name__ == "__main__":
    unittest.main()
