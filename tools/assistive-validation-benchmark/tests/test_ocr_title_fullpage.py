from __future__ import annotations

import unittest

from assistive_validation_benchmark.ocr_title_consistency.selector import (
    select_title_candidates as baseline_select,
)
from assistive_validation_benchmark.ocr_title_fullpage.corpus import build_calibration_corpus
from assistive_validation_benchmark.ocr_title_fullpage.evidence import calibration_non_reuse
from assistive_validation_benchmark.ocr_title_fullpage.schema import (
    data_root,
    load_json,
    validate_corpus,
    validate_protocol,
)
from assistive_validation_benchmark.ocr_title_fullpage.selection import (
    architecture,
    complexity_rank,
    preferred_candidate,
)
from assistive_validation_benchmark.ocr_title_fullpage.selector import (
    case_style,
    evaluate_title_outcome,
    select_title_candidates,
    type_size,
    vertical_extent_ratio,
)


def _block(text: str, top: float, height: float, left: float = 200.0, right: float = 1000.0) -> dict:
    return {
        "page_number": 1,
        "text": text,
        "box": {"left": left, "top": top, "right": right, "bottom": top + height},
        "confidence": 0.99,
    }


def _page_body() -> list[dict]:
    """Body and footer lines so the fixture has a realistic full-page vertical extent."""
    return [
        {"page_number": 1, "text": "SCOPE", "box": {"left": 54, "top": 609, "right": 130, "bottom": 633}, "confidence": 0.99},
        {"page_number": 1, "text": "Full-page calibration body evidence line.", "box": {"left": 54, "top": 640, "right": 900, "bottom": 665}, "confidence": 0.99},
        {"page_number": 1, "text": "LOCAL CALIBRATION CARD PAGE 1", "box": {"left": 600, "top": 1046, "right": 1000, "bottom": 1063}, "confidence": 0.99},
    ]


def _candidate(candidate_id: str, *, threads: int, p50: float, p95: float, eligible: bool = True) -> dict:
    return {
        "candidate_id": candidate_id,
        "configuration": {
            "candidate_id": candidate_id,
            "page_scope": "FULL_PAGE",
            "fast_region_ratio": None,
            "enable_mkldnn": False,
            "enable_hpi": False,
            "cpu_threads": threads,
        },
        "architecture": "full_page_single_pass",
        "complexity_rank": 0,
        "effective_cpu_threads": threads,
        "worst_repeat_p50_ms": p50,
        "worst_repeat_p95_ms": p95,
        "selection_eligible": eligible,
    }


class OcrTitleFullpageProtocolTests(unittest.TestCase):
    def setUp(self) -> None:
        self.protocol = validate_protocol(load_json(data_root() / "protocol.json"))

    def test_corpus_is_balanced_crossed_and_historically_fresh(self) -> None:
        corpus = validate_corpus(build_calibration_corpus())
        scored = [case for case in corpus["ocr_cases"] if case["split"] == "calibration"]
        self.assertEqual(45, len(scored))
        self.assertGreaterEqual(sum(case["expected_consistency"] == "INCONSISTENT" for case in scored), 15)
        for family in {case["family"] for case in scored if case["family"] != "plain"}:
            members = [case for case in scored if case["family"] == family]
            if len(members) < 2:
                continue
            # A recurring family must never be confounded with one media or one column layout.
            self.assertEqual(len(members), len({case["media"] for case in members}), family)
            self.assertEqual(len(members), len({case["layout"] for case in members}), family)
        reuse = calibration_non_reuse(corpus)
        self.assertTrue(reuse["passed"])
        self.assertEqual(0, reuse["prohibited_reuse_count"])

    def test_tracked_corpus_matches_the_deterministic_source(self) -> None:
        tracked = validate_corpus(load_json(data_root() / "corpus" / "calibration.json"))
        self.assertEqual(build_calibration_corpus(), tracked)

    def test_protocol_forbids_a_cropped_fast_path_and_backend_acceleration(self) -> None:
        fixed = self.protocol["fixed_configuration"]
        self.assertEqual("FULL_PAGE", fixed["page_scope"])
        self.assertIsNone(fixed["fast_region_ratio"])
        self.assertFalse(fixed["enable_mkldnn"])
        self.assertFalse(fixed["enable_hpi"])
        self.assertEqual(["FULL_PAGE"], self.protocol["bounded_options"]["page_scopes"])


class CorrectedSelectionPolicyTests(unittest.TestCase):
    """The audit finding: eligibility must not require an 'optimization feature'."""

    def test_a_plain_full_page_candidate_is_the_lowest_complexity_rank(self) -> None:
        plain = {"page_scope": "FULL_PAGE", "fast_region_ratio": None, "enable_mkldnn": False, "enable_hpi": False}
        self.assertEqual("full_page_single_pass", architecture(plain))
        self.assertEqual(0, complexity_rank(plain))
        self.assertEqual(1, complexity_rank({**plain, "fast_region_ratio": 0.36}))
        self.assertEqual(3, complexity_rank({**plain, "enable_mkldnn": True}))
        self.assertEqual(4, complexity_rank({**plain, "enable_hpi": True}))

    def test_unpinned_thread_candidate_is_eligible_and_can_win(self) -> None:
        candidates = [
            _candidate("fullpage-cpu-default", threads=10, p50=5000.0, p95=6000.0),
            _candidate("fullpage-cpu-t8", threads=8, p50=5100.0, p95=6500.0),
        ]
        # A candidate with no explicit thread setting and no optimization feature must not be
        # excluded the way the superseded ocr_title_latency._selection_eligible() excluded it.
        self.assertEqual("fullpage-cpu-default", preferred_candidate(candidates)["candidate_id"])

    def test_preference_is_worst_repeat_p95_then_p50_then_threads(self) -> None:
        candidates = [
            _candidate("fullpage-cpu-t10", threads=10, p50=4900.0, p95=7000.0),
            _candidate("fullpage-cpu-t8", threads=8, p50=5300.0, p95=6400.0),
        ]
        self.assertEqual("fullpage-cpu-t8", preferred_candidate(candidates)["candidate_id"])

    def test_an_ineligible_candidate_is_never_preferred(self) -> None:
        candidates = [
            _candidate("fullpage-cpu-t4", threads=4, p50=1.0, p95=2.0, eligible=False),
            _candidate("fullpage-cpu-t8", threads=8, p50=5300.0, p95=6400.0),
        ]
        self.assertEqual("fullpage-cpu-t8", preferred_candidate(candidates)["candidate_id"])
        with self.assertRaises(ValueError):
            preferred_candidate([_candidate("only", threads=8, p50=1.0, p95=2.0, eligible=False)])


class TypographySelectorTests(unittest.TestCase):
    def test_extent_ratio_reflects_the_letters_a_line_can_paint(self) -> None:
        self.assertEqual(0.98, vertical_extent_ratio("Bracken Signal Box Timing"))
        self.assertEqual(0.75, vertical_extent_ratio("Sheet"))
        self.assertEqual(0.75, vertical_extent_ratio("COHORT CONTROL COPY"))
        self.assertEqual(0.55, vertical_extent_ratio("moss"))
        self.assertEqual("UPPER", case_style("COHORT CONTROL COPY"))
        self.assertEqual("MIXED", case_style("Rowan Silo Moisture Chronicle"))
        self.assertEqual("NEUTRAL", case_style("2026"))

    def test_a_short_final_title_line_joins_despite_a_shorter_ink_box(self) -> None:
        # Measured heights differ by ~30% purely because the first line carries descenders.
        blocks = [
            _block("PP1 FULL PAGE CARD 35", 35, 19, left=54, right=250),
            _block("Bracken Signal Box Timing", 171, 83),
            _block("Sheet", 244, 58, left=700, right=820),
            *_page_body(),
        ]
        self.assertEqual("Bracken Signal Box Timing", baseline_select(blocks)[0].text)
        self.assertEqual("Bracken Signal Box Timing Sheet", select_title_candidates(blocks)[0].text)
        self.assertGreater(type_size({"left": 0, "top": 0, "right": 1, "bottom": 83}, "Timing"), 0)

    def test_an_uppercase_control_stamp_never_joins_a_mixed_case_title(self) -> None:
        blocks = [
            _block("PP1 FULL PAGE CARD 23", 38, 15, left=54, right=250),
            _block("COHORT CONTROL COPY", 210, 46, left=560, right=1040),
            _block("Rowan Silo Moisture Chronicle", 262, 52, left=380, right=1220),
            *_page_body(),
        ]
        self.assertIn("COHORT CONTROL COPY", baseline_select(blocks)[0].text)
        self.assertEqual("Rowan Silo Moisture Chronicle", select_title_candidates(blocks)[0].text)

    def test_semantic_similarity_never_produces_an_automatic_agreement(self) -> None:
        blocks = [_block("Fire Warning System", 160, 52), *_page_body()]
        outcome = evaluate_title_outcome("Flood Warning System", select_title_candidates(blocks))
        self.assertNotEqual("AGREES", outcome["outcome"])
        self.assertEqual("MISMATCH", outcome["outcome"])

    def test_normalized_punctuation_and_case_still_agree(self) -> None:
        blocks = [_block("Pewter Annex Lighting Compass", 160, 52), *_page_body()]
        candidates = select_title_candidates(blocks)
        for metadata in ("Pewter Annex: Lighting Compass", "pewter annex lighting compass", "Pewter—Annex Lighting Compass"):
            self.assertEqual("AGREES", evaluate_title_outcome(metadata, candidates)["outcome"], metadata)

    def test_no_candidate_yields_a_non_blocking_review(self) -> None:
        self.assertEqual("REVIEW", evaluate_title_outcome("Any Title", [])["outcome"])


if __name__ == "__main__":
    unittest.main()
