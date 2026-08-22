from __future__ import annotations

import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from PIL import ImageChops

from assistive_validation_benchmark.ocr_failure_analysis.ordering import apply_order
from assistive_validation_benchmark.ocr_failure_analysis.selectors import run_variant
from assistive_validation_benchmark.ocr_iteration2_calibration import schema as schema_module
from assistive_validation_benchmark.ocr_iteration2_calibration.corpus import (
    evaluate_controls,
    generate_assets,
    reference_text,
    render_tracking_pair,
)
from assistive_validation_benchmark.ocr_iteration2_calibration.report import validate_report
from assistive_validation_benchmark.ocr_iteration2_calibration.schema import (
    ALLOWED_DECISIONS,
    assert_no_holdout_artifacts,
    check_inputs,
    data_root,
    load_json,
    repository_root,
    validate_corpus,
    validate_font_manifest,
    validate_protocol,
)
from assistive_validation_benchmark.ocr_iteration2_calibration.scoring import (
    OPERATIONAL_CHECK_KEYS,
    score_capture,
    select_configuration,
    summarize_records,
)


REPORT = repository_root() / "docs" / "assistive-validation" / "evidence" / "ocr-productionization-iteration2-calibration.json"
SELECTED_ENGINE = "paddle-small"
SELECTED_CONFIGURATION = "dpi180-edge1920"
PASSING_HISTORICAL_PRIOR = {key: True for key in OPERATIONAL_CHECK_KEYS}


def block(text: str, left: float, top: float, right: float, bottom: float) -> dict[str, object]:
    return {"page_number": 1, "text": text, "box": {"left": left, "top": top, "right": right, "bottom": bottom}}


def synthetic_case(identifier: str, title: str, metadata_title: str, expected: bool) -> dict[str, object]:
    return {
        "id": identifier,
        "title": title,
        "metadata_title": metadata_title,
        "expected_agreement": expected,
        "body_sections": ["First synthetic section.", "Second synthetic section.", "Third synthetic section."],
    }


def synthetic_blocks(case: dict[str, object]) -> list[dict[str, object]]:
    return [
        block(str(case["title"]), 100, 20, 700, 80),
        block("BACKGROUND", 50, 200, 250, 225),
        block("First synthetic section.", 50, 235, 350, 255),
        block("METHOD", 50, 275, 180, 300),
        block("Second synthetic section.", 50, 310, 360, 330),
        block("EVIDENCE", 50, 350, 200, 375),
        block("Third synthetic section.", 50, 385, 350, 405),
    ]


class CorpusContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.protocol = validate_protocol(load_json(data_root() / "protocol.json"))
        self.corpus = validate_corpus(load_json(data_root() / "corpus" / "calibration.json"))

    def test_corrected_corpus_is_calibration_only_and_novel(self) -> None:
        checks = check_inputs()
        self.assertEqual(28, checks["calibration_case_count"])
        self.assertEqual(0, checks["corpus_novelty"]["exact_title_body_reuse_count"])
        self.assertFalse(checks["no_holdout_assertion"]["independent_holdout"])
        self.assertEqual(0, checks["no_holdout_assertion"]["holdout_artifact_count"])

    def test_no_v2_holdout_file_or_case_id_exists(self) -> None:
        self.assertFalse((data_root() / "corpus" / "holdout.json").exists())
        self.assertTrue(all("hold" not in case["id"] for case in self.corpus["ocr_cases"]))
        self.assertIs(self.corpus["independent_holdout"], False)

    def test_no_holdout_guard_rejects_an_accidental_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "holdout.json").write_text("{}", encoding="utf-8")
            with mock.patch.object(schema_module, "data_root", return_value=root):
                with self.assertRaisesRegex(ValueError, "holdout artifacts"):
                    assert_no_holdout_artifacts()

    def test_no_holdout_guard_rejects_an_accidental_case_id(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            forbidden_id = "ocr2-" + "hold-001"
            (root / "cases.json").write_text(json.dumps({"id": forbidden_id}), encoding="utf-8")
            with mock.patch.object(schema_module, "data_root", return_value=root):
                with self.assertRaisesRegex(ValueError, "holdout case ID"):
                    assert_no_holdout_artifacts()

    def test_generation_is_byte_deterministic(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first = generate_assets(self.corpus, root / "first")
            second = generate_assets(self.corpus, root / "second")
            self.assertEqual(first, second)
            self.assertEqual(34, first["asset_count"])
            controls = evaluate_controls(self.corpus, root / "first")
            self.assertEqual(1.0, controls["native_pdf_title_recovery_rate"])
            self.assertTrue(controls["security_controls_failed_safely"])

    def test_visual_tracking_never_mutates_semantic_title_text(self) -> None:
        tracked = next(case for case in self.corpus["ocr_cases"] if case["title_style"] == "tracked")
        semantic_before = tracked["title"]
        visual, untracked = render_tracking_pair(tracked, self.corpus["seed"])
        try:
            self.assertEqual(semantic_before, tracked["title"])
            self.assertNotIn("  ", tracked["title"])
            self.assertIsNotNone(ImageChops.difference(visual, untracked).getbbox())
        finally:
            visual.close()
            untracked.close()

    def test_normal_titles_dominate_and_outline_is_a_labelled_minority(self) -> None:
        scored = [case for case in self.corpus["ocr_cases"] if case["split"] == "calibration"]
        self.assertGreaterEqual(sum(case["title_style"] == "plain" for case in scored), len(scored) // 2)
        outlined = [case for case in scored if case["title_style"] == "outlined"]
        self.assertEqual(1, len(outlined))
        self.assertIn("outlined_title_minority", outlined[0]["tags"])


class FontAndUnicodeTests(unittest.TestCase):
    def test_pinned_unicode_font_and_glyph_contract(self) -> None:
        manifest = validate_font_manifest(load_json(data_root() / "font" / "manifest.json"))
        self.assertEqual("Noto Sans", manifest["family"])
        self.assertEqual("SIL Open Font License 1.1", manifest["license"])
        self.assertFalse(manifest["runtime_download"])
        self.assertEqual("114a6bf229142e7aac8ee83e70ca77563b46b16e80e2e50ad3a053b442f969b6", manifest["sha256"])

    def test_claimed_unicode_occurs_in_semantic_reference_text(self) -> None:
        corpus = validate_corpus(load_json(data_root() / "corpus" / "calibration.json"))
        text = "\n".join(reference_text(case) for case in corpus["ocr_cases"] if case["split"] == "calibration")
        for glyph in ("é", "’", "–", "—", "₂"):
            self.assertIn(glyph, text)


class SelectorAndReadingOrderTests(unittest.TestCase):
    def test_required_selectors_are_metadata_blind_bounded_and_deterministic(self) -> None:
        page = synthetic_blocks(synthetic_case("x", "Coastal Drone Safety Ledger", "different metadata", True))
        contracts = validate_protocol(load_json(data_root() / "protocol.json"))["selectors"]
        self.assertEqual(
            ["production_geometry_prominence@raw", "first_line@raw", "first_bounded_group@geometry"],
            [contract["id"] for contract in contracts],
        )
        for contract in contracts:
            first = run_variant(contract["selector"], contract["order"], page)
            second = run_variant(contract["selector"], contract["order"], page)
            self.assertEqual(first, second)
            self.assertLessEqual(len(first), 8)

    def test_every_reading_order_is_one_fixed_permutation(self) -> None:
        page = synthetic_blocks(synthetic_case("x", "Coastal Drone Safety Ledger", "same", True))
        for name in ("raw", "geometry", "column"):
            first = apply_order(page, name)
            second = apply_order(page, name)
            self.assertEqual(first, second)
            self.assertCountEqual([item["text"] for item in page], [item["text"] for item in first])


def synthetic_scored_capture() -> dict[str, object]:
    positive = synthetic_case("case-positive", "Coastal Drone Safety Ledger", "Coastal Drone Safety Ledger", True)
    negative = synthetic_case("case-negative", "AI-Enabled Fire Warning System", "AI-Enabled Flood Warning System", False)
    cases = [positive, negative]
    capture = {
        "schema_version": "pp1-ocr-iteration2-capture/v1",
        "engine": "paddle-tiny",
        "configuration_id": "dpi150-edge960",
        "configuration": {"raster_dpi": 150, "max_input_dimension": 960},
        "versions": {},
        "environment": {},
        "offline": {"enabled": True, "self_test_passed": True},
        "cold_start_ms": 1000,
        "peak_working_set_bytes": 100,
        "artifact_footprint_bytes": 100,
        "case_count": 2,
        "failures": [],
        "records": [
            {"case_id": case["id"], "runtime_ms": 10, "blocks": synthetic_blocks(case)}
            for case in cases
        ],
    }
    protocol = validate_protocol(load_json(data_root() / "protocol.json"))
    return score_capture(
        capture,
        cases=cases,
        selector_contracts=protocol["selectors"],
        reading_orders=protocol["reading_orders"],
    )


class CalibrationArithmeticTests(unittest.TestCase):
    def scored(self) -> dict[str, object]:
        return synthetic_scored_capture()

    def test_metric_arithmetic_and_zero_false_automatic_agreements(self) -> None:
        scored = self.scored()
        summary = summarize_records(scored)
        for selector_id in ("first_line@raw", "first_bounded_group@geometry"):
            selector = summary["selectors"][selector_id]
            self.assertEqual(2, selector["exact_title_count"])
            self.assertEqual(0, selector["material_false_automatic_agreements"])
            self.assertEqual(1.0, selector["equality_path"]["precision"])
            self.assertEqual(1.0, selector["equality_path"]["recall"])
        self.assertEqual(0, summary["selectors"]["production_geometry_prominence@raw"]["exact_title_count"])
        self.assertEqual(
            0,
            summary["selectors"]["production_geometry_prominence@raw"]["material_false_automatic_agreements"],
        )
        self.assertEqual(0.0, summary["reading_orders"]["raw"]["wer"])

    def test_development_gate_is_not_a_production_select_decision(self) -> None:
        scored = self.scored()
        protocol = validate_protocol(load_json(data_root() / "protocol.json"))
        result = select_configuration(
            scored,
            selector_priority=[contract["id"] for contract in protocol["selectors"]],
            order_priority=protocol["reading_orders"],
            development_gate=protocol["development_gate"],
            historical_prior_checks=PASSING_HISTORICAL_PRIOR,
            operational_ceilings=protocol["operational_ceilings"],
        )
        self.assertTrue(result["holdout_worthy"])
        self.assertNotIn("SELECT", result)
        self.assertEqual(
            {
                "READY_TO_FREEZE_OCR_ITERATION_2_HOLDOUT_PROTOCOL",
                "NEEDS_OCR_MODEL_CHALLENGER",
                "NEEDS_MORE_OCR_CORPUS_CALIBRATION",
            },
            ALLOWED_DECISIONS,
        )


class OperationalGateTests(unittest.TestCase):
    """The development gate must measure the configuration actually scored, not only its engine's history."""

    def setUp(self) -> None:
        if not REPORT.is_file():
            self.skipTest("calibration evidence is added after the staged OCR run")
        self.report = json.loads(REPORT.read_text(encoding="utf-8"))
        self.protocol = validate_protocol(load_json(data_root() / "protocol.json"))
        self.ceilings = self.protocol["operational_ceilings"]
        self.base = copy.deepcopy(self.report["captures"][SELECTED_ENGINE][SELECTED_CONFIGURATION])

    def select(
        self,
        scored: dict[str, object],
        *,
        historical: dict[str, bool] | None = None,
    ) -> dict[str, object]:
        return select_configuration(
            scored,
            selector_priority=[contract["id"] for contract in self.protocol["selectors"]],
            order_priority=self.protocol["reading_orders"],
            development_gate=self.protocol["development_gate"],
            historical_prior_checks=PASSING_HISTORICAL_PRIOR if historical is None else historical,
            operational_ceilings=self.ceilings,
        )

    def with_runtimes(self, runtimes: list[float]) -> dict[str, object]:
        scored = copy.deepcopy(self.base)
        self.assertEqual(len(runtimes), len(scored["records"]))
        for record, runtime in zip(scored["records"], runtimes):
            record["runtime_ms"] = runtime
        return scored

    def assert_quality_arithmetic_unchanged(self, result: dict[str, object]) -> None:
        """Violating an operational ceiling must never move the title, WER or false-agreement arithmetic."""
        stored = self.report["configuration_results"][SELECTED_ENGINE][SELECTED_CONFIGURATION]
        self.assertEqual(stored["selected_selector"], result["selected_selector"])
        self.assertEqual(stored["selected_reading_order"], result["selected_reading_order"])
        self.assertEqual(stored["selected_exact_title_rate"], result["selected_exact_title_rate"])
        self.assertEqual(stored["selected_primary_wer"], result["selected_primary_wer"])
        self.assertEqual(
            stored["selected_material_false_automatic_agreements"],
            result["selected_material_false_automatic_agreements"],
        )
        for key in ("exact_title", "primary_wer", "title_safety", "executed_all_cases"):
            self.assertTrue(result["development_gate_checks"][key], key)

    def test_selected_configuration_passes_every_current_ceiling_from_stored_capture(self) -> None:
        result = self.select(copy.deepcopy(self.base))
        evidence = result["operational_evidence"]
        measured = evidence["current_configuration_measurements"]
        self.assertEqual({key: True for key in OPERATIONAL_CHECK_KEYS}, evidence["current_configuration_checks"])
        self.assertLessEqual(measured["cold_start_ms"], self.ceilings["cold_start_ms_maximum"])
        self.assertLessEqual(measured["p50_ms"], self.ceilings["p50_ms_maximum"])
        self.assertLessEqual(measured["p95_ms"], self.ceilings["p95_ms_maximum"])
        self.assertLessEqual(measured["peak_working_set_bytes"], self.ceilings["peak_working_set_bytes_maximum"])
        self.assertLessEqual(measured["artifact_footprint_bytes"], self.ceilings["artifact_footprint_bytes_maximum"])
        self.assertLessEqual(measured["maximum_case_runtime_ms"], self.ceilings["per_case_timeout_seconds"] * 1000)
        self.assertEqual(measured["p50_ms"], result["runtime"]["p50_ms"])
        self.assertEqual(measured["p95_ms"], result["runtime"]["p95_ms"])
        self.assertTrue(evidence["operational_plausible"])
        self.assertTrue(result["holdout_worthy"])

    def test_cold_start_above_ceiling_blocks_holdout_worthiness(self) -> None:
        scored = copy.deepcopy(self.base)
        scored["cold_start_ms"] = self.ceilings["cold_start_ms_maximum"] + 1
        result = self.select(scored)
        self.assertFalse(result["operational_evidence"]["current_configuration_checks"]["cold_start"])
        self.assertFalse(result["operational_evidence"]["operational_plausible"])
        self.assertFalse(result["holdout_worthy"])
        self.assert_quality_arithmetic_unchanged(result)

    def test_p50_above_ceiling_blocks_holdout_worthiness(self) -> None:
        over = float(self.ceilings["p50_ms_maximum"]) + 1
        scored = self.with_runtimes([over] * len(self.base["records"]))
        result = self.select(scored)
        checks = result["operational_evidence"]["current_configuration_checks"]
        self.assertFalse(checks["p50"])
        self.assertTrue(checks["p95"])
        self.assertTrue(checks["per_case_timeout"])
        self.assertFalse(result["holdout_worthy"])
        self.assert_quality_arithmetic_unchanged(result)

    def test_p95_above_ceiling_blocks_holdout_worthiness(self) -> None:
        count = len(self.base["records"])
        over = float(self.ceilings["p95_ms_maximum"]) + 1
        scored = self.with_runtimes([100.0] * (count - 2) + [over, over])
        result = self.select(scored)
        checks = result["operational_evidence"]["current_configuration_checks"]
        self.assertTrue(checks["p50"])
        self.assertFalse(checks["p95"])
        self.assertTrue(checks["per_case_timeout"])
        self.assertFalse(result["holdout_worthy"])
        self.assert_quality_arithmetic_unchanged(result)

    def test_one_case_above_the_ninety_second_timeout_blocks_holdout_worthiness(self) -> None:
        count = len(self.base["records"])
        over = float(self.ceilings["per_case_timeout_seconds"]) * 1000 + 1
        scored = self.with_runtimes([100.0] * (count - 1) + [over])
        result = self.select(scored)
        checks = result["operational_evidence"]["current_configuration_checks"]
        self.assertTrue(checks["p50"])
        self.assertTrue(checks["p95"])
        self.assertFalse(checks["per_case_timeout"])
        self.assertFalse(result["holdout_worthy"])
        self.assert_quality_arithmetic_unchanged(result)

    def test_peak_memory_above_ceiling_blocks_holdout_worthiness(self) -> None:
        scored = copy.deepcopy(self.base)
        scored["peak_working_set_bytes"] = self.ceilings["peak_working_set_bytes_maximum"] + 1
        result = self.select(scored)
        self.assertFalse(result["operational_evidence"]["current_configuration_checks"]["peak_memory"])
        self.assertFalse(result["holdout_worthy"])
        self.assert_quality_arithmetic_unchanged(result)

    def test_artifact_footprint_above_ceiling_blocks_holdout_worthiness(self) -> None:
        scored = copy.deepcopy(self.base)
        scored["artifact_footprint_bytes"] = self.ceilings["artifact_footprint_bytes_maximum"] + 1
        result = self.select(scored)
        self.assertFalse(result["operational_evidence"]["current_configuration_checks"]["artifact_footprint"])
        self.assertFalse(result["holdout_worthy"])
        self.assert_quality_arithmetic_unchanged(result)

    def test_failed_historical_prior_is_not_erased_by_a_faster_calibration_machine(self) -> None:
        historical = {**PASSING_HISTORICAL_PRIOR, "p50": False}
        result = self.select(copy.deepcopy(self.base), historical=historical)
        evidence = result["operational_evidence"]
        self.assertTrue(evidence["current_configuration_plausible"])
        self.assertFalse(evidence["historical_prior_plausible"])
        self.assertFalse(evidence["operational_plausible"])
        self.assertFalse(result["holdout_worthy"])
        self.assert_quality_arithmetic_unchanged(result)

    def test_failed_current_configuration_is_not_erased_by_a_passing_historical_prior(self) -> None:
        scored = copy.deepcopy(self.base)
        scored["cold_start_ms"] = self.ceilings["cold_start_ms_maximum"] + 1
        result = self.select(scored, historical=PASSING_HISTORICAL_PRIOR)
        evidence = result["operational_evidence"]
        self.assertTrue(evidence["historical_prior_plausible"])
        self.assertFalse(evidence["current_configuration_plausible"])
        self.assertFalse(evidence["operational_plausible"])
        self.assertFalse(result["holdout_worthy"])

    def test_operational_plausibility_requires_both_prior_and_current_evidence(self) -> None:
        result = self.select(copy.deepcopy(self.base), historical=PASSING_HISTORICAL_PRIOR)
        evidence = result["operational_evidence"]
        self.assertTrue(evidence["historical_prior_plausible"])
        self.assertTrue(evidence["current_configuration_plausible"])
        self.assertTrue(evidence["operational_plausible"])
        self.assertIs(
            evidence["operational_plausible"],
            evidence["historical_prior_plausible"] and all(evidence["current_configuration_checks"].values()),
        )
        self.assertTrue(result["holdout_worthy"])
        self.assertNotIn("SELECT", result)

    def test_medium_stays_disqualified_by_both_historical_and_current_evidence(self) -> None:
        stored = next(iter(self.report["configuration_results"]["paddle-medium"].values()))
        evidence = stored["operational_evidence"]
        self.assertFalse(evidence["historical_prior_plausible"])
        self.assertFalse(evidence["current_configuration_plausible"])
        self.assertFalse(evidence["operational_plausible"])
        self.assertFalse(stored["holdout_worthy"])

    def test_frozen_operational_ceilings_cannot_be_loosened(self) -> None:
        for key in self.ceilings:
            with self.subTest(ceiling=key):
                loosened = copy.deepcopy(self.protocol)
                loosened["operational_ceilings"][key] = self.ceilings[key] * 10
                with self.assertRaisesRegex(ValueError, "operational ceilings"):
                    validate_protocol(loosened)

    def test_stored_evidence_does_not_overclaim_cross_machine_operational_proof(self) -> None:
        comparability = self.report["latency_comparability"]
        self.assertFalse(comparability["comparable_to_merged_machine"])
        self.assertIn("calibration machine", comparability["current_configuration_ceiling_semantics"])
        self.assertIn("not proof", comparability["current_configuration_ceiling_semantics"])
        self.assertEqual(self.ceilings, self.report["operational_ceilings"])


class StoredOperationalTamperTests(unittest.TestCase):
    """validate_report must recompute the operational verdict from raw capture metrics, not echo it."""

    def setUp(self) -> None:
        if not REPORT.is_file():
            self.skipTest("calibration evidence is added after the staged OCR run")
        self.report = json.loads(REPORT.read_text(encoding="utf-8"))
        self.ceilings = validate_protocol(load_json(data_root() / "protocol.json"))["operational_ceilings"]

    def tampered(self) -> dict[str, object]:
        return copy.deepcopy(self.report)

    def capture_of(self, report: dict[str, object]) -> dict[str, object]:
        return report["captures"][SELECTED_ENGINE][SELECTED_CONFIGURATION]

    def assert_rejected(self, report: dict[str, object]) -> None:
        with self.assertRaises(ValueError):
            validate_report(report)

    def test_raw_cold_start_beyond_ceiling_is_rejected_while_the_verdict_claims_plausible(self) -> None:
        report = self.tampered()
        self.capture_of(report)["cold_start_ms"] = self.ceilings["cold_start_ms_maximum"] + 1
        self.assert_rejected(report)

    def test_raw_peak_memory_beyond_ceiling_is_rejected(self) -> None:
        report = self.tampered()
        self.capture_of(report)["peak_working_set_bytes"] = self.ceilings["peak_working_set_bytes_maximum"] + 1
        self.assert_rejected(report)

    def test_raw_artifact_footprint_beyond_ceiling_is_rejected(self) -> None:
        report = self.tampered()
        self.capture_of(report)["artifact_footprint_bytes"] = self.ceilings["artifact_footprint_bytes_maximum"] + 1
        self.assert_rejected(report)

    def test_raw_case_runtime_beyond_the_timeout_is_rejected(self) -> None:
        report = self.tampered()
        records = self.capture_of(report)["records"]
        records[-1]["runtime_ms"] = float(self.ceilings["per_case_timeout_seconds"]) * 1000 + 1
        self.assert_rejected(report)

    def test_stored_p95_measurement_contradicting_raw_runtimes_is_rejected(self) -> None:
        report = self.tampered()
        stored = report["configuration_results"][SELECTED_ENGINE][SELECTED_CONFIGURATION]
        stored["operational_evidence"]["current_configuration_measurements"]["p95_ms"] = (
            float(self.ceilings["p95_ms_maximum"]) + 1
        )
        self.assert_rejected(report)

    def test_flipped_operational_verdict_is_rejected(self) -> None:
        for engine, key in (
            ("paddle-medium", "operational_plausible"),
            ("paddle-medium", "historical_prior_plausible"),
            ("paddle-medium", "current_configuration_plausible"),
            (SELECTED_ENGINE, "operational_plausible"),
        ):
            with self.subTest(engine=engine, key=key):
                report = self.tampered()
                target = next(iter(report["configuration_results"][engine].values()))
                target["operational_evidence"][key] = not target["operational_evidence"][key]
                self.assert_rejected(report)

    def test_flipped_current_configuration_check_is_rejected(self) -> None:
        for key in OPERATIONAL_CHECK_KEYS:
            with self.subTest(check=key):
                report = self.tampered()
                target = next(iter(report["configuration_results"]["paddle-medium"].values()))
                target["operational_evidence"]["current_configuration_checks"][key] = not (
                    target["operational_evidence"]["current_configuration_checks"][key]
                )
                self.assert_rejected(report)

    def test_loosened_stored_operational_ceilings_are_rejected(self) -> None:
        report = self.tampered()
        report["operational_ceilings"] = {**self.ceilings, "p50_ms_maximum": 999999}
        self.assert_rejected(report)

    def test_hidden_cross_machine_comparability_is_rejected(self) -> None:
        report = self.tampered()
        report["latency_comparability"]["comparable_to_merged_machine"] = True
        self.assert_rejected(report)

    def test_untampered_stored_evidence_still_validates(self) -> None:
        validated = validate_report(self.tampered())
        self.assertEqual("READY_TO_FREEZE_OCR_ITERATION_2_HOLDOUT_PROTOCOL", validated["decision"])
        self.assertIn(validated["decision"], ALLOWED_DECISIONS)
        self.assertFalse(validated["scientific_integrity"]["independent_holdout"])
        self.assertFalse(validated["scientific_integrity"]["production_select_classification"])


class StoredEvidenceTests(unittest.TestCase):
    def test_stored_calibration_evidence_recomputes_without_raw_ocr_transcripts(self) -> None:
        if not REPORT.is_file():
            self.skipTest("calibration evidence is added after the staged OCR run")
        report = validate_report(json.loads(REPORT.read_text(encoding="utf-8")))
        self.assertEqual("calibration_only", report["scientific_integrity"]["measurement_role"])
        self.assertFalse(report["scientific_integrity"]["independent_holdout"])
        self.assertFalse(report["scientific_integrity"]["unbiased_accuracy_claimed"])
        self.assertFalse(report["scientific_integrity"]["production_select_classification"])
        for configurations in report["captures"].values():
            for capture in configurations.values():
                for record in capture["records"]:
                    self.assertNotIn("blocks", record)
                    self.assertNotIn("title_candidate", record)


if __name__ == "__main__":
    unittest.main()
