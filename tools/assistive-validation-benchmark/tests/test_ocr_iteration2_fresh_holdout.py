from __future__ import annotations

import copy
import json
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from assistive_validation_benchmark.ocr_iteration2_fresh_holdout.corpus import (
    FIXTURE_PREFIX,
    PREAPPROVAL_SCHEMA,
    SEED,
    SEED_DERIVATION_SHA256,
    SEED_INPUT,
    build_candidate,
    preapproval_corpus_sha256,
    semantic_review_cases,
    validate_fixture_allocation,
)
from assistive_validation_benchmark.ocr_iteration2_fresh_holdout.runner import execute_once
from assistive_validation_benchmark.ocr_iteration2_fresh_holdout.seal import (
    APPROVAL_INPUT_SCHEMA,
    _generation_manifest,
    _restore_pending_for_lock,
    apply_human_approval,
    validate_generation_manifest,
)
from assistive_validation_benchmark.ocr_iteration2_holdout_protocol.schema import (
    data_root as protocol_data_root,
    load_json,
    validate_protocol,
)


class FreshHoldoutAllocationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.protocol = validate_protocol(load_json(protocol_data_root() / "protocol.json"))

    def test_seed_is_the_full_sha256_big_endian_integer(self) -> None:
        self.assertEqual(
            "pp1-ocr-iteration2-fresh-holdout-v2|c0b175380fef5f328a9b079884c437300ea9b7a4",
            SEED_INPUT,
        )
        self.assertEqual("19aa7ef13d98337b9b8491a04d003b23f66c617ea4f4536ee5917d3dfd8e2eaa", SEED_DERIVATION_SHA256)
        self.assertEqual(int(SEED_DERIVATION_SHA256, 16), SEED)

    def test_fixture_namespace_satisfies_every_frozen_allocation_floor(self) -> None:
        corpus = build_candidate(prefix=FIXTURE_PREFIX)
        serialized = json.dumps(corpus, ensure_ascii=False)
        self.assertNotRegex(serialized, r"ocr2h-[0-9]{3}")
        summary = validate_fixture_allocation(corpus, self.protocol)
        self.assertEqual(40, summary["scored_case_count"])
        self.assertEqual({"clean": 20, "challenging": 20}, summary["difficulty"])
        self.assertEqual({"jpeg": 13, "png": 14, "scanned_pdf": 13}, summary["media"])
        self.assertEqual({"one_column": 14, "three_column": 13, "two_column": 13}, summary["layout"])
        self.assertGreaterEqual(min(summary["media_difficulty_cells"].values()), 6)
        self.assertGreaterEqual(min(summary["layout_difficulty_cells"].values()), 6)
        self.assertEqual(32, summary["distractors"]["cases_with_distractor_above_title"])
        self.assertEqual(16, summary["distractors"]["cases_with_distractor_near_title"])
        self.assertEqual(8, summary["distractors"]["cases_with_title_as_topmost_region"])
        self.assertTrue(all(value >= 3 for value in summary["distractors"]["kinds"].values()))
        self.assertEqual({"outlined": 2, "plain": 26, "shadow": 3, "tracked": 3, "wrapped": 6}, summary["title_style"])
        self.assertTrue(all(summary["title_text_coverage"].values()))
        self.assertEqual(6, summary["degradation"]["low_resolution"])
        self.assertEqual(7, summary["degradation"]["moderate_compression"])
        self.assertEqual(6, summary["degradation"]["mild_noise"])
        self.assertEqual(12, summary["degradation"]["medium_or_low_contrast"])
        self.assertEqual(6, summary["degradation"]["small_body_text"])
        self.assertEqual(2, summary["negative_kind"]["one_character_material"])
        self.assertEqual(2, summary["negative_kind"]["one_word_material"])
        self.assertEqual(2, summary["negative_kind"]["semantically_related_incorrect"])
        self.assertEqual(2, summary["negative_kind"]["number_or_version"])
        self.assertEqual(2, summary["negative_kind"]["punctuation_only_non_material"])
        self.assertEqual(1, summary["warmup_count"])
        self.assertEqual(3, summary["native_control_count"])
        self.assertEqual(2, summary["security_control_count"])

    def test_fixture_generation_is_deterministic_without_trying_alternate_seeds(self) -> None:
        self.assertEqual(build_candidate(prefix=FIXTURE_PREFIX), build_candidate(prefix=FIXTURE_PREFIX))

    def test_semantic_evidence_remains_pending_and_hash_is_tamper_evident(self) -> None:
        corpus = build_candidate(prefix=FIXTURE_PREFIX)
        semantic = [case for case in corpus["ocr_cases"] if case["negative_kind"] == "semantically_related_incorrect"]
        self.assertEqual(2, len(semantic))
        self.assertTrue(all(case["negative_relation_evidence"] is None for case in semantic))
        self.assertTrue(all(item["proposed_rationale"] for item in semantic_review_cases(corpus)))
        locked = preapproval_corpus_sha256(corpus)
        changed = copy.deepcopy(corpus)
        changed["ocr_cases"][0]["title"] += " Changed"
        self.assertNotEqual(locked, preapproval_corpus_sha256(changed))

    def test_explicit_human_input_changes_only_semantic_relation_fields(self) -> None:
        corpus = build_candidate(prefix=FIXTURE_PREFIX)
        review_cases = semantic_review_cases(corpus)
        preapproval = {
            "schema_version": PREAPPROVAL_SCHEMA,
            "protocol_version": self.protocol["protocol_version"],
            "seed": SEED,
            "seed_derivation_sha256": SEED_DERIVATION_SHA256,
            "preapproval_corpus_sha256": preapproval_corpus_sha256(corpus),
            "semantic_review_cases": review_cases,
            "ocr_run_count": 0,
            "ocr_executed": False,
            "holdout_result_exists": False,
        }
        approval = {
            "schema_version": APPROVAL_INPUT_SCHEMA,
            "approved": True,
            "cases": [
                {
                    "case_id": item["case_id"],
                    "poster_title": item["poster_title"],
                    "metadata_title": item["metadata_title"],
                    "rationale": item["proposed_rationale"],
                }
                for item in review_cases
            ],
        }
        approved, evidence = apply_human_approval(corpus, preapproval, approval)
        self.assertEqual([], evidence["corrections"])
        self.assertFalse(evidence["ocr_executed"])
        self.assertFalse(evidence["ocr_result_available_during_review"])
        self.assertFalse(evidence["ocr_executed_before_approval"])
        self.assertTrue(all(case["negative_relation_evidence"] is None for case in corpus["ocr_cases"]))
        approved_semantic = [case for case in approved["ocr_cases"] if case["negative_kind"] == "semantically_related_incorrect"]
        self.assertTrue(all(case["negative_relation_evidence"]["authority"] == "human_ground_truth" for case in approved_semantic))
        restored = copy.deepcopy(approved)
        for case in restored["ocr_cases"]:
            if case["negative_kind"] == "semantically_related_incorrect":
                case["negative_relation_evidence"] = None
        self.assertEqual(corpus, restored)

        tampered = copy.deepcopy(approved)
        tampered["ocr_cases"][4]["title"] += " Changed"
        with self.assertRaisesRegex(ValueError, "differs from the human-reviewed semantic titles"):
            _restore_pending_for_lock(tampered, evidence)

        changed = copy.deepcopy(approval)
        changed["cases"][0]["poster_title"] += " Changed"
        with self.assertRaisesRegex(ValueError, "differs from the locked semantic judgement"):
            apply_human_approval(corpus, preapproval, changed)

    def test_generation_manifest_binds_every_case_and_control(self) -> None:
        corpus = build_candidate(prefix=FIXTURE_PREFIX)
        records = [
            {"case_id": case["id"], "asset": case["asset"], "bytes": 1, "sha256": "a" * 64}
            for case in corpus["ocr_cases"]
        ]
        records.extend(
            {"case_id": control["id"], "asset": control["asset"], "bytes": 1, "sha256": "a" * 64}
            for control in [*corpus["native_controls"], *corpus["security_controls"]]
        )
        generated = {
            "renderer_fingerprint_sha256": "d2f6571e2840f653cdb6c6f382e3a0834cd6c520ee525cccd5597533f026fb35",
            "corpus_asset_sha256": "b" * 64,
            "assets": records,
        }
        manifest = _generation_manifest(corpus, self.protocol, generated)
        self.assertEqual({"asset_count": 46, "corpus_sha256": manifest["corpus_sha256"]}, validate_generation_manifest(manifest, corpus))
        unsafe = copy.deepcopy(manifest)
        unsafe["assets"][0]["relative_asset_path"] = "../escape.png"
        with self.assertRaisesRegex(ValueError, "unsafe asset path"):
            validate_generation_manifest(unsafe, corpus)


class OneShotStateSafetyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.state = Path(self.temporary.name) / "run" / "one-shot-state.json"
        self.binding = {"pre_run_seal_sha256": "a" * 64, "corpus_sha256": "b" * 64}

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_failed_preflight_does_not_consume_the_run(self) -> None:
        def fail() -> None:
            raise ValueError("preflight failed")

        with self.assertRaisesRegex(ValueError, "preflight failed"):
            execute_once(self.state, self.binding, preflight=fail, operation=lambda _: {"unexpected": True})
        self.assertFalse(self.state.exists())

    def test_first_simulated_invocation_completes_and_repeat_is_refused(self) -> None:
        calls = []
        result = execute_once(
            self.state,
            self.binding,
            preflight=lambda: "prepared",
            operation=lambda prepared: calls.append(prepared) or {"mocked_capture": "completed"},
        )
        self.assertEqual({"mocked_capture": "completed"}, result)
        self.assertEqual(["prepared"], calls)
        with self.assertRaisesRegex(ValueError, "second first run"):
            execute_once(
                self.state,
                self.binding,
                preflight=lambda: "prepared-again",
                operation=lambda _: {"unexpected": True},
            )

    def test_simultaneous_claims_allow_exactly_one_winner(self) -> None:
        barrier = threading.Barrier(2)

        def invoke() -> str:
            def prepared() -> None:
                barrier.wait()

            try:
                execute_once(
                    self.state,
                    self.binding,
                    preflight=prepared,
                    operation=lambda _: {"mocked_capture": "completed"},
                )
                return "completed"
            except ValueError:
                return "refused"

        with ThreadPoolExecutor(max_workers=2) as executor:
            outcomes = sorted(executor.map(lambda _: invoke(), range(2)))
        self.assertEqual(["completed", "refused"], outcomes)

    def test_post_claim_failure_is_recorded_and_rerun_is_refused(self) -> None:
        def fail(_: object) -> dict[str, object]:
            raise RuntimeError("mocked OCR boundary failed")

        with self.assertRaisesRegex(RuntimeError, "mocked OCR boundary failed"):
            execute_once(self.state, self.binding, preflight=lambda: None, operation=fail)
        stored = json.loads(self.state.read_text(encoding="utf-8"))
        self.assertEqual("failed", stored["status"])
        self.assertEqual(1, stored["ocr_run_count"])
        self.assertFalse(stored["rerun_permitted"])
        with self.assertRaisesRegex(ValueError, "second first run"):
            execute_once(self.state, self.binding, preflight=lambda: None, operation=lambda _: {})


if __name__ == "__main__":
    unittest.main()
