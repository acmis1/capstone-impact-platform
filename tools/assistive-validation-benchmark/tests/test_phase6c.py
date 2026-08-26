from __future__ import annotations

import copy
import json
import unittest
from pathlib import Path

from assistive_validation_benchmark.phase6.corpus import load_phase6_manifest
from assistive_validation_benchmark.phase6.grammar import prepare_grammar_text, score_grammar_engine
from assistive_validation_benchmark.phase6.metrics import check_metric_group
from assistive_validation_benchmark.phase6c.corpus import (
    build_calibration_manifest,
    combined_calibration_cases,
    load_calibration_manifest,
    load_holdout_manifest,
)
from assistive_validation_benchmark.phase6c.evidence import (
    load_evidence,
    validate_calibration_evidence,
    validate_final_evidence,
)
from assistive_validation_benchmark.phase6c.freeze import (
    build_freeze_manifest,
    load_freeze_manifest,
    validate_freeze_manifest,
)
from assistive_validation_benchmark.phase6c.history import check_fresh_holdout_non_reuse
from assistive_validation_benchmark.phase6c.policy import (
    canonical_json_bytes,
    load_policy,
    validate_policy,
)
from assistive_validation_benchmark.phase6c.runner import derive_decisions

TOOL_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = TOOL_ROOT.parents[1]
CALIBRATION_PATH = TOOL_ROOT / "phase6c" / "corpus" / "calibration.json"
HOLDOUT_PATH = TOOL_ROOT / "phase6c" / "corpus" / "holdout.json"
POLICY_PATH = TOOL_ROOT / "phase6c" / "policy.json"
CALIBRATION_EVIDENCE_PATH = TOOL_ROOT / "phase6c" / "calibration-evidence.json"
FREEZE_MANIFEST_PATH = TOOL_ROOT / "phase6c" / "freeze-manifest.json"
FINAL_EVIDENCE_PATH = REPOSITORY_ROOT / "docs" / "assistive-validation" / "evidence" / "phase-6c-report.json"


def inputs() -> tuple[dict, list[dict], dict]:
    calibration = load_calibration_manifest(CALIBRATION_PATH)
    cases = combined_calibration_cases(TOOL_ROOT, calibration)
    return calibration, cases, load_policy(POLICY_PATH)


class Phase6CCalibrationTests(unittest.TestCase):
    def test_calibration_is_deterministic_and_complete(self) -> None:
        calibration, cases, _ = inputs()
        self.assertEqual(
            canonical_json_bytes(calibration),
            canonical_json_bytes(build_calibration_manifest(TOOL_ROOT)),
        )
        self.assertEqual(len(cases), 80)
        self.assertEqual(sum(case["intentionally_clean"] for case in cases), 40)
        self.assertEqual(sum(not case["intentionally_clean"] for case in cases), 40)

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
            "term": "ForbiddenHoldoutTerm",
            "provenance": "HOLDOUT",
            "source": "g6c-h001",
        })
        with self.assertRaisesRegex(ValueError, "forbidden provenance"):
            validate_policy(tampered, cases, REPOSITORY_ROOT)

    def test_generated_benchmark_file_cannot_supply_repository_provenance(self) -> None:
        _, cases, policy = inputs()
        tampered = copy.deepcopy(policy)
        tampered["vocabulary"]["approved_terms"].append({
            "term": "Valdiation",
            "provenance": "REPOSITORY",
            "source": "tools/assistive-validation-benchmark/phase6c/corpus/calibration.json",
        })
        with self.assertRaisesRegex(ValueError, "cannot bootstrap"):
            validate_policy(tampered, cases, REPOSITORY_ROOT)

    def test_rule_exclusion_is_bound_to_calibration_observation(self) -> None:
        calibration, cases, policy = inputs()
        report = load_evidence(CALIBRATION_EVIDENCE_PATH)
        validate_calibration_evidence(report, cases, calibration["corpus_version"], policy, REPOSITORY_ROOT)
        exclusion = policy["finding_policy"]["languagetool"]["excluded_rules"][0]
        self.assertEqual(exclusion["id"], "SINGULAR_NOUN_ADV_AGREEMENT")
        self.assertEqual(exclusion["observed_false_positives"], 1)
        self.assertEqual(exclusion["observed_true_positives"], 0)


class Phase6CGrammarContractTests(unittest.TestCase):
    def test_masking_preserves_offsets_for_every_non_prose_family(self) -> None:
        source = (
            "Run `npm test` at https://example.invalid then email audit@example.invalid about "
            "6f9619ff-8b86-4d11-842d-00cf4fc964ff and report.final.json."
        )
        prepared, spans = prepare_grammar_text(source)
        self.assertEqual(len(prepared), len(source))
        for token in ("npm", "https", "audit@", "6f9619ff", "report.final.json"):
            self.assertNotIn(token, prepared)
        self.assertEqual(len(spans), 5)

    def test_matcher_requires_span_and_accepted_correction(self) -> None:
        case = {
            "id": "unit", "split": "calibration", "field": "summary",
            "source_text": "The reviewer inspect each record.", "intentionally_clean": False,
            "legitimate_technical_terms": [],
            "issues": [{
                "start": 13, "end": 20, "source": "inspect",
                "category": "GRAMMAR_SUBJECT_VERB_AGREEMENT", "accepted_corrections": ["inspects"],
            }],
        }
        correct = {"start": 13, "end": 20, "kind": "Grammar", "replacements": ["inspects"]}
        wrong = {**correct, "replacements": ["inspected"]}
        self.assertEqual(score_grammar_engine([case], [[correct]], set())["raw"]["true_positives"], 1)
        self.assertEqual(score_grammar_engine([case], [[wrong]], set())["raw"]["true_positives"], 0)


class Phase6CEvidenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.calibration, self.cases, self.policy = inputs()
        self.report = load_evidence(CALIBRATION_EVIDENCE_PATH)

    def validate(self, report: dict) -> dict:
        return validate_calibration_evidence(
            report,
            self.cases,
            self.calibration["corpus_version"],
            self.policy,
            REPOSITORY_ROOT,
        )

    def test_calibration_evidence_is_valid_and_closed(self) -> None:
        self.assertIs(self.validate(self.report), self.report)
        tampered = copy.deepcopy(self.report)
        tampered["unexpected"] = True
        with self.assertRaisesRegex(ValueError, "schema is closed"):
            self.validate(tampered)

    def test_arithmetic_is_recomputed_from_per_case_counts(self) -> None:
        tampered = copy.deepcopy(self.report)
        metrics = tampered["engines"]["languagetool"]["evaluation"]["policy"]
        metrics["f1"] = 0.999
        with self.assertRaisesRegex(ValueError, "stored f1"):
            self.validate(tampered)
        check_metric_group("language/calibration", self.report["engines"]["languagetool"]["evaluation"]["policy"])

    def test_engine_version_and_required_execution_are_enforced(self) -> None:
        wrong_version = copy.deepcopy(self.report)
        wrong_version["engines"]["languagetool"]["version"] = "6.4"
        with self.assertRaisesRegex(ValueError, "executed frozen languagetool 6.6"):
            self.validate(wrong_version)
        not_executed = copy.deepcopy(self.report)
        not_executed["engines"]["harper"]["status"] = "failed"
        with self.assertRaisesRegex(ValueError, "executed frozen harper 2.7.0"):
            self.validate(not_executed)

    def test_candidate_configuration_is_enforced(self) -> None:
        tampered = copy.deepcopy(self.report)
        tampered["engines"]["harper"]["configuration"]["dialect"] = "American"
        with self.assertRaisesRegex(ValueError, "configuration differs"):
            self.validate(tampered)

    def test_decision_derivation_preserves_precision_and_recall_gates(self) -> None:
        engines = copy.deepcopy(self.report["engines"])
        engines["harper"]["evaluation"]["policy"]["recall"] = 0.10
        engines["languagetool"]["evaluation"]["policy"]["precision"] = 0.89
        decisions = derive_decisions(engines, self.policy)
        self.assertEqual(decisions["harper"]["decision"], "DEFER")
        self.assertEqual(decisions["languagetool"]["decision"], "DEFER")


class Phase6CFreezeAndHoldoutTests(unittest.TestCase):
    def test_freeze_manifest_recomputes_every_frozen_hash(self) -> None:
        freeze = load_freeze_manifest(FREEZE_MANIFEST_PATH, TOOL_ROOT)
        self.assertEqual(freeze, build_freeze_manifest(TOOL_ROOT))
        tampered = copy.deepcopy(freeze)
        tampered["entries"][0]["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "differs from the freeze manifest"):
            validate_freeze_manifest(tampered, TOOL_ROOT)

    def test_reuse_of_exposed_phase6a_holdout_is_rejected(self) -> None:
        _, calibration_cases, _ = inputs()
        phase6a = load_phase6_manifest(TOOL_ROOT / "phase6" / "corpus" / "manifest.json")
        exposed = next(case for case in phase6a["grammar_cases"] if case["split"] == "holdout")
        copied = copy.deepcopy(exposed)
        copied["id"] = "g6c-h999"
        with self.assertRaisesRegex(ValueError, "reuses prior exposed text"):
            check_fresh_holdout_non_reuse(TOOL_ROOT, calibration_cases, [copied])

    def test_final_holdout_and_evidence_when_present(self) -> None:
        if not HOLDOUT_PATH.is_file() or not FINAL_EVIDENCE_PATH.is_file():
            self.skipTest("fresh holdout intentionally does not exist at Commit A")
        calibration, calibration_cases, policy = inputs()
        holdout = load_holdout_manifest(HOLDOUT_PATH)
        report = load_evidence(FINAL_EVIDENCE_PATH)
        calibration_report = load_evidence(CALIBRATION_EVIDENCE_PATH)
        validate_final_evidence(
            report,
            holdout["cases"],
            holdout["corpus_version"],
            calibration_cases,
            calibration_report,
            tool_root=TOOL_ROOT,
            repository_root=REPOSITORY_ROOT,
            policy=policy,
        )
        self.assertEqual(check_fresh_holdout_non_reuse(TOOL_ROOT, calibration_cases, holdout["cases"])["prior_text_matches"], 0)
        self.assertEqual(set(report["decisions"]), {"harper", "languagetool"})


if __name__ == "__main__":
    unittest.main()
