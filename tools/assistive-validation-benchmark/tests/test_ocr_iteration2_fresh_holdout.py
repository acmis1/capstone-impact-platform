from __future__ import annotations

import copy
import contextlib
import io
import json
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from assistive_validation_benchmark.ocr_iteration2_fresh_holdout.__main__ import _parser
from assistive_validation_benchmark.ocr_iteration2_fresh_holdout.corpus import (
    FIXTURE_PREFIX,
    PREAPPROVAL_SCHEMA,
    SEED,
    SEED_DERIVATION_SHA256,
    SEED_INPUT,
    build_candidate,
    corpus_path,
    preapproval_corpus_sha256,
    semantic_review_cases,
    validate_fixture_allocation,
)
from assistive_validation_benchmark.ocr_iteration2_fresh_holdout.runner import (
    CANONICAL_RUN_DIRECTORY,
    OFFLINE_GUARD_MECHANISM,
    canonical_run_dir,
    run_one_shot,
    score_holdout_capture,
)
from assistive_validation_benchmark.ocr_iteration2_fresh_holdout.seal import (
    APPROVAL_INPUT_SCHEMA,
    _generation_manifest,
    _restore_pending_for_lock,
    apply_human_approval,
    validate_generation_manifest,
)
from assistive_validation_benchmark.ocr_iteration2_holdout_protocol.renderer import reference_text
from assistive_validation_benchmark.ocr_iteration2_holdout_protocol.schema import (
    data_root as protocol_data_root,
    load_json,
    tool_root,
    validate_protocol,
)


RUNNER_MODULE = "assistive_validation_benchmark.ocr_iteration2_fresh_holdout.runner"
CAPTURE_MODULE = "assistive_validation_benchmark.ocr_iteration2_calibration.capture"
ENGINE_MODULE = "assistive_validation_benchmark.ocr_productionization.engine"
PROVISION_MODULE = "assistive_validation_benchmark.ocr_productionization.provision"


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
        self.run_dir = Path(self.temporary.name) / "canonical-run"
        self.state = self.run_dir / "one-shot-state.json"
        self.models_dir = Path(self.temporary.name) / "models"

    def tearDown(self) -> None:
        self.temporary.cleanup()

    @contextlib.contextmanager
    def _mocked_runtime_preflight(self, versions: dict[str, str]):
        protocol = validate_protocol(load_json(protocol_data_root() / "protocol.json"))
        manifest = {"mocked": "generation-manifest"}
        candidate = {
            "engine": protocol["candidate"]["engine"],
            "artifacts": [],
            "artifact_footprint_bytes": protocol["candidate"]["artifact_footprint_bytes"],
            "downloaded_during_verification": False,
        }
        with (
            patch(f"{RUNNER_MODULE}.canonical_run_dir", return_value=self.run_dir),
            patch(f"{RUNNER_MODULE}.validate_seal", return_value={"sealed": True}),
            patch(
                f"{RUNNER_MODULE}.load_json",
                side_effect=[
                    {"corpus_sha256": "a" * 64},
                    protocol,
                    {"ocr_cases": []},
                    manifest,
                ],
            ),
            patch(f"{RUNNER_MODULE}.validate_protocol", side_effect=lambda value: value),
            patch(f"{RUNNER_MODULE}.verify_candidate_artifacts", return_value=candidate),
            patch(f"{RUNNER_MODULE}.require_canonical_renderer", return_value={"renderer": True}),
            patch(f"{RUNNER_MODULE}.generate_holdout_assets", return_value={"assets": []}),
            patch(f"{RUNNER_MODULE}._generation_manifest", return_value=manifest),
            patch(f"{PROVISION_MODULE}.importlib.metadata.version", side_effect=lambda package: versions[package]),
            patch(f"{CAPTURE_MODULE}.capture_engine") as real_capture,
            patch(f"{ENGINE_MODULE}._run_paddle") as real_ocr,
        ):
            yield real_capture, real_ocr

    def _assert_runtime_mismatch_is_preclaim(self, package: str, observed: str) -> None:
        versions = {"paddleocr": "3.7.0", "paddlepaddle": "3.3.0", "paddlex": "3.7.2"}
        versions[package] = observed
        with self._mocked_runtime_preflight(versions) as (real_capture, real_ocr):
            with patch(f"{RUNNER_MODULE}._capture") as capture:
                with self.assertRaisesRegex(ValueError, "Paddle runtime version mismatch"):
                    run_one_shot(self.models_dir)
        self.assertFalse(self.state.exists())
        capture.assert_not_called()
        real_capture.assert_not_called()
        real_ocr.assert_not_called()

    def test_canonical_execution_identity_is_repository_derived(self) -> None:
        self.assertEqual(tool_root() / "artifacts" / CANONICAL_RUN_DIRECTORY, canonical_run_dir())

    def _assert_existing_namespace_is_refused_before_claim(self) -> None:
        with (
            patch(f"{RUNNER_MODULE}.canonical_run_dir", return_value=self.run_dir),
            patch(f"{RUNNER_MODULE}._prepare_assets") as prepare,
            patch(f"{RUNNER_MODULE}._capture") as capture,
            patch(f"{CAPTURE_MODULE}.capture_engine") as real_capture,
            patch(f"{ENGINE_MODULE}._run_paddle") as real_ocr,
        ):
            with self.assertRaisesRegex(ValueError, "canonical one-shot run namespace already exists"):
                run_one_shot(self.models_dir)
        self.assertFalse(self.state.exists())
        prepare.assert_not_called()
        capture.assert_not_called()
        real_capture.assert_not_called()
        real_ocr.assert_not_called()

    def test_existing_empty_canonical_run_namespace_is_refused_before_claim(self) -> None:
        self.run_dir.mkdir()

        self._assert_existing_namespace_is_refused_before_claim()

    def test_existing_corpus_in_canonical_run_namespace_is_refused_before_claim(self) -> None:
        (self.run_dir / "corpus").mkdir(parents=True)

        self._assert_existing_namespace_is_refused_before_claim()

    def test_existing_rendered_output_in_canonical_run_namespace_is_refused_before_claim(self) -> None:
        rendered = self.run_dir / "rendered" / "dpi180-edge1920"
        rendered.mkdir(parents=True)
        (rendered / "ocr2h-001.png").write_bytes(b"stale rendered output")

        self._assert_existing_namespace_is_refused_before_claim()

    def test_failed_preflight_does_not_consume_the_run(self) -> None:
        with (
            patch(f"{RUNNER_MODULE}.canonical_run_dir", return_value=self.run_dir),
            patch(f"{RUNNER_MODULE}._prepare_assets", side_effect=ValueError("preflight failed")),
            patch(f"{RUNNER_MODULE}._capture") as capture,
        ):
            with self.assertRaisesRegex(ValueError, "preflight failed"):
                run_one_shot(self.models_dir)
        self.assertFalse(self.state.exists())
        capture.assert_not_called()

    def test_exact_frozen_runtime_preflight_passes_and_is_carried_forward(self) -> None:
        versions = {"paddleocr": "3.7.0", "paddlepaddle": "3.3.0", "paddlex": "3.7.2"}
        with self._mocked_runtime_preflight(versions):
            with patch(f"{RUNNER_MODULE}._capture", return_value={"mocked_capture": "completed"}) as capture:
                run_one_shot(self.models_dir)
        prepared = capture.call_args.args[0]
        self.assertEqual(versions, prepared["candidate"]["runtime"])
        self.assertEqual("completed", json.loads(self.state.read_text(encoding="utf-8"))["status"])

    def test_paddleocr_runtime_mismatch_fails_before_claim(self) -> None:
        self._assert_runtime_mismatch_is_preclaim("paddleocr", "3.7.1")

    def test_paddlepaddle_runtime_mismatch_fails_before_claim(self) -> None:
        self._assert_runtime_mismatch_is_preclaim("paddlepaddle", "3.3.1")

    def test_paddlex_runtime_mismatch_fails_before_claim(self) -> None:
        self._assert_runtime_mismatch_is_preclaim("paddlex", "3.7.3")

    def test_first_public_invocation_completes_and_repeat_is_refused(self) -> None:
        calls = []
        with (
            patch(f"{RUNNER_MODULE}.canonical_run_dir", return_value=self.run_dir),
            patch(f"{RUNNER_MODULE}._prepare_assets", return_value="prepared"),
            patch(
                f"{RUNNER_MODULE}._capture",
                side_effect=lambda prepared, _run_dir, _models_dir: calls.append(prepared)
                or {"mocked_capture": "completed"},
            ),
        ):
            result = run_one_shot(self.models_dir)
            with self.assertRaisesRegex(ValueError, "canonical one-shot run namespace already exists"):
                run_one_shot(self.models_dir)
        self.assertEqual({"mocked_capture": "completed"}, result)
        self.assertEqual(["prepared"], calls)
        self.assertEqual("completed", json.loads(self.state.read_text(encoding="utf-8"))["status"])

    def test_concurrent_public_invocations_allow_exactly_one_winner(self) -> None:
        barrier = threading.Barrier(2)

        def prepare(_prepared_dir: Path, _models_dir: Path) -> dict[str, object]:
            barrier.wait()
            return {"prepared": True}

        def invoke() -> str:
            try:
                run_one_shot(self.models_dir)
                return "completed"
            except ValueError:
                return "refused"

        with (
            patch(f"{RUNNER_MODULE}.canonical_run_dir", return_value=self.run_dir),
            patch(f"{RUNNER_MODULE}._prepare_assets", side_effect=prepare),
            patch(f"{RUNNER_MODULE}._capture", return_value={"mocked_capture": "completed"}),
        ):
            with ThreadPoolExecutor(max_workers=2) as executor:
                outcomes = sorted(executor.map(lambda _: invoke(), range(2)))
        self.assertEqual(["completed", "refused"], outcomes)

    def test_post_claim_failure_is_recorded_and_rerun_is_refused(self) -> None:
        with (
            patch(f"{RUNNER_MODULE}.canonical_run_dir", return_value=self.run_dir),
            patch(f"{RUNNER_MODULE}._prepare_assets", return_value={"prepared": True}),
            patch(f"{RUNNER_MODULE}._capture", side_effect=RuntimeError("mocked OCR boundary failed")),
        ):
            with self.assertRaisesRegex(RuntimeError, "mocked OCR boundary failed"):
                run_one_shot(self.models_dir)
            with self.assertRaisesRegex(ValueError, "canonical one-shot run namespace already exists"):
                run_one_shot(self.models_dir)
        stored = json.loads(self.state.read_text(encoding="utf-8"))
        self.assertEqual("failed", stored["status"])
        self.assertEqual(1, stored["ocr_run_count"])
        self.assertFalse(stored["rerun_permitted"])

    def test_candidate_provisioning_failure_cannot_reach_capture_or_claim(self) -> None:
        with (
            patch(f"{RUNNER_MODULE}.canonical_run_dir", return_value=self.run_dir),
            patch(
                f"{RUNNER_MODULE}._prepare_assets",
                side_effect=ValueError("frozen candidate model tree verification failed"),
            ),
            patch(f"{RUNNER_MODULE}._capture") as capture,
        ):
            with self.assertRaisesRegex(ValueError, "model tree verification failed"):
                run_one_shot(self.models_dir)
        self.assertFalse(self.state.exists())
        capture.assert_not_called()

    def test_alternate_run_directory_is_rejected_and_cannot_create_another_claim(self) -> None:
        alternate = Path(self.temporary.name) / "alternate-run"
        with (
            patch(f"{RUNNER_MODULE}.canonical_run_dir", return_value=self.run_dir),
            patch(f"{RUNNER_MODULE}._prepare_assets", return_value={"prepared": True}),
            patch(f"{RUNNER_MODULE}._capture", return_value={"mocked_capture": "completed"}),
        ):
            run_one_shot(self.models_dir)
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                _parser().parse_args(["run-one-shot", "--run-dir", str(alternate)])
        self.assertTrue(self.state.exists())
        self.assertFalse((alternate / "one-shot-state.json").exists())


class FiveGateDecisionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.protocol = validate_protocol(load_json(protocol_data_root() / "protocol.json"))
        cls.corpus = load_json(corpus_path())
        cls.cases = {case["id"]: case for case in cls.corpus["ocr_cases"] if case["split"] == "holdout"}

    def _provisioning(self) -> dict[str, object]:
        candidate = self.protocol["candidate"]
        footprint = candidate["artifact_footprint_bytes"]
        return {
            "engine": candidate["engine"],
            "artifacts": [
                {
                    "artifact": candidate["detection_artifact"],
                    "tree_sha256": candidate["detection_tree_sha256"],
                    "extracted_bytes": 1,
                },
                {
                    "artifact": candidate["recognition_artifact"],
                    "tree_sha256": candidate["recognition_tree_sha256"],
                    "extracted_bytes": footprint - 1,
                },
            ],
            "artifact_footprint_bytes": footprint,
            "downloaded_during_verification": False,
            "runtime": {
                "paddleocr": candidate["runtime"]["paddleocr"],
                "paddlepaddle": candidate["runtime"]["paddlepaddle_cpu"],
                "paddlex": candidate["runtime"]["paddlex_ocr_core"],
            },
        }

    @staticmethod
    def _blocks(case: dict[str, object]) -> list[dict[str, object]]:
        lines = reference_text(case).splitlines()
        title_index = len([item for item in case["distractors"] if item["position"] == "above"])
        blocks = []
        top = 0.0
        for index, line in enumerate(lines):
            height = 30.0 if index == title_index else 10.0
            blocks.append(
                {
                    "page_number": 1,
                    "text": line,
                    "box": {"left": 0.0, "top": top, "right": 100.0, "bottom": top + height},
                }
            )
            top += height + 20.0
        return blocks

    def _capture(self) -> dict[str, object]:
        candidate = self.protocol["candidate"]
        return {
            "schema_version": "pp1-ocr-iteration2-capture/v1",
            "engine": "paddle-small",
            "configuration_id": "dpi180-edge1920",
            "versions": {
                "paddleocr": candidate["runtime"]["paddleocr"],
                "paddlepaddle": candidate["runtime"]["paddlepaddle_cpu"],
                "paddlex": candidate["runtime"]["paddlex_ocr_core"],
                "detection": candidate["detection_model"],
                "recognition": candidate["recognition_model"],
            },
            "offline": {
                "enabled": True,
                "mechanism": OFFLINE_GUARD_MECHANISM,
                "self_test_passed": True,
            },
            "cold_start_ms": 1.0,
            "peak_working_set_bytes": 1,
            "artifact_footprint_bytes": self.protocol["candidate"]["artifact_footprint_bytes"],
            "failures": [],
            "records": [
                {
                    "case_id": case_id,
                    "runtime_ms": 1.0,
                    "blocks": self._blocks(case),
                }
                for case_id, case in sorted(self.cases.items())
            ],
        }

    def _score(
        self,
        capture: dict[str, object],
        provisioning: dict[str, object] | None = None,
    ) -> dict[str, object]:
        return score_holdout_capture(
            capture,
            corpus=self.corpus,
            protocol=self.protocol,
            provisioning=self._provisioning() if provisioning is None else provisioning,
        )

    def _title_block(self, record: dict[str, object]) -> dict[str, object]:
        case = self.cases[record["case_id"]]
        title_index = len([item for item in case["distractors"] if item["position"] == "above"])
        return record["blocks"][title_index]

    def test_all_five_gate_families_pass_before_ready(self) -> None:
        result = self._score(self._capture())
        self.assertEqual("READY_FOR_OCR_PROVIDER_INTEGRATION", result["decision"])
        self.assertEqual(
            {"quality", "title_safety", "operational", "provisioning", "offline_security"},
            set(result["gate_families"]),
        )
        self.assertTrue(all(family["passed"] for family in result["gate_families"].values()))
        provisioning = result["gate_families"]["provisioning"]
        self.assertTrue(provisioning["checks"]["preflight_runtime_versions"])
        self.assertTrue(provisioning["checks"]["capture_runtime_identity_fields"])

    def test_missing_preflight_runtime_evidence_defers(self) -> None:
        provisioning = self._provisioning()
        provisioning.pop("runtime")
        result = self._score(self._capture(), provisioning)
        self.assertFalse(result["gate_families"]["provisioning"]["checks"]["preflight_runtime_versions"])
        self.assertEqual("OCR_PROVIDER_DEFERRED", result["decision"])

    def test_wrong_preflight_runtime_evidence_defers(self) -> None:
        provisioning = self._provisioning()
        provisioning["runtime"]["paddleocr"] = "3.7.1"
        result = self._score(self._capture(), provisioning)
        self.assertFalse(result["gate_families"]["provisioning"]["checks"]["preflight_runtime_versions"])
        self.assertEqual("OCR_PROVIDER_DEFERRED", result["decision"])

    def test_capture_runtime_mismatch_defers_even_when_quality_passes(self) -> None:
        for package in ("paddleocr", "paddlepaddle", "paddlex"):
            with self.subTest(package=package):
                capture = self._capture()
                capture["versions"][package] = "wrong"
                result = self._score(capture)
                self.assertTrue(result["gate_families"]["quality"]["passed"])
                self.assertFalse(result["gate_families"]["provisioning"]["passed"])
                self.assertEqual("OCR_PROVIDER_DEFERRED", result["decision"])

    def test_capture_model_identity_mismatch_defers(self) -> None:
        for model in ("detection", "recognition"):
            with self.subTest(model=model):
                capture = self._capture()
                capture["versions"][model] = "wrong"
                result = self._score(capture)
                self.assertTrue(result["gate_families"]["quality"]["passed"])
                self.assertFalse(result["gate_families"]["provisioning"]["passed"])
                self.assertEqual("OCR_PROVIDER_DEFERRED", result["decision"])

    def test_exact_title_failure_defers(self) -> None:
        capture = self._capture()
        agreeing = [record for record in capture["records"] if self.cases[record["case_id"]]["expected_agreement"]]
        for record in agreeing[:3]:
            self._title_block(record)["text"] += " Incorrect"
        result = self._score(capture)
        self.assertFalse(result["gate_families"]["quality"]["checks"]["exact_title"])
        self.assertEqual("OCR_PROVIDER_DEFERRED", result["decision"])

    def test_primary_wer_failure_defers(self) -> None:
        capture = self._capture()
        for record in capture["records"]:
            last = record["blocks"][-1]["box"]["bottom"]
            record["blocks"].append(
                {
                    "page_number": 1,
                    "text": "incorrect " * 100,
                    "box": {"left": 0.0, "top": last + 20.0, "right": 100.0, "bottom": last + 30.0},
                }
            )
        result = self._score(capture)
        self.assertFalse(result["gate_families"]["quality"]["checks"]["primary_wer"])
        self.assertEqual("OCR_PROVIDER_DEFERRED", result["decision"])

    def test_material_false_automatic_agreement_defers(self) -> None:
        capture = self._capture()
        record = next(
            item for item in capture["records"] if not self.cases[item["case_id"]]["expected_agreement"]
        )
        self._title_block(record)["text"] = self.cases[record["case_id"]]["metadata_title"]
        result = self._score(capture)
        self.assertTrue(result["gate_families"]["quality"]["passed"])
        self.assertFalse(result["gate_families"]["title_safety"]["passed"])
        self.assertEqual("OCR_PROVIDER_DEFERRED", result["decision"])

    def test_historical_operational_prior_failure_defers(self) -> None:
        with patch(
            f"{RUNNER_MODULE}._merged_operational_evidence",
            return_value={"paddle-small": {"plausibly_inside_established_limits": False}},
        ):
            result = self._score(self._capture())
        self.assertFalse(result["gate_families"]["operational"]["passed"])
        self.assertEqual("OCR_PROVIDER_DEFERRED", result["decision"])

    def test_current_operational_measurement_failure_defers(self) -> None:
        capture = self._capture()
        capture["cold_start_ms"] = self.protocol["operational_gate"]["ceilings"]["cold_start_ms_maximum"] + 1
        result = self._score(capture)
        self.assertFalse(result["gate_families"]["operational"]["passed"])
        self.assertEqual("OCR_PROVIDER_DEFERRED", result["decision"])

    def test_invalid_provisioning_evidence_defers(self) -> None:
        provisioning = self._provisioning()
        provisioning["artifacts"][0]["tree_sha256"] = "0" * 64
        result = self._score(self._capture(), provisioning)
        self.assertFalse(result["gate_families"]["provisioning"]["passed"])
        self.assertEqual("OCR_PROVIDER_DEFERRED", result["decision"])

    def test_offline_enabled_false_defers(self) -> None:
        capture = self._capture()
        capture["offline"]["enabled"] = False
        result = self._score(capture)
        self.assertFalse(result["gate_families"]["offline_security"]["passed"])
        self.assertEqual("OCR_PROVIDER_DEFERRED", result["decision"])

    def test_offline_self_test_false_defers(self) -> None:
        capture = self._capture()
        capture["offline"]["self_test_passed"] = False
        result = self._score(capture)
        self.assertFalse(result["gate_families"]["offline_security"]["passed"])
        self.assertEqual("OCR_PROVIDER_DEFERRED", result["decision"])

    def test_missing_or_malformed_offline_evidence_defers(self) -> None:
        for label, evidence in (("missing", None), ("malformed", "not-an-offline-record"), ("wrong-mechanism", {})):
            with self.subTest(label=label):
                capture = self._capture()
                if label == "missing":
                    capture.pop("offline")
                elif label == "wrong-mechanism":
                    capture["offline"]["mechanism"] = "different"
                else:
                    capture["offline"] = evidence
                result = self._score(capture)
                self.assertFalse(result["gate_families"]["offline_security"]["passed"])
                self.assertEqual("OCR_PROVIDER_DEFERRED", result["decision"])


if __name__ == "__main__":
    unittest.main()
