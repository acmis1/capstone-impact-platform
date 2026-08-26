from __future__ import annotations

import unittest
from pathlib import Path

from assistive_validation_benchmark.ocr_productionization.title_safety import Candidate
from assistive_validation_benchmark.ocr_title_consistency.corpus import build_calibration_corpus
from assistive_validation_benchmark.ocr_title_consistency.evidence import non_reuse_evidence
from assistive_validation_benchmark.ocr_title_consistency.freeze import build_freeze_manifest
from assistive_validation_benchmark.ocr_title_consistency.schema import (
    calibration_data_root,
    load_json,
    validate_corpus,
    validate_protocol,
)
from assistive_validation_benchmark.ocr_title_consistency.scoring import score_capture
from assistive_validation_benchmark.ocr_title_consistency.selector import (
    evaluate_title_outcome,
    select_title_candidates,
)


class TitleConsistencyCorpusTests(unittest.TestCase):
    def test_calibration_is_deterministic_balanced_and_novel(self) -> None:
        corpus = build_calibration_corpus()
        validate_corpus(corpus, expected_split="calibration", expected_count=30)
        scored = [case for case in corpus["ocr_cases"] if case["split"] == "calibration"]
        self.assertEqual(10, sum(case["expected_consistency"] == "INCONSISTENT" for case in scored))
        self.assertEqual({"png", "jpeg", "scanned_pdf"}, {case["media"] for case in scored})
        self.assertEqual({"one_column", "two_column", "three_column"}, {case["layout"] for case in scored})
        tags = {tag for case in scored for tag in case["tags"]}
        required = {
            "large_centered_title", "left_aligned_title", "wrapped_two_line_title", "three_line_title",
            "stylized_title", "title_beside_logo", "nearby_heading", "top_page_administrative_distractor",
            "repeated_title_in_body", "subtitle_below_title", "punctuation_variant", "quote_variant",
            "hyphen_dash_variant", "capitalization_variant", "number_version_difference",
            "one_word_substitution", "acronym_difference", "added_removed_meaningful_token",
            "low_contrast", "mild_blur_noise", "jpeg_compression", "small_readable_title",
            "competing_large_heading", "title_absent", "materially_illegible_title", "hostile_prompt_text",
        }
        self.assertTrue(required <= tags)
        self.assertTrue(non_reuse_evidence(corpus, split="calibration")["passed"])

    def test_tracked_protocol_and_corpus_match_sources(self) -> None:
        validate_protocol(load_json(calibration_data_root() / "protocol.json"))
        tracked = load_json(calibration_data_root() / "corpus" / "calibration.json")
        self.assertEqual(build_calibration_corpus(), tracked)

    def test_freeze_builder_proves_holdout_absent_at_calibration_checkpoint(self) -> None:
        manifest = build_freeze_manifest("40e0f89ede258d6f3f038adf9f2d976902549a1c")
        self.assertTrue(manifest["calibration_checkpoint"]["holdout_path_absent"])
        self.assertFalse(manifest["holdout_existed_when_manifest_written"])


class TitleConsistencySelectorTests(unittest.TestCase):
    def test_multiline_title_outranks_small_administrative_control(self) -> None:
        blocks = [
            {"page_number": 1, "text": "SYNTHETIC REVIEW COPY", "box": {"left": 40, "top": 25, "right": 320, "bottom": 45}},
            {"page_number": 1, "text": "Solar Canopy Queue", "box": {"left": 220, "top": 100, "right": 700, "bottom": 158}},
            {"page_number": 1, "text": "Pulse Dashboard", "box": {"left": 270, "top": 164, "right": 650, "bottom": 222}},
            {"page_number": 1, "text": "PURPOSE", "box": {"left": 50, "top": 330, "right": 170, "bottom": 355}},
        ]
        selected = select_title_candidates(blocks)
        self.assertEqual("Solar Canopy Queue Pulse Dashboard", selected[0].text)

    def test_material_substitution_never_agrees(self) -> None:
        candidate = Candidate("AI-Enabled Fire Warning System", 1, None, (0,), 50, 1)
        outcome = evaluate_title_outcome("AI-Enabled Flood Warning System", [candidate])
        self.assertEqual("MISMATCH", outcome["outcome"])

    def test_hyphen_and_space_variant_agree_without_semantic_similarity(self) -> None:
        candidate = Candidate("AI Enabled Flood Warning System", 1, None, (0,), 50, 1)
        outcome = evaluate_title_outcome("AI-Enabled Flood Warning System", [candidate])
        self.assertEqual("AGREES", outcome["outcome"])

    def test_missing_candidate_requires_review(self) -> None:
        self.assertEqual("REVIEW", evaluate_title_outcome("Synthetic Project", [])["outcome"])


class TitleConsistencyScoringTests(unittest.TestCase):
    def test_metric_contract_reaches_margin_for_exact_safe_observations(self) -> None:
        corpus = build_calibration_corpus()
        protocol = validate_protocol(load_json(calibration_data_root() / "protocol.json"))
        records = []
        for case in [case for case in corpus["ocr_cases"] if case["split"] == "calibration"]:
            text = case.get("poster_title") or "SYNTHETIC REVIEW COPY"
            records.append(
                {
                    "case_id": case["id"],
                    "runtime_ms": 1000.0,
                    "peak_memory_bytes": 500_000_000,
                    "blocks": [
                        {"page_number": 1, "text": text, "box": {"left": 200.0, "top": 100.0, "right": 1200.0, "bottom": 160.0}}
                    ],
                }
            )
        capture = {
            "schema_version": "pp1-ocr-title-consistency-capture/v1",
            "configuration": protocol["configuration"],
            "versions": protocol["candidate"]["runtime"],
            "offline": {"enabled": True, "self_test_passed": True},
            "worker_concurrency": 1,
            "provisioning": {"downloaded_during_capture": False},
            "cold_start_ms": 5000.0,
            "peak_working_set_bytes": 500_000_000,
            "artifact_footprint_bytes": protocol["candidate"]["artifact_footprint_bytes"],
            "failures": [],
            "records": records,
        }
        result = score_capture(capture, corpus, protocol)
        self.assertEqual(1.0, result["exact_title_rate"])
        self.assertEqual(1.0, result["inconsistency_detection"]["precision"])
        self.assertEqual(1.0, result["inconsistency_detection"]["recall"])
        self.assertEqual(0, result["material_false_automatic_agreements"])
        self.assertEqual("DIAGNOSTIC_NON_GATING", result["body_wer_diagnostic"]["role"])
        self.assertTrue(result["calibration_margin_passed"])
        self.assertTrue(result["final_gates_passed"])
        self.assertTrue(result["final_gate_checks"]["automatic_agreement_precision"])
        self.assertEqual("READY_TO_FREEZE_TITLE_PROTOCOL", result["decision"])


if __name__ == "__main__":
    unittest.main()
