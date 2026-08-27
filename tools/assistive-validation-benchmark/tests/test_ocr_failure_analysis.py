from __future__ import annotations

import hashlib
import json
import unittest
from pathlib import Path
from unittest import mock

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
from assistive_validation_benchmark.ocr_failure_analysis import report as report_module
from assistive_validation_benchmark.ocr_failure_analysis.report import (
    FINAL_EXACT_TITLE_GATE,
    ITERATION_2A_PRODUCTION_BOUNDARY,
    MATERIAL_CONFOUND_DELTA,
    STROKE_PROBE_METHOD,
    decide,
    stroke_sensitivity,
    validate_historical_production_boundary,
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


class StrokeSensitivityTests(unittest.TestCase):
    def probe(self, stroke: list[str], no_stroke: list[str], cases: list[str]) -> dict[str, object]:
        return {
            "schema_version": "pp1-ocr-stroke-probe/v2",
            "full_poster_context": True,
            "stroke_exact_count": len(stroke),
            "no_stroke_exact_count": len(no_stroke),
            "by_selector": {
                "production_geometry_prominence@raw": {
                    "stroke_exact_count": len(stroke),
                    "no_stroke_exact_count": len(no_stroke),
                }
            },
            "recovered_only_without_stroke": [item for item in no_stroke if item not in stroke],
            "recovered_only_with_stroke": [item for item in stroke if item not in no_stroke],
            "records": [
                {
                    "case_id": item,
                    "stroke": {
                        "exact": item in stroke,
                        "exact_by_selector": {"production_geometry_prominence@raw": item in stroke},
                    },
                    "no_stroke": {
                        "exact": item in no_stroke,
                        "exact_by_selector": {"production_geometry_prominence@raw": item in no_stroke},
                    },
                }
                for item in cases
            ],
        }

    def test_union_is_reported_as_a_tested_engine_union_not_a_ceiling(self) -> None:
        cases = ["a", "b", "c", "d"]
        probes = {
            "paddle-tiny": self.probe(["a"], ["a", "b"], cases),
            "paddle-medium": self.probe(["a"], ["a", "c"], cases),
        }
        sensitivity = stroke_sensitivity(probes)
        self.assertEqual(3, sensitivity["tested_engine_union_without_stroke"])
        self.assertEqual(0.75, sensitivity["tested_engine_union_exact_rate"])
        self.assertEqual(["d"], sensitivity["cases_not_recovered_by_any_tested_candidate"])
        self.assertFalse(sensitivity["tested_candidates_reach_final_gate"])
        self.assertIn("not a bound on OCR models generally", sensitivity["scope"])

    def test_no_field_name_implies_a_universal_model_bound(self) -> None:
        cases = ["a", "b"]
        sensitivity = stroke_sensitivity({"paddle-tiny": self.probe(["a"], ["a", "b"], cases)})
        for key in sensitivity:
            self.assertNotIn("ceiling", key)
            self.assertNotIn("upper_bound", key)
            self.assertNotIn("unrecoverable", key)

    def test_tested_candidates_reaching_the_final_gate_is_reported_as_such(self) -> None:
        cases = [f"case-{index}" for index in range(20)]
        sensitivity = stroke_sensitivity({"paddle-tiny": self.probe(cases, cases, cases)})
        self.assertEqual(1.0, sensitivity["tested_engine_union_exact_rate"])
        self.assertTrue(sensitivity["tested_candidates_reach_final_gate"])
        self.assertGreaterEqual(sensitivity["tested_engine_union_exact_rate"], FINAL_EXACT_TITLE_GATE)

    def test_a_material_stroke_effect_is_flagged_as_a_corpus_confound(self) -> None:
        cases = [f"case-{index}" for index in range(20)]
        moved = stroke_sensitivity({"paddle-tiny": self.probe(cases[:10], cases[:16], cases)})
        self.assertGreaterEqual(moved["largest_absolute_exact_rate_delta"], MATERIAL_CONFOUND_DELTA)
        self.assertTrue(moved["corpus_rendering_confound_detected"])
        steady = stroke_sensitivity({"paddle-tiny": self.probe(cases[:10], cases[:10], cases)})
        self.assertEqual(0.0, steady["largest_absolute_exact_rate_delta"])
        self.assertFalse(steady["corpus_rendering_confound_detected"])

    def test_absent_probe_is_reported_rather_than_assumed(self) -> None:
        self.assertFalse(stroke_sensitivity({})["measured"])


class ScientificInterpretationRegressionTests(unittest.TestCase):
    """Guards against the specific interpretation errors corrected in this iteration.

    Each test names the error it prevents from returning, so a future change that reintroduces
    one fails with an explanation rather than a bare assertion.
    """

    def report(self) -> dict[str, object]:
        if not DIAGNOSTIC_REPORT.is_file():
            self.skipTest("diagnostic evidence is added after the measurement runs")
        return json.loads(DIAGNOSTIC_REPORT.read_text(encoding="utf-8"))

    def test_stored_evidence_never_claims_a_universal_ocr_model_ceiling(self) -> None:
        sensitivity = self.report()["stroke_sensitivity"]
        serialized = json.dumps(sensitivity, sort_keys=True).lower()
        for forbidden in ("upper bound", "ceiling", "any ocr model", "corpus_caps", "achievable on this corpus"):
            self.assertNotIn(forbidden, serialized, f"stroke sensitivity must not claim {forbidden!r}")
        self.assertIn("tested_engine_union_exact_rate", sensitivity)
        self.assertIn("not a bound on OCR models generally", sensitivity["scope"])

    def test_decision_is_not_forced_solely_by_tested_engine_union_being_below_the_gate(self) -> None:
        report = self.report()
        sensitivity = report["stroke_sensitivity"]
        # The union rate is below the final gate. That fact alone must not decide anything:
        # with no measured confound and no reproduction problem, the contract must be free to
        # return the challenger verdict instead.
        self.assertFalse(sensitivity["tested_candidates_reach_final_gate"])
        self.assertEqual(
            "NEEDS_OCR_MODEL_CHALLENGER",
            decide([{"holdout_worthy": False}], recognition_dominant=True, conflicting=False),
            "a sub-gate tested-engine union must not by itself force NEEDS_MORE_OCR_FAILURE_ANALYSIS",
        )

    def test_all_forty_eight_cases_remain_exposed_development_data(self) -> None:
        corpus = self.report()["development_corpus"]
        self.assertEqual("exposed_development_corpus", corpus["role"])
        self.assertEqual(48, corpus["exposed_case_count"])
        self.assertIs(False, corpus["independent_holdout"])
        self.assertIs(False, corpus["may_claim_unbiased_accuracy"])

    def test_merged_v1_evidence_remains_byte_unchanged(self) -> None:
        recorded = self.report()["source"]["merged_evidence"]
        merged = repository_root() / "docs" / "assistive-validation" / "evidence" / "ocr-productionization-report.json"
        observed = hashlib.sha256(merged.read_bytes()).hexdigest()
        self.assertEqual(recorded["file_sha256"], observed)
        self.assertEqual(
            "NEEDS_MORE_OCR_BENCHMARKING",
            json.loads(merged.read_text(encoding="utf-8"))["final_decision"],
        )

    def test_no_new_holdout_corpus_exists(self) -> None:
        corpus_dir = tool_root() / "ocr-productionization" / "corpus"
        self.assertEqual(
            {"calibration.json", "holdout.json"},
            {path.name for path in corpus_dir.glob("*.json")},
            "this iteration must not add a new holdout corpus part",
        )
        for pattern in ("*v2*", "*iteration-2*", "*holdout-2*"):
            self.assertEqual([], sorted(corpus_dir.glob(pattern)))

    def test_documentation_does_not_claim_metadata_guidance_improved_ocr_recovery(self) -> None:
        """Phase 0 records guided and blind OCR tracks as identical; the doc must not contradict it."""
        phase0 = json.loads(
            (repository_root() / "docs" / "assistive-validation" / "evidence" / "phase-0-report.json").read_text(
                encoding="utf-8"
            )
        )
        engines = phase0["results"]["ocr"]["engines"]
        for name, values in engines.items():
            self.assertEqual(
                values["title_recovery_rate"],
                values["title_recovery_rate_blind"],
                f"Phase 0 guided and blind OCR tracks must remain identical for {name}",
            )
        document = (
            repository_root() / "docs" / "assistive-validation" / "ocr-productionization-failure-analysis.md"
        ).read_text(encoding="utf-8")
        self.assertIn("is **not** explained by metadata guidance", document)
        for claim in ("used a metadata-**guided** candidate chooser", "never measuring the same thing"):
            self.assertNotIn(claim, document)


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

    def test_stored_production_boundary_is_iteration_2a_historical_evidence(self) -> None:
        if not DIAGNOSTIC_REPORT.is_file():
            self.skipTest("diagnostic evidence is added after the measurement runs")
        report = json.loads(DIAGNOSTIC_REPORT.read_text(encoding="utf-8"))
        boundary = report["production_boundary"]
        self.assertEqual(["NONE", "TESSERACT"], boundary["production_ocr_task_providers"])
        self.assertEqual("NONE", boundary["coordinator_ocr_selection"])
        self.assertEqual(33, boundary["migration_count"])
        self.assertEqual(0, boundary["production_paddle_imports"])
        self.assertFalse(boundary["migration_34"])
        self.assertEqual(ITERATION_2A_PRODUCTION_BOUNDARY, validate_historical_production_boundary(boundary))

    def test_historical_validation_does_not_require_future_live_production_state(self) -> None:
        """A later legitimate OCR integration must not invalidate an already-measured iteration."""
        if not DIAGNOSTIC_REPORT.is_file():
            self.skipTest("diagnostic evidence is added after the measurement runs")
        report = json.loads(DIAGNOSTIC_REPORT.read_text(encoding="utf-8"))
        hypothetical_future_production = {
            "production_ocr_task_providers": ["NONE", "TESSERACT", "PADDLE"],
            "coordinator_ocr_selection": "PADDLE",
            "production_paddle_imports": 4,
            "migration_count": 34,
            "production_provider_integration": True,
            "production_default_changed": True,
            "migration_34": True,
            "supabase_schema_changed": True,
        }
        self.assertNotEqual(report["production_boundary"], hypothetical_future_production)
        # No production file is touched: the live boundary reader is replaced so that any
        # dependency of validation on current repository state would surface as a failure.
        with mock.patch.object(
            report_module, "check_production_boundary", return_value=hypothetical_future_production
        ) as live_boundary:
            self.assertEqual(report, validate_report(report))
        live_boundary.assert_not_called()

    def test_historical_boundary_record_itself_is_still_asserted(self) -> None:
        for key, replacement in (
            ("production_ocr_task_providers", ["NONE", "TESSERACT", "PADDLE"]),
            ("coordinator_ocr_selection", "PADDLE"),
            ("migration_count", 34),
            ("production_paddle_imports", 1),
        ):
            with self.subTest(key=key):
                tampered = dict(ITERATION_2A_PRODUCTION_BOUNDARY, **{key: replacement})
                with self.assertRaises(ValueError):
                    validate_historical_production_boundary(tampered)

    def test_stroke_probe_method_wording_matches_what_the_probe_proves(self) -> None:
        if not DIAGNOSTIC_REPORT.is_file():
            self.skipTest("diagnostic evidence is added after the measurement runs")
        report = json.loads(DIAGNOSTIC_REPORT.read_text(encoding="utf-8"))
        sensitivity = report["stroke_sensitivity"]
        if not sensitivity.get("measured"):
            self.skipTest("stroke probe was not measured")
        self.assertEqual(STROKE_PROBE_METHOD, sensitivity["method"])
        self.assertIn("pixel-identical", STROKE_PROBE_METHOD)
        self.assertNotIn("byte-identical", STROKE_PROBE_METHOD)

    def test_permanent_ci_validates_history_and_never_the_live_production_boundary(self) -> None:
        """Permanent CI must not gate on live production state; PR scope is the diff check."""
        workflow = (repository_root() / ".github" / "workflows" / "assistive-benchmark-ci.yml").read_text(
            encoding="utf-8"
        )
        self.assertIn("ocr_failure_analysis check-report", workflow)
        self.assertNotIn("ocr_failure_analysis check-boundary", workflow)
        self.assertIn("Enforce the one-time READY-gated production boundary", workflow)
        self.assertIn("ocr_title_fullpage_holdout_v2 check-result", workflow)
        self.assertIn("apps/assistive-worker", workflow)
        self.assertIn("apps/admin-cms/src/scripts/runAssistiveCoordinator.ts", workflow)
        self.assertIn("infra/supabase", workflow)

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
