from __future__ import annotations

import copy
import unittest

from assistive_validation_benchmark.ocr_failure_analysis.ordering import column_order, geometry_order
from assistive_validation_benchmark.ocr_iteration3.candidate_b import _compact_parsing, pp_structure_assisted_order
from assistive_validation_benchmark.ocr_iteration3.corpus import build_calibration_corpus
from assistive_validation_benchmark.ocr_iteration3.holdout import build_holdout_corpus
from assistive_validation_benchmark.ocr_iteration3.reading_order import (
    adaptive_column_order,
    adaptive_column_order_with_trace,
)
from assistive_validation_benchmark.ocr_iteration3.title_selector import select_title_candidates
from assistive_validation_benchmark.ocr_iteration3.schema import validate_corpus


def block(text: str, left: float, top: float, right: float, bottom: float) -> dict[str, object]:
    return {"page_number": 1, "text": text, "box": {"left": left, "top": top, "right": right, "bottom": bottom}}


class Iteration3ReadingOrderTests(unittest.TestCase):
    def test_narrow_realistic_gutters_do_not_collapse_columns(self) -> None:
        blocks = [
            block("title", 300, 30, 1300, 140),
            block("left heading", 54, 335, 181, 352),
            block("middle heading", 565, 334, 645, 352),
            block("right heading", 1077, 334, 1166, 352),
            block("left line one", 55, 360, 510, 380),
            block("middle line one", 565, 359, 1024, 380),
            block("right line one", 1075, 360, 1454, 380),
            block("left line two", 55, 383, 486, 401),
            block("middle line two", 568, 384, 867, 400),
            block("right line two", 1078, 384, 1469, 400),
        ]
        self.assertEqual(geometry_order(blocks), column_order(blocks), "Iteration 2 must reproduce the observed fallback")
        order, trace = adaptive_column_order_with_trace(blocks)
        self.assertEqual([0, 1, 4, 7, 2, 5, 8, 3, 6, 9], order)
        self.assertEqual("adaptive_columns", trace["mode"])
        self.assertEqual(3, trace["column_count"])

    def test_two_columns_are_inferred_from_repeated_left_edges(self) -> None:
        blocks = [
            block("control left", 40, 20, 180, 40),
            block("control right", 1260, 20, 1500, 40),
            block("title", 300, 70, 1300, 150),
            block("left heading", 55, 300, 180, 322),
            block("right heading", 820, 300, 950, 322),
            block("left body", 55, 340, 770, 362),
            block("right body", 820, 340, 1540, 362),
        ]
        order, trace = adaptive_column_order_with_trace(blocks)
        self.assertEqual([0, 1, 2, 3, 5, 4, 6], order)
        self.assertEqual(2, trace["column_count"])

    def test_full_width_blocks_split_column_major_bands(self) -> None:
        blocks = [
            block("title", 300, 20, 1300, 100),
            block("left heading", 55, 200, 180, 222),
            block("right heading", 820, 200, 950, 222),
            block("left body", 55, 240, 770, 262),
            block("right body", 820, 240, 1540, 262),
            block("summary table", 55, 330, 1540, 356),
            block("left cell", 55, 380, 400, 402),
            block("right cell", 820, 380, 1180, 402),
            block("table caption", 55, 430, 1540, 452),
            block("left closing", 55, 500, 700, 522),
            block("right closing", 820, 500, 1500, 522),
        ]
        order, trace = adaptive_column_order_with_trace(blocks)
        self.assertEqual([0, 1, 3, 2, 4, 5, 6, 7, 8, 9, 10], order)
        self.assertEqual(2, trace["spanning_band_count"])

    def test_one_column_and_unsupported_geometry_fall_back_safely(self) -> None:
        one_column = [block("title", 100, 20, 700, 80), block("line one", 50, 150, 700, 170), block("line two", 50, 190, 700, 210)]
        order, trace = adaptive_column_order_with_trace(one_column)
        self.assertEqual(geometry_order(one_column), order)
        self.assertEqual("geometry_fallback", trace["mode"])

        missing = [{"page_number": 1, "text": "first", "box": None}, {"page_number": 1, "text": "second", "box": None}]
        order, trace = adaptive_column_order_with_trace(missing)
        self.assertEqual([0, 1], order)
        self.assertEqual("provider_fallback", trace["mode"])

    def test_unlocated_blocks_remain_at_the_end_and_every_order_is_a_permutation(self) -> None:
        blocks = [
            block("title", 300, 20, 1300, 100),
            block("left heading", 55, 200, 180, 222),
            block("right heading", 820, 200, 950, 222),
            block("left body", 55, 240, 770, 262),
            block("right body", 820, 240, 1540, 262),
            {"page_number": 1, "text": "unlocated", "box": None},
        ]
        order = adaptive_column_order(blocks)
        self.assertEqual(list(range(len(blocks))), sorted(order))
        self.assertEqual(5, order[-1])


class Iteration3TitleSelectorTests(unittest.TestCase):
    def test_multiline_title_group_outranks_its_tallest_individual_line(self) -> None:
        blocks = [
            block("PP1 SYNTHETIC BOARD", 50, 30, 250, 46),
            block("Community Hall", 575, 102, 1024, 172),
            block("Energy Baseline", 576, 168, 1023, 241),
            block("CONTEXT", 50, 302, 160, 328),
        ]
        candidates = select_title_candidates(blocks)
        self.assertEqual("Community Hall Energy Baseline", candidates[0].text)
        self.assertEqual((1, 2), candidates[0].block_indexes)


class Iteration3EvidenceContractTests(unittest.TestCase):
    def test_calibration_corpus_is_deterministic_and_fully_crossed(self) -> None:
        first = build_calibration_corpus()
        second = build_calibration_corpus()
        self.assertEqual(first, second)
        validate_corpus(first, expected_split="calibration", expected_count=18)
        scored = [case for case in first["ocr_cases"] if case["split"] == "calibration"]
        cells = {
            (media, layout): sum(case["media"] == media and case["layout"] == layout for case in scored)
            for media in ("png", "jpeg", "scanned_pdf")
            for layout in ("one_column", "two_column", "three_column")
        }
        self.assertEqual({2}, set(cells.values()))

    def test_candidate_b_region_order_preserves_every_ocr_block(self) -> None:
        blocks = [
            block("left", 50, 200, 300, 225),
            block("right", 850, 200, 1100, 225),
            {"page_number": 1, "text": "unlocated", "box": None},
        ]
        regions = [
            {"block_order": 1, "block_bbox": [800, 150, 1200, 300]},
            {"block_order": 2, "block_bbox": [0, 150, 400, 300]},
        ]
        ordered = pp_structure_assisted_order(blocks, regions)
        self.assertEqual(["right", "left", "unlocated"], [item["text"] for item in ordered])
        self.assertCountEqual(blocks, ordered)

    def test_candidate_b_rejects_parsing_output_above_the_worker_bound(self) -> None:
        item = {"block_label": "text", "block_content": "bounded", "block_bbox": [0, 0, 1, 1]}
        with self.assertRaisesRegex(ValueError, "block bound"):
            _compact_parsing([item] * 5001)

    def test_corpus_role_rejects_a_case_id_from_another_split(self) -> None:
        corpus = copy.deepcopy(build_calibration_corpus())
        corpus["ocr_cases"][1]["id"] = "ocr3-hold-001"
        with self.assertRaisesRegex(ValueError, "identity"):
            validate_corpus(corpus, expected_split="calibration", expected_count=18)

    def test_fresh_holdout_has_five_cases_in_every_media_layout_cell(self) -> None:
        corpus = build_holdout_corpus()
        validate_corpus(corpus, expected_split="holdout", expected_count=45)
        scored = [case for case in corpus["ocr_cases"] if case["split"] == "holdout"]
        cells = {
            (media, layout): sum(case["media"] == media and case["layout"] == layout for case in scored)
            for media in ("png", "jpeg", "scanned_pdf")
            for layout in ("one_column", "two_column", "three_column")
        }
        self.assertEqual({5}, set(cells.values()))
        self.assertEqual(45, len({case["title"] for case in scored}))
        self.assertTrue(any(not case["expected_agreement"] for case in scored))


if __name__ == "__main__":
    unittest.main()
