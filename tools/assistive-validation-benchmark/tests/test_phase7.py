from __future__ import annotations

import copy
import json
import tempfile
import unittest
from pathlib import Path

from assistive_validation_benchmark.phase6.corpus import load_phase6_manifest
from assistive_validation_benchmark.phase6.metrics import check_metric_group
from assistive_validation_benchmark.phase7.corpus import (
    REQUIRED_ERROR_CATEGORIES,
    build_calibration_manifest,
    build_holdout_manifest,
    combined_calibration_cases,
    load_calibration_manifest,
    load_holdout_manifest,
)
from assistive_validation_benchmark.phase7.evidence import load_evidence, validate_calibration_evidence, validate_final_evidence
from assistive_validation_benchmark.phase7.freeze import build_freeze_manifest, load_freeze_manifest, validate_freeze_manifest
from assistive_validation_benchmark.phase7.grammar import prepare_grammar_text, utf16_length, utf16_offset_to_codepoint
from assistive_validation_benchmark.phase7.history import check_calibration_non_reuse, check_fresh_holdout_non_reuse
from assistive_validation_benchmark.phase7.policy import (
    apply_finding_policy,
    canonical_json_bytes,
    load_policy,
    validate_policy,
    value_sha256,
)
from assistive_validation_benchmark.phase7.runner import (
    claim_one_shot_output,
    complete_one_shot_output,
    derive_decisions,
    seal_one_shot_state,
    validate_completed_one_shot_state,
)

TOOL_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = TOOL_ROOT.parents[1]
CALIBRATION_PATH = TOOL_ROOT / "phase7" / "corpus" / "calibration.json"
HOLDOUT_PATH = TOOL_ROOT / "phase7" / "corpus" / "holdout.json"
POLICY_PATH = TOOL_ROOT / "phase7" / "policy.json"
CALIBRATION_EVIDENCE_PATH = TOOL_ROOT / "phase7" / "calibration-evidence.json"
FREEZE_MANIFEST_PATH = TOOL_ROOT / "phase7" / "freeze-manifest.json"
FREEZE_RECORD_PATH = TOOL_ROOT / "phase7" / "freeze-record.json"
ONE_SHOT_STATE_PATH = TOOL_ROOT / "phase7" / "one-shot-state.json"
FINAL_EVIDENCE_PATH = REPOSITORY_ROOT / "docs" / "assistive-validation" / "evidence" / "phase-7-report.json"


def inputs() -> tuple[dict, list[dict], dict]:
    calibration = load_calibration_manifest(CALIBRATION_PATH)
    cases = combined_calibration_cases(TOOL_ROOT, calibration)
    return calibration, cases, load_policy(POLICY_PATH)


class Phase7CalibrationTests(unittest.TestCase):
    def test_calibration_is_deterministic_balanced_and_complete(self) -> None:
        calibration, cases, _ = inputs()
        self.assertEqual(canonical_json_bytes(calibration), canonical_json_bytes(build_calibration_manifest(TOOL_ROOT)))
        self.assertEqual((len(cases), sum(case["intentionally_clean"] for case in cases)), (120, 60))
        self.assertEqual({case["field"] for case in cases}, {"title", "summary", "background", "solution"})
        self.assertEqual({issue["category"] for case in cases for issue in case["issues"]}, REQUIRED_ERROR_CATEGORIES)
        self.assertTrue(any(len(case["issues"]) > 1 for case in cases))
        for partition in calibration["partitions"]:
            partition_cases = [case for case in cases if case["partition"] == partition]
            self.assertEqual((len(partition_cases), sum(case["intentionally_clean"] for case in partition_cases)), (40, 20))

    def test_calibration_reuses_no_exposed_language_text(self) -> None:
        _, cases, _ = inputs()
        result = check_calibration_non_reuse(TOOL_ROOT, cases)
        self.assertEqual(result["prior_text_matches"], 0)
        self.assertEqual(result["prior_source_counts"]["phase6c_holdout"], 40)

    def test_vocabulary_provenance_is_repository_or_calibration_only(self) -> None:
        _, cases, policy = inputs()
        summary = validate_policy(policy, cases, REPOSITORY_ROOT)
        self.assertEqual(summary["holdout_sourced_terms"], 0)
        self.assertEqual(set(summary["provenance_counts"]), {"REPOSITORY", "CALIBRATION"})
        self.assertEqual(sum(summary["provenance_counts"].values()), summary["approved_term_count"])

    def test_holdout_provenance_is_rejected_structurally(self) -> None:
        _, cases, policy = inputs()
        tampered = copy.deepcopy(policy)
        tampered["vocabulary"]["approved_terms"].append({
            "term": "ForbiddenHoldoutTerm", "provenance": "HOLDOUT", "source": "lfh-001",
        })
        with self.assertRaisesRegex(ValueError, "forbidden provenance"):
            validate_policy(tampered, cases, REPOSITORY_ROOT)

    def test_generated_benchmark_file_cannot_supply_repository_provenance(self) -> None:
        _, cases, policy = inputs()
        tampered = copy.deepcopy(policy)
        tampered["vocabulary"]["approved_terms"].append({
            "term": "Valdiation", "provenance": "REPOSITORY",
            "source": "tools/assistive-validation-benchmark/phase7/corpus/calibration.json",
        })
        with self.assertRaisesRegex(ValueError, "cannot bootstrap"):
            validate_policy(tampered, cases, REPOSITORY_ROOT)

    def test_unique_trusted_near_miss_gets_only_the_trusted_replacement(self) -> None:
        _, _, policy = inputs()
        case = {"field": "title", "source_text": "Supabse Review", "issues": []}
        finding = {
            "start": 0, "end": 7, "kind": "", "rule": "MORFOLOGIK_RULE_EN_AU",
            "category": "TYPOS", "message": "spelling", "replacements": ["Sparse", "Suppose"],
        }
        retained, filtered = apply_finding_policy(case, [finding], policy, "languagetool")
        self.assertEqual((retained[0]["replacements"], filtered), (["Supabase"], []))


class Phase7GrammarContractTests(unittest.TestCase):
    def test_masking_preserves_offsets_for_every_non_prose_family(self) -> None:
        source = (
            "Run `npm test` at https://example.invalid then email audit@example.invalid about "
            "6f9619ff-8b86-4d11-842d-00cf4fc964ff, sha256:4f6b7c8d9e0f11223344556677889900, "
            "src/worker.ts, public.projects, v2.14.3, and projectMetadataHash."
        )
        prepared, spans = prepare_grammar_text(source)
        self.assertEqual(utf16_length(prepared), utf16_length(source))
        for token in ("npm", "https", "audit@", "6f9619ff", "sha256", "src/", "public.projects", "v2.14.3", "projectMetadataHash"):
            self.assertNotIn(token, prepared)
        self.assertGreaterEqual(len(spans), 9)

    def test_utf16_provider_offsets_convert_to_canonical_code_points(self) -> None:
        source = "😀 café detecctor"
        start = utf16_length("😀 café ")
        end = start + utf16_length("detecctor")
        self.assertEqual(source[utf16_offset_to_codepoint(source, start):utf16_offset_to_codepoint(source, end)], "detecctor")
        with self.assertRaisesRegex(ValueError, "surrogate pair"):
            utf16_offset_to_codepoint(source, 1)


class Phase7EvidenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.calibration, self.cases, self.policy = inputs()
        self.report = load_evidence(CALIBRATION_EVIDENCE_PATH)

    def validate(self, report: dict) -> dict:
        return validate_calibration_evidence(report, self.cases, self.calibration["corpus_version"], self.policy, REPOSITORY_ROOT)

    def test_calibration_evidence_is_valid_closed_and_recomputed(self) -> None:
        self.assertIs(self.validate(self.report), self.report)
        tampered = copy.deepcopy(self.report)
        tampered["unexpected"] = True
        with self.assertRaisesRegex(ValueError, "schema is closed"):
            self.validate(tampered)
        tampered = copy.deepcopy(self.report)
        tampered["engines"]["languagetool"]["evaluation"]["policy"]["f1"] = 0.999
        with self.assertRaisesRegex(ValueError, "stored f1"):
            self.validate(tampered)

    def test_selected_candidate_meets_overall_and_partition_margins(self) -> None:
        gates = self.policy["calibration_gates"]
        evaluation = self.report["engines"][gates["candidate"]]["evaluation"]
        check_metric_group("language/calibration", evaluation["policy"])
        self.assertGreaterEqual(evaluation["policy"]["precision"], gates["overall_precision"])
        self.assertGreaterEqual(evaluation["policy"]["recall"], gates["overall_recall"])
        for metrics in evaluation["breakdowns"]["partitions"].values():
            self.assertGreaterEqual(metrics["precision"], gates["partition_precision"])
            self.assertGreaterEqual(metrics["recall"], gates["partition_recall"])

    def test_candidate_versions_and_configuration_are_enforced(self) -> None:
        wrong = copy.deepcopy(self.report)
        wrong["engines"]["languagetool"]["version"] = "6.4"
        with self.assertRaisesRegex(ValueError, "executed frozen languagetool 6.6"):
            self.validate(wrong)
        wrong = copy.deepcopy(self.report)
        wrong["engines"]["harper"]["configuration"]["dialect"] = "American"
        with self.assertRaisesRegex(ValueError, "configuration differs"):
            self.validate(wrong)

    def test_final_decision_derivation_preserves_gates(self) -> None:
        engines = copy.deepcopy(self.report["engines"])
        engines["harper"]["evaluation"]["policy"]["recall"] = 0.10
        engines["languagetool"]["evaluation"]["policy"]["precision"] = 0.89
        decisions = derive_decisions(engines, self.policy)
        self.assertEqual(decisions["harper"]["decision"], "LANGUAGE_PROVIDER_DEFERRED")
        self.assertEqual(decisions["languagetool"]["decision"], "LANGUAGE_PROVIDER_DEFERRED")


class Phase7FreezeAndHoldoutTests(unittest.TestCase):
    def test_freeze_manifest_recomputes_every_frozen_hash_when_present(self) -> None:
        if not FREEZE_MANIFEST_PATH.is_file():
            self.skipTest("freeze manifest is created only after calibration completes")
        freeze = load_freeze_manifest(FREEZE_MANIFEST_PATH, TOOL_ROOT)
        self.assertEqual(freeze, build_freeze_manifest(TOOL_ROOT))
        tampered = copy.deepcopy(freeze)
        tampered["entries"][0]["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "differs from the freeze manifest"):
            validate_freeze_manifest(tampered, TOOL_ROOT)

    def test_seeded_generator_is_balanced_deterministic_and_non_reusing(self) -> None:
        _, calibration_cases, _ = inputs()
        first = build_holdout_manifest("0" * 32)
        second = build_holdout_manifest("0" * 32)
        self.assertEqual(canonical_json_bytes(first), canonical_json_bytes(second))
        self.assertEqual((len(first["cases"]), sum(case["intentionally_clean"] for case in first["cases"])), (96, 48))
        self.assertEqual(check_fresh_holdout_non_reuse(TOOL_ROOT, calibration_cases, first["cases"])["prior_text_matches"], 0)

    def test_reuse_of_exposed_phase6a_or_phase6c_text_is_rejected(self) -> None:
        _, calibration_cases, _ = inputs()
        phase6a = load_phase6_manifest(TOOL_ROOT / "phase6" / "corpus" / "manifest.json")
        copied = copy.deepcopy(phase6a["grammar_cases"][0])
        copied["id"] = "lfh-999"
        with self.assertRaisesRegex(ValueError, "reuses prior exposed text"):
            check_fresh_holdout_non_reuse(TOOL_ROOT, calibration_cases, [copied])
        phase6c = json.loads((TOOL_ROOT / "phase6c" / "corpus" / "holdout.json").read_text(encoding="utf-8"))
        copied = copy.deepcopy(phase6c["cases"][0])
        copied["id"] = "lfh-998"
        with self.assertRaisesRegex(ValueError, "reuses prior exposed text"):
            check_fresh_holdout_non_reuse(TOOL_ROOT, calibration_cases, [copied])

    def test_seal_claim_and_completion_are_one_shot(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            holdout, evidence, state = root / "holdout.json", root / "evidence.json", root / "state.json"
            holdout.write_text("{}\n", encoding="utf-8")
            evidence.write_text("{\"result\":true}\n", encoding="utf-8")
            policy_sha, freeze_sha = "a" * 64, "b" * 40
            seal_one_shot_state(state, holdout, policy_sha, freeze_sha)
            sealed = json.loads(state.read_text(encoding="utf-8"))
            self.assertEqual((sealed["status"], sealed["run_count"]), ("SEALED_UNCONSUMED", 0))
            claim_one_shot_output(state, holdout, policy_sha, freeze_sha)
            with self.assertRaisesRegex(ValueError, "not sealed and unconsumed"):
                claim_one_shot_output(state, holdout, policy_sha, freeze_sha)
            complete_one_shot_output(state, evidence)
            completed = validate_completed_one_shot_state(state, holdout, evidence, policy_sha, freeze_sha)
            self.assertEqual((completed["status"], completed["run_count"]), ("COMPLETED", 1))

    def test_final_holdout_and_evidence_when_present(self) -> None:
        if not HOLDOUT_PATH.is_file() or not FINAL_EVIDENCE_PATH.is_file():
            self.skipTest("fresh holdout intentionally does not exist at the policy freeze")
        calibration, calibration_cases, policy = inputs()
        holdout = load_holdout_manifest(HOLDOUT_PATH)
        report = load_evidence(FINAL_EVIDENCE_PATH)
        calibration_report = load_evidence(CALIBRATION_EVIDENCE_PATH)
        validate_final_evidence(
            report, holdout["cases"], holdout["corpus_version"], calibration_cases, calibration_report,
            tool_root=TOOL_ROOT, repository_root=REPOSITORY_ROOT, policy=policy,
        )
        freeze_sha = json.loads(FREEZE_RECORD_PATH.read_text(encoding="utf-8"))["policy_freeze_commit_sha"]
        validate_completed_one_shot_state(ONE_SHOT_STATE_PATH, HOLDOUT_PATH, FINAL_EVIDENCE_PATH, value_sha256(policy), freeze_sha)


if __name__ == "__main__":
    unittest.main()
