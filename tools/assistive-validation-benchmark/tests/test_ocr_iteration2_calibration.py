from __future__ import annotations

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
    score_capture,
    select_configuration,
    summarize_records,
)


REPORT = repository_root() / "docs" / "assistive-validation" / "evidence" / "ocr-productionization-iteration2-calibration.json"


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


class CalibrationArithmeticTests(unittest.TestCase):
    def scored(self) -> dict[str, object]:
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
            operational_plausible=True,
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
