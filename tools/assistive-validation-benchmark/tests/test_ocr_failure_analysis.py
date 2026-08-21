from __future__ import annotations

import json
import unittest
from pathlib import Path

from assistive_validation_benchmark.ocr_failure_analysis.analysis import (
    DEVELOPMENT_GATE,
    OPERATIONAL_CEILINGS,
)
from assistive_validation_benchmark.ocr_failure_analysis.capture import exposed_development_cases
from assistive_validation_benchmark.ocr_failure_analysis.ordering import (
    apply_order,
    column_order,
    geometry_order,
)
from assistive_validation_benchmark.ocr_failure_analysis.report import (
    FINAL_EXACT_TITLE_GATE,
    decide,
    instrument_validity,
    validate_report,
)
from assistive_validation_benchmark.ocr_failure_analysis.selectors import (
    SELECTOR_VARIANTS,
    run_variant,
    title_oracle,
)
from assistive_validation_benchmark.ocr_failure_analysis.taxonomy import (
    CATEGORIES,
    classify,
    wer_decomposition,
)
from assistive_validation_benchmark.ocr_productionization.evidence import protocol_frozen_paths
from assistive_validation_benchmark.ocr_productionization.schema import repository_root, tool_root


DIAGNOSTIC_REPORT = (
    repository_root() / "docs" / "assistive-validation" / "evidence" / "ocr-productionization-diagnostic-report.json"
)


def block(text: str, left: float, top: float, right: float, bottom: float) -> dict[str, object]:
    return {"page_number": 1, "text": text, "box": {"left": left, "top": top, "right": right, "bottom": bottom}}


def two_column_page(title_lines: list[str], title_height: float = 90.0) -> list[dict[str, object]]:
    """A poster-shaped page: a centred title band above two genuinely separated columns.

    ``title_height`` is the lever that reproduces the merged selector defect. The production
    selector ranks by the *combined* box height of an adjacent group, so three consecutive
    short body lines can outrank a genuine single-line title whenever the title is not much
    taller than three stacked body lines.
    """
    blocks = []
    top = 40.0
    for line in title_lines:
        blocks.append(block(line, 300, top, 700, top + title_height))
        top += title_height + 5
    blocks.extend(
        [
            block("BACKGROUND", 50, 300, 200, 320),
            block("left column line one", 50, 330, 300, 345),
            block("left column line two", 50, 350, 300, 365),
            block("METHOD", 520, 300, 640, 320),
            block("right column line one", 520, 330, 780, 345),
            block("right column line two", 520, 350, 780, 365),
        ]
    )
    return blocks


def case(**overrides: object) -> dict[str, object]:
    base = {
        "id": "ocr-cal-001",
        "split": "calibration",
        "media": "png",
        "layout": "two_column",
        "difficulty": "clean",
        "tags": [],
        "title": "Rainwater Analytics",
        "body": "left column line one left column line two right column line one right column line two",
    }
    base.update(overrides)
    return base


class ReadingOrderTests(unittest.TestCase):
    def test_geometry_order_interleaves_columns_and_column_order_does_not(self) -> None:
        blocks = two_column_page(["Rainwater Analytics"])
        self.assertEqual([0, 1, 4, 2, 5, 3, 6], geometry_order(blocks))
        self.assertEqual([0, 1, 2, 3, 4, 5, 6], column_order(blocks))

    def test_every_ordering_is_a_permutation(self) -> None:
        blocks = two_column_page(["Rainwater Analytics", "for Regional Libraries"])
        for name in ("raw", "geometry", "column"):
            ordered = apply_order(blocks, name)
            self.assertEqual(len(blocks), len(ordered))
            self.assertCountEqual([item["text"] for item in blocks], [item["text"] for item in ordered])

    def test_column_order_falls_back_when_there_is_no_column_structure(self) -> None:
        blocks = [block("only line", 50, 40, 300, 60), block("second line", 50, 70, 300, 90)]
        self.assertEqual(geometry_order(blocks), column_order(blocks))

    def test_blocks_without_geometry_keep_provider_order_at_the_end(self) -> None:
        blocks = two_column_page(["Rainwater Analytics"])
        blocks.append({"page_number": 1, "text": "no geometry", "box": None})
        for name in ("geometry", "column"):
            self.assertEqual("no geometry", apply_order(blocks, name)[-1]["text"])

    def test_unknown_ordering_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            apply_order([], "semantic")


class TitleOracleTests(unittest.TestCase):
    def test_oracle_reports_recovery_when_the_title_is_present(self) -> None:
        oracle = title_oracle(two_column_page(["Rainwater Analytics"]), "Rainwater Analytics")
        self.assertTrue(oracle["top1"])
        self.assertTrue(oracle["in_individual_blocks"])
        self.assertEqual(1.0, oracle["best_group_similarity"])

    def test_oracle_reports_absence_when_the_title_was_never_recognised(self) -> None:
        oracle = title_oracle(two_column_page(["Something Entirely Different"]), "Rainwater Analytics")
        self.assertFalse(oracle["top1"])
        self.assertFalse(oracle["recoverable"])

    def test_top_k_coverage_is_monotonic(self) -> None:
        oracle = title_oracle(two_column_page(["Rainwater Analytics", "for Regional Libraries"]), "Rainwater Analytics")
        self.assertLessEqual(oracle["top1"], oracle["top3"])
        self.assertLessEqual(oracle["top3"], oracle["top5"])
        self.assertLessEqual(oracle["top5"], oracle["top8"])

    def test_every_declared_selector_variant_runs_and_is_label_blind(self) -> None:
        blocks = two_column_page(["Rainwater Analytics"])
        for selector, order in SELECTOR_VARIANTS:
            candidates = run_variant(selector, order, blocks)
            self.assertTrue(candidates, f"{selector}@{order} produced no candidate")
            self.assertLessEqual(len(candidates), 8)


class TaxonomyTests(unittest.TestCase):
    def test_exact_recovery_is_not_a_failure(self) -> None:
        record = classify(case(), two_column_page(["Rainwater Analytics"]))
        self.assertIn(record["category"], {"TITLE_EXACT", "D_READING_ORDER"})
        self.assertTrue(record["title_exact"])

    def test_selector_miss_is_detected_when_the_title_is_present_but_unranked(self) -> None:
        # A short title loses to the combined height of three stacked body lines, which is
        # the mechanism behind the merged benchmark's body-text title candidates.
        record = classify(case(), two_column_page(["Rainwater Analytics"], title_height=50.0))
        self.assertFalse(record["title_exact"])
        self.assertEqual("B_SELECTOR_MISS", record["category"])
        self.assertTrue(record["oracle"]["recoverable"])

    def test_recognition_error_is_distinguished_from_absence(self) -> None:
        near = classify(case(), two_column_page(["Rainwater Analytlcs"]))
        self.assertEqual("C_RECOGNITION_ERROR", near["category"])
        absent = classify(case(), two_column_page(["Completely Unrelated Heading Text"]))
        self.assertEqual("A_TITLE_ABSENT", absent["category"])

    def test_empty_output_is_classified_rather_than_crashing(self) -> None:
        self.assertEqual("F_OTHER", classify(case(), [])["category"])

    def test_every_category_is_declared(self) -> None:
        for blocks in ([], two_column_page(["Rainwater Analytics"]), two_column_page(["Nothing Alike Here At All"])):
            self.assertIn(classify(case(), blocks)["category"], CATEGORIES)

    def test_column_order_reduces_wer_on_a_two_column_page(self) -> None:
        blocks = two_column_page(["Rainwater Analytics"])
        scrambled = [blocks[index] for index in geometry_order(blocks)]
        decomposition = wer_decomposition(case(layout="two_column"), scrambled)
        self.assertLessEqual(decomposition["column_wer"], decomposition["raw_wer"])
        self.assertIn(decomposition["best_order"], {"raw", "geometry", "column"})


class InstrumentValidityTests(unittest.TestCase):
    def probe(self, engine: str, stroke: list[str], no_stroke: list[str], cases: list[str]) -> dict[str, object]:
        return {
            "stroke_exact_count": len(stroke),
            "no_stroke_exact_count": len(no_stroke),
            "recovered_only_without_stroke": [item for item in no_stroke if item not in stroke],
            "recovered_only_with_stroke": [item for item in stroke if item not in no_stroke],
            "records": [
                {
                    "case_id": item,
                    "stroke": {"exact": item in stroke},
                    "no_stroke": {"exact": item in no_stroke},
                }
                for item in cases
            ],
        }

    def test_ceiling_is_the_union_across_engines(self) -> None:
        cases = ["a", "b", "c", "d"]
        probes = {
            "paddle-tiny": self.probe("paddle-tiny", ["a"], ["a", "b"], cases),
            "paddle-medium": self.probe("paddle-medium", ["a"], ["a", "c"], cases),
        }
        validity = instrument_validity(probes)
        self.assertEqual(3, validity["union_recoverable_without_stroke"])
        self.assertEqual(0.75, validity["instrument_ceiling_rate"])
        self.assertEqual(["d"], validity["unrecoverable_case_ids"])
        self.assertFalse(validity["instrument_supports_final_gate"])

    def test_a_corpus_reaching_the_final_gate_is_reported_as_supporting_it(self) -> None:
        cases = [f"case-{index}" for index in range(20)]
        probes = {"paddle-tiny": self.probe("paddle-tiny", cases, cases, cases)}
        validity = instrument_validity(probes)
        self.assertEqual(1.0, validity["instrument_ceiling_rate"])
        self.assertTrue(validity["instrument_supports_final_gate"])
        self.assertGreaterEqual(validity["instrument_ceiling_rate"], FINAL_EXACT_TITLE_GATE)

    def test_absent_probe_is_reported_rather_than_assumed(self) -> None:
        self.assertFalse(instrument_validity({})["measured"])


class DecisionContractTests(unittest.TestCase):
    def worthy(self, holdout_worthy: bool) -> dict[str, object]:
        return {"holdout_worthy": holdout_worthy}

    def test_a_holdout_worthy_candidate_freezes_the_next_iteration(self) -> None:
        self.assertEqual(
            "READY_TO_FREEZE_OCR_ITERATION_2_HOLDOUT", decide([self.worthy(True)], False, False)
        )

    def test_conflicting_evidence_outranks_a_recognition_verdict(self) -> None:
        self.assertEqual("NEEDS_MORE_OCR_FAILURE_ANALYSIS", decide([self.worthy(False)], True, True))

    def test_recognition_dominance_without_conflict_requests_a_challenger(self) -> None:
        self.assertEqual("NEEDS_OCR_MODEL_CHALLENGER", decide([self.worthy(False)], True, False))

    def test_neither_dominance_nor_conflict_requests_more_analysis(self) -> None:
        self.assertEqual("NEEDS_MORE_OCR_FAILURE_ANALYSIS", decide([self.worthy(False)], False, False))


class DevelopmentCorpusTests(unittest.TestCase):
    def test_exposed_development_corpus_is_the_merged_scored_corpus(self) -> None:
        cases = exposed_development_cases()
        self.assertEqual(48, len(cases))
        self.assertEqual(16, sum(item["split"] == "calibration" for item in cases))
        self.assertEqual(32, sum(item["split"] == "holdout" for item in cases))
        self.assertEqual(sorted(item["id"] for item in cases), [item["id"] for item in cases])

    def test_development_gate_is_weaker_than_the_final_production_gate(self) -> None:
        self.assertLess(DEVELOPMENT_GATE["exact_title_rate_minimum"], FINAL_EXACT_TITLE_GATE)
        self.assertGreater(DEVELOPMENT_GATE["mean_wer_maximum"], 0.12)
        self.assertEqual(0, DEVELOPMENT_GATE["material_false_agreements_maximum"])
        self.assertEqual(4294967296, OPERATIONAL_CEILINGS["peak_working_set_bytes_maximum"])

    def test_diagnostic_package_is_outside_the_merged_protocol_freeze(self) -> None:
        frozen = {path.as_posix() for path in protocol_frozen_paths(tool_root())}
        diagnostic = tool_root() / "src" / "assistive_validation_benchmark" / "ocr_failure_analysis"
        self.assertTrue(diagnostic.is_dir())
        for path in diagnostic.glob("*.py"):
            self.assertNotIn(path.as_posix(), frozen)


class StoredDiagnosticEvidenceTests(unittest.TestCase):
    def test_stored_diagnostic_report_recomputes(self) -> None:
        if not DIAGNOSTIC_REPORT.is_file():
            self.skipTest("diagnostic evidence is added after the measurement runs")
        report = validate_report(json.loads(DIAGNOSTIC_REPORT.read_text(encoding="utf-8")))
        self.assertEqual("pp1-ocr-failure-analysis/v1", report["schema_version"])
        self.assertFalse(report["development_corpus"]["independent_holdout"])
        self.assertFalse(report["final_production_gate_unchanged"]["altered_by_this_iteration"])

    def test_stored_diagnostic_report_keeps_the_production_boundary(self) -> None:
        if not DIAGNOSTIC_REPORT.is_file():
            self.skipTest("diagnostic evidence is added after the measurement runs")
        report = json.loads(DIAGNOSTIC_REPORT.read_text(encoding="utf-8"))
        boundary = report["production_boundary"]
        self.assertEqual(["NONE", "TESSERACT"], boundary["production_ocr_task_providers"])
        self.assertEqual("NONE", boundary["coordinator_ocr_selection"])
        self.assertEqual(33, boundary["migration_count"])
        self.assertFalse(boundary["migration_34"])

    def test_stored_diagnostic_report_does_not_carry_ocr_transcripts(self) -> None:
        if not DIAGNOSTIC_REPORT.is_file():
            self.skipTest("diagnostic evidence is added after the measurement runs")
        report = json.loads(DIAGNOSTIC_REPORT.read_text(encoding="utf-8"))
        for configurations in report["engines"].values():
            for summary in configurations.values():
                for record in summary["records"]:
                    self.assertNotIn("blocks", record)
                    self.assertNotIn("selected_candidate", record)


if __name__ == "__main__":
    unittest.main()
