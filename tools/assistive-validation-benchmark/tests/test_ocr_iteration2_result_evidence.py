from __future__ import annotations

import copy
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from assistive_validation_benchmark.ocr_iteration2_fresh_holdout.__main__ import _parser
from assistive_validation_benchmark.ocr_iteration2_fresh_holdout.result_evidence import (
    CAPTURE_FILENAME,
    EVIDENCE_SCHEMA,
    EXPECTED_CORPUS_SHA256,
    EXPECTED_RESULT_SHA256,
    MANIFEST_FILENAME,
    REPORT_FILENAME,
    STATE_FILENAME,
    build_result_evidence,
    evidence_dir,
    validate_result_evidence,
)
from assistive_validation_benchmark.ocr_iteration2_holdout_protocol.schema import (
    canonical_json_bytes,
    load_json,
)


RUNNER_MODULE = "assistive_validation_benchmark.ocr_iteration2_fresh_holdout.runner"
CAPTURE_MODULE = "assistive_validation_benchmark.ocr_iteration2_calibration.capture"
EVIDENCE_MODULE = "assistive_validation_benchmark.ocr_iteration2_fresh_holdout.result_evidence"


class ResultEvidenceTestCase(unittest.TestCase):
    """Base class giving each test a disposable copy of the tracked evidence."""

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="ocr2h-result-evidence-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name) / "evidence"
        shutil.copytree(evidence_dir(), self.directory)

    def rewrite(self, name: str, mutate) -> None:
        """Canonically rewrite one evidence file, then refresh its recorded size and hash."""
        path = self.directory / name
        value = load_json(path)
        mutate(value)
        path.write_bytes(canonical_json_bytes(value))
        manifest = load_json(self.directory / MANIFEST_FILENAME)
        if name in manifest["files"]:
            raw = path.read_bytes()
            import hashlib

            manifest["files"][name] = {"bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}
            (self.directory / MANIFEST_FILENAME).write_bytes(canonical_json_bytes(manifest))

    def rewrite_manifest(self, mutate) -> None:
        path = self.directory / MANIFEST_FILENAME
        value = load_json(path)
        mutate(value)
        path.write_bytes(canonical_json_bytes(value))

    def assertRejected(self, fragment: str) -> None:
        with self.assertRaises(ValueError) as caught:
            validate_result_evidence(self.directory)
        self.assertIn(fragment, str(caught.exception))

    def assertReportForgeryRejectedTwice(self, mutate) -> None:
        """A tampered report must fail the frozen hash *and* the independent re-score.

        The frozen ``EXPECTED_RESULT_SHA256`` catches an edited report immediately. The second
        pass then rebuilds a *wholly self-consistent* forgery — the manifest records, the
        manifest's canonical hash, the state's ``result_sha256`` and the frozen source constant
        all updated to the forged digest — and proves the independent re-score still rejects
        it. The recomputation is therefore a real second lock, not a restatement of the hashes.
        """
        self.rewrite(REPORT_FILENAME, mutate)
        forged = load_json(self.directory / MANIFEST_FILENAME)["files"][REPORT_FILENAME]["sha256"]
        self.assertNotEqual(forged, EXPECTED_RESULT_SHA256)
        self.assertRejected("tracked report canonical hash changed")

        self.rewrite_manifest(lambda value: value.__setitem__("canonical_report_sha256", forged))
        self.rewrite(STATE_FILENAME, lambda value: value.__setitem__("result_sha256", forged))
        with patch(f"{EVIDENCE_MODULE}.EXPECTED_RESULT_SHA256", forged):
            with self.assertRaises(ValueError) as caught:
                validate_result_evidence(self.directory)
        self.assertIn("does not reproduce the tracked report", str(caught.exception))


class ValidResultEvidenceTests(ResultEvidenceTestCase):
    def test_tracked_evidence_validates(self) -> None:
        result = validate_result_evidence(self.directory)
        self.assertEqual(result["final_decision"], "OCR_PROVIDER_DEFERRED")
        self.assertEqual(result["schema_version"], EVIDENCE_SCHEMA)
        self.assertEqual(result["scored_case_count"], 40)
        self.assertEqual(result["failed_case_count"], 0)
        self.assertEqual(result["title_exact_count"], 38)
        self.assertEqual(result["title_exact_rate"], 0.95)
        self.assertEqual(result["material_false_automatic_agreements"], 0)
        self.assertEqual(result["primary_wer"]["word_edits"], 364)
        self.assertEqual(result["primary_wer"]["reference_words"], 2296)
        self.assertEqual(result["canonical_report_sha256"], EXPECTED_RESULT_SHA256)
        self.assertEqual(result["corpus_sha256"], EXPECTED_CORPUS_SHA256)
        self.assertIs(result["ocr_executed_by_this_check"], False)
        self.assertIs(result["recomputed_from_tracked_capture"], True)
        self.assertEqual(result["ocr_run_count"], 1)
        self.assertIs(result["rerun_permitted"], False)

    def test_default_tracked_location_validates(self) -> None:
        self.assertEqual(validate_result_evidence()["final_decision"], "OCR_PROVIDER_DEFERRED")

    def test_exactly_five_gate_families_with_only_quality_failing(self) -> None:
        families = validate_result_evidence(self.directory)["gate_families"]
        self.assertEqual(
            families,
            {
                "quality": False,
                "title_safety": True,
                "operational": True,
                "provisioning": True,
                "offline_security": True,
            },
        )

    def test_quality_fails_only_on_the_primary_wer_sub_gate(self) -> None:
        checks = validate_result_evidence(self.directory)["quality_checks"]
        self.assertEqual(
            checks,
            {"all_scored_cases_executed": True, "exact_title": True, "primary_wer": False},
        )

    def test_manifest_rebuilds_identically_from_the_same_bytes(self) -> None:
        rebuilt = build_result_evidence(self.directory)
        self.assertEqual(rebuilt, load_json(self.directory / MANIFEST_FILENAME))

    def test_tracked_files_are_canonical_json(self) -> None:
        for name in (STATE_FILENAME, CAPTURE_FILENAME, REPORT_FILENAME):
            path = self.directory / name
            self.assertEqual(canonical_json_bytes(load_json(path)), path.read_bytes(), name)


class NoOcrDuringResultValidationTests(ResultEvidenceTestCase):
    def test_validation_never_invokes_any_ocr_or_capture_entry_point(self) -> None:
        with (
            patch(f"{RUNNER_MODULE}.run_one_shot") as run_one_shot,
            patch(f"{RUNNER_MODULE}._capture") as capture,
            patch(f"{RUNNER_MODULE}._prepare_assets") as prepare,
            patch(f"{RUNNER_MODULE}.execute_once") as execute,
            patch(f"{RUNNER_MODULE}.atomic_claim_run_state") as claim,
            patch(f"{CAPTURE_MODULE}.capture_engine") as capture_engine,
        ):
            validate_result_evidence(self.directory)
        for mock in (run_one_shot, capture, prepare, execute, claim, capture_engine):
            mock.assert_not_called()

    def test_validation_imports_no_ocr_provider(self) -> None:
        import builtins

        forbidden = {"paddleocr", "paddle", "paddlex", "pytesseract"}
        attempted: list[str] = []
        real_import = builtins.__import__

        def guarded(name, *args, **kwargs):
            if name.split(".")[0] in forbidden:
                attempted.append(name)
                raise AssertionError(f"forbidden OCR import: {name}")
            return real_import(name, *args, **kwargs)

        with patch.object(builtins, "__import__", guarded):
            validate_result_evidence(self.directory)
        self.assertEqual(attempted, [])

    def test_validation_does_not_read_the_ignored_run_directory(self) -> None:
        from assistive_validation_benchmark.ocr_iteration2_fresh_holdout import runner

        with patch.object(runner, "canonical_run_dir") as canonical:
            validate_result_evidence(self.directory)
        canonical.assert_not_called()


class TamperedEvidenceTests(ResultEvidenceTestCase):
    def test_state_hash_tampering_is_rejected(self) -> None:
        path = self.directory / STATE_FILENAME
        value = load_json(path)
        value["status"] = "running"
        path.write_bytes(canonical_json_bytes(value))
        self.assertRejected("tracked state evidence")

    def test_capture_tampering_is_rejected(self) -> None:
        path = self.directory / CAPTURE_FILENAME
        value = load_json(path)
        value["records"][0]["blocks"][0]["text"] = "tampered"
        path.write_bytes(canonical_json_bytes(value))
        self.assertRejected("tracked capture evidence")

    def test_report_tampering_is_rejected(self) -> None:
        path = self.directory / REPORT_FILENAME
        value = load_json(path)
        value["title_exact_count"] = 40
        path.write_bytes(canonical_json_bytes(value))
        self.assertRejected("tracked report evidence")

    def test_recorded_size_tampering_is_rejected(self) -> None:
        self.rewrite_manifest(lambda value: value["files"][REPORT_FILENAME].__setitem__("bytes", 1))
        self.assertRejected("size changed")

    def test_non_canonical_json_is_rejected(self) -> None:
        path = self.directory / REPORT_FILENAME
        pretty = json.dumps(load_json(path), indent=2, sort_keys=True).encode("utf-8")
        path.write_bytes(pretty)
        import hashlib

        self.rewrite_manifest(
            lambda value: value["files"].__setitem__(
                REPORT_FILENAME,
                {"bytes": len(pretty), "sha256": hashlib.sha256(pretty).hexdigest()},
            )
        )
        self.assertRejected("not canonical JSON")

    def test_missing_evidence_file_is_rejected(self) -> None:
        (self.directory / CAPTURE_FILENAME).unlink()
        self.assertRejected("is missing")


class BindingTests(ResultEvidenceTestCase):
    def test_state_report_hash_mismatch_is_rejected(self) -> None:
        self.rewrite(STATE_FILENAME, lambda value: value.__setitem__("result_sha256", "0" * 64))
        self.assertRejected("result hash does not bind")

    def test_manifest_canonical_report_hash_mismatch_is_rejected(self) -> None:
        self.rewrite_manifest(lambda value: value.__setitem__("canonical_report_sha256", "0" * 64))
        self.assertRejected("canonical report hash changed")

    def test_pre_run_seal_binding_change_is_rejected(self) -> None:
        self.rewrite_manifest(lambda value: value.__setitem__("pre_run_seal_sha256", "0" * 64))
        self.assertRejected("pre-run-seal binding changed")

    def test_execution_commit_change_is_rejected(self) -> None:
        self.rewrite_manifest(lambda value: value.__setitem__("execution_commit_sha", "0" * 40))
        self.assertRejected("execution commit changed")

    def test_corpus_binding_change_is_rejected(self) -> None:
        self.rewrite_manifest(lambda value: value.__setitem__("corpus_sha256", "0" * 64))
        self.assertRejected("corpus binding changed")

    def test_rerun_permission_change_is_rejected(self) -> None:
        self.rewrite(STATE_FILENAME, lambda value: value.__setitem__("rerun_permitted", True))
        self.assertRejected("permits a rerun")

    def test_second_run_count_is_rejected(self) -> None:
        self.rewrite(STATE_FILENAME, lambda value: value.__setitem__("ocr_run_count", 2))
        self.assertRejected("run count is not exactly one")


class CaseIdentityTests(ResultEvidenceTestCase):
    def test_case_identity_mismatch_is_rejected(self) -> None:
        self.rewrite(
            CAPTURE_FILENAME,
            lambda value: value["records"][0].__setitem__("case_id", "ocr2h-999"),
        )
        self.assertRejected("case identities differ")

    def test_dropped_case_is_rejected(self) -> None:
        self.rewrite(CAPTURE_FILENAME, lambda value: value["records"].pop())
        self.assertRejected("case identities differ")

    def test_duplicated_case_is_rejected(self) -> None:
        def duplicate(value: dict) -> None:
            value["records"][1] = copy.deepcopy(value["records"][0])

        self.rewrite(CAPTURE_FILENAME, duplicate)
        self.assertRejected("case identities differ")


class RecomputationTests(ResultEvidenceTestCase):
    def test_arithmetic_mismatch_between_capture_and_report_is_rejected(self) -> None:
        """A capture edited to change the score no longer reproduces the stored report."""
        self.rewrite(
            CAPTURE_FILENAME,
            lambda value: value["records"][0]["blocks"].__setitem__(
                0, {**value["records"][0]["blocks"][0], "text": "Entirely Different Heading"}
            ),
        )
        self.assertRejected("does not reproduce the tracked report")

    def test_report_arithmetic_edited_with_matching_hashes_is_rejected(self) -> None:
        self.assertReportForgeryRejectedTwice(lambda value: value.__setitem__("title_exact_count", 40))

    def test_primary_wer_edit_is_rejected(self) -> None:
        self.assertReportForgeryRejectedTwice(
            lambda value: value["word_error_rate"]["column"].__setitem__("word_edits", 100)
        )


class GateFamilyAndDecisionTests(ResultEvidenceTestCase):
    def test_missing_gate_family_is_rejected(self) -> None:
        self.assertReportForgeryRejectedTwice(lambda value: value["gate_families"].pop("offline_security"))

    def test_extra_gate_family_is_rejected(self) -> None:
        self.assertReportForgeryRejectedTwice(
            lambda value: value["gate_families"].__setitem__("extra_family", {"passed": True, "checks": {}})
        )

    def test_decision_changed_to_ready_is_rejected(self) -> None:
        self.assertReportForgeryRejectedTwice(
            lambda value: value.__setitem__("decision", "READY_FOR_OCR_PROVIDER_INTEGRATION")
        )

    def test_manifest_decision_changed_to_ready_is_rejected(self) -> None:
        self.rewrite_manifest(
            lambda value: value.__setitem__("final_decision", "READY_FOR_OCR_PROVIDER_INTEGRATION")
        )
        self.assertRejected("final decision changed")

    def test_quality_gate_flipped_to_passing_is_rejected(self) -> None:
        def pass_quality(value: dict) -> None:
            value["gate_families"]["quality"]["passed"] = True
            value["gate_families"]["quality"]["checks"]["primary_wer"] = True

        self.assertReportForgeryRejectedTwice(pass_quality)

    def test_decision_and_gates_flipped_together_is_still_rejected(self) -> None:
        """Even a wholly self-consistent forgery cannot survive the independent re-score."""

        def forge(value: dict) -> None:
            value["gate_families"]["quality"]["passed"] = True
            value["gate_families"]["quality"]["checks"]["primary_wer"] = True
            value["quality_checks"]["primary_wer"] = True
            value["decision"] = "READY_FOR_OCR_PROVIDER_INTEGRATION"

        self.assertReportForgeryRejectedTwice(forge)


class ResultEvidenceCommandTests(unittest.TestCase):
    def test_check_result_evidence_command_is_registered(self) -> None:
        args = _parser().parse_args(["check-result-evidence"])
        self.assertEqual(args.command, "check-result-evidence")
        self.assertEqual(args.evidence_dir, evidence_dir())

    def test_build_result_evidence_command_is_registered(self) -> None:
        args = _parser().parse_args(["build-result-evidence"])
        self.assertEqual(args.command, "build-result-evidence")
        self.assertEqual(args.output, evidence_dir() / MANIFEST_FILENAME)


if __name__ == "__main__":
    unittest.main()
