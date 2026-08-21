from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from assistive_validation_benchmark.ocr_productionization.boundary import check_production_boundary
from assistive_validation_benchmark.ocr_productionization.corpus import generate_assets
from assistive_validation_benchmark.ocr_productionization.evidence import verify_protocol_freeze
from assistive_validation_benchmark.ocr_productionization.provision import tree_sha256
from assistive_validation_benchmark.ocr_productionization.schema import (
    data_root,
    load_json,
    prove_phase0_holdout_independence,
    repository_root,
    validate_artifact_manifest,
    validate_combined_corpus,
    validate_protocol,
    validate_corpus_part,
)
from assistive_validation_benchmark.ocr_productionization.title_safety import (
    evaluate_title_safety,
    extract_title_candidates,
    normalize_metric_title,
    normalize_production_title,
)


class OcrProductionizationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.calibration = load_json(data_root() / "corpus" / "calibration.json")

    def test_pre_freeze_calibration_is_valid_without_a_holdout(self) -> None:
        manifest = validate_combined_corpus(self.calibration, None)
        self.assertIsNone(manifest["holdout"])
        self.assertEqual(16, sum(case["split"] == "calibration" for case in self.calibration["ocr_cases"]))
        self.assertEqual(1, sum(case["split"] == "warmup" for case in self.calibration["ocr_cases"]))

    def test_protocol_keeps_complete_quality_gate_and_no_integration_authority(self) -> None:
        protocol = validate_protocol(load_json(data_root() / "protocol.json"))
        self.assertEqual(0.95, protocol["quality_gate"]["holdout_exact_title_recovery_minimum"])
        self.assertEqual(0.12, protocol["quality_gate"]["holdout_mean_wer_maximum"])
        self.assertFalse(protocol["selection_contract"]["production_integration_authorized"])

    def test_official_artifact_manifest_is_frozen_and_path_free(self) -> None:
        manifest = validate_artifact_manifest(load_json(data_root() / "artifact-manifest.json"))
        self.assertEqual(6, len(manifest["artifacts"]))
        serialized = json.dumps(manifest)
        self.assertNotIn("C:\\", serialized)
        self.assertNotIn("/home/", serialized)

    def test_fresh_calibration_reuses_no_phase0_holdout_content(self) -> None:
        proof = prove_phase0_holdout_independence(validate_combined_corpus(self.calibration, None))
        self.assertEqual(0, proof["reused_cases"])
        self.assertGreater(proof["phase0_holdout_cases_checked"], 0)

    def test_corpus_generation_is_byte_deterministic(self) -> None:
        holdout_path = data_root() / "corpus" / "holdout.json"
        holdout = load_json(holdout_path) if holdout_path.is_file() else None
        manifest = validate_combined_corpus(self.calibration, holdout)
        with tempfile.TemporaryDirectory() as first, tempfile.TemporaryDirectory() as second:
            left = generate_assets(manifest, Path(first))
            right = generate_assets(manifest, Path(second))
        self.assertEqual(left["corpus_asset_sha256"], right["corpus_asset_sha256"])
        self.assertEqual(left["assets"], right["assets"])

    def test_stored_evidence_is_bound_to_the_git_protocol_freeze(self) -> None:
        report_path = repository_root() / "docs" / "assistive-validation" / "evidence" / "ocr-productionization-report.json"
        if not report_path.is_file():
            self.skipTest("final evidence is added only after the protocol-freeze commit")
        report = load_json(report_path)
        observed = verify_protocol_freeze(data_root().parent, report["protocol_freeze"]["protocol_freeze_commit_sha"])
        self.assertEqual(report["protocol_freeze"]["protocol_freeze_commit_sha"], observed["protocol_freeze_commit_sha"])
        self.assertEqual(report["protocol_freeze"]["frozen_file_count"], observed["frozen_file_count"])
        self.assertTrue(observed["holdout_absent_at_freeze"])

    def test_stored_gate_booleans_match_frozen_numeric_thresholds(self) -> None:
        report_path = repository_root() / "docs" / "assistive-validation" / "evidence" / "ocr-productionization-report.json"
        if not report_path.is_file():
            self.skipTest("final evidence is added only after the protocol-freeze commit")
        report = load_json(report_path)
        protocol = validate_protocol(load_json(data_root() / "protocol.json"))
        for engine in report["engines"].values():
            self.assertEqual(
                engine["gate_checks"]["exact_title"],
                engine["exact_title_rate"] >= protocol["quality_gate"]["holdout_exact_title_recovery_minimum"],
            )
            self.assertEqual(
                engine["gate_checks"]["wer"],
                engine["mean_wer"] <= protocol["quality_gate"]["holdout_mean_wer_maximum"],
            )
            self.assertEqual(
                engine["gate_checks"]["title_safety"],
                engine["downstream_title_safety"]["material_false_agreements"]
                <= protocol["quality_gate"]["material_false_agreements_maximum"],
            )

    def test_title_normalization_preserves_production_parity(self) -> None:
        self.assertEqual(
            normalize_production_title("“AI–Enabled Flood Warning System!”"),
            normalize_production_title("AI-Enabled Flood Warning System"),
        )
        self.assertEqual(
            normalize_metric_title("Learners’ Safe—Route Planner"),
            normalize_metric_title("learners safe route planner"),
        )

    def test_title_candidates_are_metadata_blind_and_join_wrapped_heading(self) -> None:
        blocks = [
            {"page_number": 1, "text": "Microgrid Health", "box": {"left": 40, "top": 30, "right": 500, "bottom": 80}},
            {"page_number": 1, "text": "Monitor: Stage 2", "box": {"left": 40, "top": 88, "right": 500, "bottom": 138}},
            {"page_number": 1, "text": "BACKGROUND", "box": {"left": 40, "top": 260, "right": 210, "bottom": 280}},
        ]
        candidates = extract_title_candidates(blocks)
        self.assertEqual("Microgrid Health Monitor: Stage 2", candidates[0].text)

    def test_downstream_title_rule_never_agrees_to_material_calibration_negatives(self) -> None:
        for case in self.calibration["ocr_cases"]:
            if case["expected_agreement"]:
                continue
            candidates = extract_title_candidates(
                [{"page_number": 1, "text": case["title"], "box": {"left": 20, "top": 20, "right": 600, "bottom": 70}}]
            )
            self.assertNotEqual("AGREES", evaluate_title_safety(case["metadata_title"], candidates)["outcome"])

    def test_tree_hash_binds_paths_sizes_and_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "model.json").write_text("{}", encoding="utf-8")
            before = tree_sha256(root)
            (root / "model.json").write_text('{"changed":true}', encoding="utf-8")
            self.assertNotEqual(before, tree_sha256(root))

    def test_malformed_security_controls_are_separate_from_scored_ocr(self) -> None:
        holdout = {
            "schema_version": "pp1-ocr-corpus-part/v1",
            "corpus_version": "pp1-ocr-productionization-corpus-v1",
            "seed": 2026082101,
            "part": "holdout",
            "ocr_cases": [],
            "native_controls": [],
            "security_controls": [
                {
                    "id": "security-hold-001",
                    "split": "security_control",
                    "asset": "security-hold-001.pdf",
                    "kind": "malformed_pdf",
                    "expected": "BOUNDED_REJECTION",
                },
                {
                    "id": "security-hold-002",
                    "split": "security_control",
                    "asset": "security-hold-002.png",
                    "kind": "truncated_png",
                    "expected": "BOUNDED_REJECTION",
                },
            ],
        }
        self.assertEqual(2, len(validate_corpus_part(holdout, "holdout")["security_controls"]))

    def test_production_boundary_remains_none_tesseract_and_33_migrations(self) -> None:
        boundary = check_production_boundary(repository_root())
        self.assertEqual(["NONE", "TESSERACT"], boundary["production_ocr_task_providers"])
        self.assertEqual("NONE", boundary["coordinator_ocr_selection"])
        self.assertEqual(33, boundary["migration_count"])
        self.assertEqual(0, boundary["production_paddle_imports"])


if __name__ == "__main__":
    unittest.main()
