from __future__ import annotations

import copy
import json
import unittest
from pathlib import Path

from assistive_validation_benchmark.phase6.corpus import (
    PHASE6_SEED,
    build_phase6_manifest,
    canonical_json_bytes,
    load_phase6_manifest,
    manifest_sha256,
    validate_phase6_manifest,
)
from assistive_validation_benchmark.phase6.duplicates import rank_phase6_query
from assistive_validation_benchmark.phase6.grammar import (
    apply_vocabulary_policy,
    prepare_grammar_text,
    score_grammar_engine,
)
from assistive_validation_benchmark.phase6.history import (
    check_holdout_independence,
    holdout_text_digest,
    load_benchmark_history,
    load_exposed_holdout_texts,
    load_policy_freeze,
)
from assistive_validation_benchmark.phase6.metrics import (
    check_metric_group,
    check_report_metrics,
    recompute_metrics,
)
from assistive_validation_benchmark.phase6.provenance import (
    approved_terms,
    validate_vocabulary_policy,
)
from assistive_validation_benchmark.phase6.runner import (
    EXPECTED_ENGINE_VERSIONS,
    compact_phase6_evidence,
    validate_phase6_evidence,
)

TOOL_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = TOOL_ROOT.parents[1]
MANIFEST_PATH = TOOL_ROOT / "phase6" / "corpus" / "manifest.json"
HASH_PATH = TOOL_ROOT / "phase6" / "corpus" / "manifest.sha256"
POLICY_PATH = TOOL_ROOT / "phase6" / "grammar" / "vocabulary-policy.json"
EVIDENCE_DIR = REPOSITORY_ROOT / "docs" / "assistive-validation" / "evidence"
EVIDENCE_PATH = EVIDENCE_DIR / "phase-6a-report.json"


def _load_policy() -> dict:
    return json.loads(POLICY_PATH.read_text(encoding="utf-8"))


class Phase6CorpusTests(unittest.TestCase):
    def test_committed_manifest_is_deterministic_and_hash_locked(self) -> None:
        committed = load_phase6_manifest(MANIFEST_PATH)
        generated = validate_phase6_manifest(build_phase6_manifest(PHASE6_SEED))
        self.assertEqual(canonical_json_bytes(committed), canonical_json_bytes(generated))
        self.assertEqual(manifest_sha256(committed), HASH_PATH.read_text(encoding="utf-8").strip())

    def test_split_and_relationship_contract(self) -> None:
        manifest = load_phase6_manifest(MANIFEST_PATH)
        for split in ("calibration", "holdout"):
            grammar = [case for case in manifest["grammar_cases"] if case["split"] == split]
            queries = [query for query in manifest["duplicate_queries"] if query["split"] == split]
            self.assertEqual(len(grammar), 40)
            self.assertEqual(sum(case["intentionally_clean"] for case in grammar), 20)
            self.assertEqual(len(queries), 20)
            duplicate_types = {
                relationship
                for query in queries
                for relationship in query["relationships"].values()
                if relationship in {"EXACT_DUPLICATE", "NEAR_DUPLICATE"}
            }
            self.assertEqual(duplicate_types, {"EXACT_DUPLICATE", "NEAR_DUPLICATE"})
        self.assertEqual(len(manifest["duplicate_candidates"]), 120)

    def test_every_issue_has_exact_source_span_and_corrections(self) -> None:
        manifest = load_phase6_manifest(MANIFEST_PATH)
        for case in manifest["grammar_cases"]:
            for issue in case["issues"]:
                self.assertEqual(case["source_text"][issue["start"]:issue["end"]], issue["source"])
                self.assertTrue(issue["accepted_corrections"])

    def test_manifest_rejects_missing_relationship_label(self) -> None:
        manifest = build_phase6_manifest()
        manifest["duplicate_queries"][0]["relationships"].pop(next(iter(manifest["duplicate_queries"][0]["relationships"])))
        with self.assertRaisesRegex(ValueError, "label every candidate"):
            validate_phase6_manifest(manifest)


class Phase6HoldoutIndependenceTests(unittest.TestCase):
    def test_holdout_reuses_no_superseded_text(self) -> None:
        manifest = load_phase6_manifest(MANIFEST_PATH)
        summary = check_holdout_independence(manifest, load_exposed_holdout_texts(TOOL_ROOT))
        self.assertEqual(summary["reused_texts"], 0)
        self.assertEqual(summary["holdout_cases"], 40)

    def test_reused_holdout_text_is_rejected(self) -> None:
        manifest = load_phase6_manifest(MANIFEST_PATH)
        holdout = next(case for case in manifest["grammar_cases"] if case["split"] == "holdout")
        # Attributed to a different iteration, so it counts as prior exposure.
        exposed = {holdout_text_digest(holdout["source_text"]): ["pp1-assistive-phase6a-v2:g6-041"]}
        with self.assertRaisesRegex(ValueError, "reuses superseded holdout text"):
            check_holdout_independence(manifest, exposed)

    def test_reuse_detection_ignores_whitespace_and_case(self) -> None:
        manifest = load_phase6_manifest(MANIFEST_PATH)
        holdout = next(case for case in manifest["grammar_cases"] if case["split"] == "holdout")
        disguised = f"  {holdout['source_text'].upper()}  "
        self.assertEqual(holdout_text_digest(disguised), holdout_text_digest(holdout["source_text"]))

    def test_history_preserves_every_superseded_attempt(self) -> None:
        history = load_benchmark_history(TOOL_ROOT)
        versions = [entry["corpus_version"] for entry in history["superseded"]]
        self.assertIn("pp1-assistive-phase6a-v1", versions)
        self.assertIn("pp1-assistive-phase6a-v2", versions)
        self.assertIn("pp1-assistive-phase6a-v3", versions)
        for entry in history["superseded"]:
            self.assertTrue(entry["superseded_reason"].strip())

    def test_superseded_v3_evidence_is_preserved_unmodified(self) -> None:
        path = EVIDENCE_DIR / "phase-6a-report-v3-superseded.json"
        report = json.loads(path.read_text(encoding="utf-8"))
        history = {entry["corpus_version"]: entry for entry in load_benchmark_history(TOOL_ROOT)["superseded"]}
        entry = history["pp1-assistive-phase6a-v3"]
        self.assertEqual(report["corpus_version"], "pp1-assistive-phase6a-v3")
        self.assertEqual(report["manifest_sha256"], entry["manifest_sha256"])
        self.assertEqual(report["vocabulary_policy_sha256"], entry["vocabulary_policy_sha256"])
        # The superseded run measured LanguageTool 6.4, which is why it cannot be the decision basis.
        self.assertEqual(report["grammar"]["languagetool"]["version"], "6.4")
        self.assertNotEqual(report["grammar"]["languagetool"]["version"], EXPECTED_ENGINE_VERSIONS["languagetool"])
        check_report_metrics(report)


class Phase6ProvenanceTests(unittest.TestCase):
    def test_frozen_policy_provenance_is_fully_proven(self) -> None:
        manifest = load_phase6_manifest(MANIFEST_PATH)
        summary = validate_vocabulary_policy(_load_policy(), manifest, REPOSITORY_ROOT)
        self.assertEqual(summary["holdout_sourced_terms"], 0)
        self.assertEqual(summary["approved_term_count"], sum(summary["source_type_counts"].values()))
        self.assertGreater(summary["approved_term_count"], 0)

    def test_repository_terms_exist_and_contain_their_term(self) -> None:
        for entry in _load_policy()["approved_terms"]:
            if entry["sourceType"] != "repository":
                continue
            path = REPOSITORY_ROOT / entry["source"]
            self.assertTrue(path.is_file(), f"{entry['term']} source {entry['source']} is missing")
            self.assertIn(entry["term"], path.read_text(encoding="utf-8"))

    def test_calibration_terms_are_declared_in_a_calibration_case(self) -> None:
        manifest = load_phase6_manifest(MANIFEST_PATH)
        cases = {case["id"]: case for case in manifest["grammar_cases"]}
        for entry in _load_policy()["approved_terms"]:
            if entry["sourceType"] != "calibration":
                continue
            case = cases[entry["source"]]
            self.assertEqual(case["split"], "calibration")
            self.assertIn(entry["term"], case["source_text"])
            self.assertIn(entry["term"], case["legitimate_technical_terms"])

    def test_holdout_sourced_term_is_rejected_structurally(self) -> None:
        manifest = load_phase6_manifest(MANIFEST_PATH)
        holdout = next(
            case for case in manifest["grammar_cases"]
            if case["split"] == "holdout" and case["legitimate_technical_terms"]
        )
        policy = _load_policy()
        policy["approved_terms"].append({
            "term": holdout["legitimate_technical_terms"][0],
            "sourceType": "calibration",
            "source": holdout["id"],
        })
        with self.assertRaisesRegex(ValueError, "holdout"):
            validate_vocabulary_policy(policy, manifest, REPOSITORY_ROOT)

    def test_unproven_repository_term_is_rejected(self) -> None:
        manifest = load_phase6_manifest(MANIFEST_PATH)
        policy = _load_policy()
        policy["approved_terms"].append({
            "term": "NotARealProjectTerm",
            "sourceType": "repository",
            "source": "infra/supabase/password-recovery-setup.md",
        })
        with self.assertRaisesRegex(ValueError, "does not occur in its claimed repository source"):
            validate_vocabulary_policy(policy, manifest, REPOSITORY_ROOT)

    def test_missing_repository_path_is_rejected(self) -> None:
        manifest = load_phase6_manifest(MANIFEST_PATH)
        policy = _load_policy()
        policy["approved_terms"].append({
            "term": "Ghost",
            "sourceType": "repository",
            "source": "infra/supabase/this-file-does-not-exist.md",
        })
        with self.assertRaisesRegex(ValueError, "does not exist in the repository"):
            validate_vocabulary_policy(policy, manifest, REPOSITORY_ROOT)

    def test_generated_corpus_cannot_supply_repository_provenance(self) -> None:
        manifest = load_phase6_manifest(MANIFEST_PATH)
        policy = _load_policy()
        policy["approved_terms"].append({
            "term": "Flood",
            "sourceType": "repository",
            "source": "tools/assistive-validation-benchmark/phase6/corpus/manifest.json",
        })
        with self.assertRaisesRegex(ValueError, "generated Phase 6 corpus or evidence material"):
            validate_vocabulary_policy(policy, manifest, REPOSITORY_ROOT)

    def test_unsupported_source_type_is_rejected(self) -> None:
        manifest = load_phase6_manifest(MANIFEST_PATH)
        policy = _load_policy()
        policy["approved_terms"].append({"term": "Whatever", "sourceType": "holdout", "source": "g6-041"})
        with self.assertRaisesRegex(ValueError, "unsupported sourceType"):
            validate_vocabulary_policy(policy, manifest, REPOSITORY_ROOT)

    def test_policy_terms_are_unique(self) -> None:
        manifest = load_phase6_manifest(MANIFEST_PATH)
        policy = _load_policy()
        policy["approved_terms"].append(dict(policy["approved_terms"][0]))
        with self.assertRaisesRegex(ValueError, "unique"):
            validate_vocabulary_policy(policy, manifest, REPOSITORY_ROOT)


class Phase6MetricArithmeticTests(unittest.TestCase):
    def test_recompute_matches_worked_example(self) -> None:
        # TP=11, FP=2, FN=9 gives 22/33, not the 0.6875 produced by TP=11, FP=1.
        values = recompute_metrics(11, 2, 9)
        self.assertAlmostEqual(values["precision"], 11 / 13)
        self.assertAlmostEqual(values["recall"], 0.55)
        self.assertAlmostEqual(values["f1"], 22 / 33)
        self.assertNotAlmostEqual(values["f1"], 0.6875)

    def test_empty_counts_do_not_divide_by_zero(self) -> None:
        self.assertEqual(recompute_metrics(0, 0, 0), {"precision": 0.0, "recall": 0.0, "f1": 0.0})

    def test_stale_metric_is_rejected(self) -> None:
        group = {
            "true_positives": 11, "false_positives": 2, "missed_issues": 9, "issue_count": 20,
            "precision": 11 / 13, "recall": 0.55, "f1": 0.6875,
        }
        with self.assertRaisesRegex(ValueError, "stored f1"):
            check_metric_group("unit", group)
        group["f1"] = 22 / 33
        check_metric_group("unit", group)

    def test_inconsistent_issue_count_is_rejected(self) -> None:
        group = {
            "true_positives": 1, "false_positives": 0, "missed_issues": 1, "issue_count": 5,
            "precision": 1.0, "recall": 0.5, "f1": 2 / 3,
        }
        with self.assertRaisesRegex(ValueError, "issue_count"):
            check_metric_group("unit", group)

    def test_scorer_output_is_arithmetically_consistent(self) -> None:
        case = {
            "id": "unit-grammar", "split": "calibration", "field": "summary",
            "source_text": "The nodes reports status.", "intentionally_clean": False,
            "legitimate_technical_terms": [],
            "issues": [{
                "start": 10, "end": 17, "source": "reports",
                "category": "GRAMMAR_SUBJECT_VERB_AGREEMENT", "accepted_corrections": ["report"],
            }],
        }
        finding = {"start": 10, "end": 17, "kind": "Agreement", "replacements": ["report"]}
        scored = score_grammar_engine([case], [[finding]], set())
        for configuration in ("raw", "vocabulary_policy"):
            check_metric_group(configuration, scored[configuration])


class Phase6GrammarContractTests(unittest.TestCase):
    def test_masking_preserves_offsets_and_removes_non_prose(self) -> None:
        source = "Run `npm run test` then visit https://example.invalid/path."
        prepared, spans = prepare_grammar_text(source)
        self.assertEqual(len(prepared), len(source))
        self.assertNotIn("npm", prepared)
        self.assertNotIn("https", prepared)
        self.assertEqual(len(spans), 2)

    def test_vocabulary_policy_is_exact_case_sensitive_and_spelling_only(self) -> None:
        case = {"field": "summary", "source_text": "Kubernetes Kubernetees"}
        findings = [
            {"start": 0, "end": 10, "kind": "Spelling", "replacements": []},
            {"start": 11, "end": 22, "kind": "Spelling", "replacements": []},
        ]
        retained, filtered = apply_vocabulary_policy(case, findings, {"Kubernetes"})
        self.assertEqual(len(filtered), 1)
        self.assertEqual(len(retained), 1)
        self.assertEqual(case["source_text"][retained[0]["start"]:retained[0]["end"]], "Kubernetees")

    def test_span_and_correction_matching_contract(self) -> None:
        case = {
            "id": "unit-grammar", "split": "calibration", "field": "summary",
            "source_text": "The nodes reports status.", "intentionally_clean": False,
            "legitimate_technical_terms": [],
            "issues": [{
                "start": 10, "end": 17, "source": "reports",
                "category": "GRAMMAR_SUBJECT_VERB_AGREEMENT", "accepted_corrections": ["report"],
            }],
        }
        finding = {"start": 10, "end": 17, "kind": "Agreement", "replacements": ["report"]}
        scored = score_grammar_engine([case], [[finding]], set())
        self.assertEqual(scored["raw"]["true_positives"], 1)
        wrong = {**finding, "replacements": ["reported"]}
        scored_wrong = score_grammar_engine([case], [[wrong]], set())
        self.assertEqual(scored_wrong["raw"]["true_positives"], 0)


class Phase6DuplicateContractTests(unittest.TestCase):
    def test_relationship_labels_do_not_enter_ranking(self) -> None:
        manifest = load_phase6_manifest(MANIFEST_PATH)
        query = manifest["duplicate_queries"][0]
        candidates = manifest["duplicate_candidates"]
        baseline = rank_phase6_query(query, candidates)
        relabelled = copy.deepcopy(query)
        relabelled["relationships"] = {
            candidate_id: "UNRELATED" for candidate_id in relabelled["relationships"]
        }
        self.assertEqual(baseline, rank_phase6_query(relabelled, candidates))

    def test_ranker_uses_only_supported_prose_fields(self) -> None:
        query = {"title": "Pump Alert", "summary": "Detect leaks", "background": "Pumps leak", "solution": "Send alerts"}
        candidates = [
            {"id": "a", "title": "Pump Alert", "summary": "Detect leaks", "background": "Pumps leak", "solution": "Send alerts"},
            {"id": "b", "title": "Roster", "summary": "Plan shifts", "background": "Manual roster", "solution": "Calendar"},
        ]
        self.assertEqual(rank_phase6_query(query, candidates)[0]["id"], "a")


class Phase6EvidenceTests(unittest.TestCase):
    def setUp(self) -> None:
        if not EVIDENCE_PATH.is_file():
            self.skipTest(
                "no current final Phase 6A evidence; the vocabulary policy is frozen ahead of the fresh holdout run"
            )
        self.manifest = load_phase6_manifest(MANIFEST_PATH)
        self.report = json.loads(EVIDENCE_PATH.read_text(encoding="utf-8"))

    def _validate(self, report: dict) -> dict:
        return validate_phase6_evidence(
            report, self.manifest, POLICY_PATH,
            tool_root=TOOL_ROOT, repository_root=REPOSITORY_ROOT,
        )

    def test_stored_evidence_and_decisions_match_frozen_contract(self) -> None:
        self.assertIs(self._validate(self.report), self.report)
        self.assertEqual(compact_phase6_evidence(self.report), self.report)

    def test_stored_evidence_metrics_recompute_from_counts(self) -> None:
        self.assertGreaterEqual(check_report_metrics(self.report), 8)

    def test_stored_evidence_measured_the_reviewed_engine_versions(self) -> None:
        self.assertEqual(self.report["engine_version_contract"], EXPECTED_ENGINE_VERSIONS)
        for name, expected in EXPECTED_ENGINE_VERSIONS.items():
            self.assertEqual(self.report["grammar"][name]["status"], "ok")
            self.assertEqual(self.report["grammar"][name]["version"], expected)

    def test_wrong_languagetool_version_is_rejected(self) -> None:
        tampered = copy.deepcopy(self.report)
        tampered["grammar"]["languagetool"]["version"] = "6.4"
        with self.assertRaisesRegex(ValueError, "instead of the reviewed 6.6"):
            self._validate(tampered)

    def test_stale_metric_in_stored_evidence_is_rejected(self) -> None:
        tampered = copy.deepcopy(self.report)
        tampered["grammar"]["languagetool"]["scores"]["by_split"]["holdout"]["vocabulary_policy"]["f1"] = 0.6875
        with self.assertRaisesRegex(ValueError, "stored f1"):
            self._validate(tampered)

    def test_evidence_records_the_policy_freeze_commit(self) -> None:
        freeze = load_policy_freeze(TOOL_ROOT)
        self.assertIsNotNone(freeze)
        self.assertEqual(self.report["policy_freeze_commit_sha"], freeze["policy_freeze_commit_sha"])

    def test_evidence_records_actual_queried_runtimes(self) -> None:
        environment = self.report["environment"]
        for key in ("python", "node", "java", "os"):
            self.assertTrue(environment.get(key), f"{key} runtime was not recorded")
        self.assertNotIn("required by pinned adapter", str(environment["node"]))
        self.assertNotIn("captured in documented execution", str(environment["java"]))

    def test_declared_decisions_respect_the_precision_gate(self) -> None:
        for name in EXPECTED_ENGINE_VERSIONS:
            holdout = self.report["grammar"][name]["scores"]["by_split"]["holdout"]["vocabulary_policy"]
            decision = self.report["decisions"][name]["decision"]
            if holdout["precision"] < 0.90:
                self.assertEqual(decision, "DEFER", f"{name} failed the gate but is not deferred")
            self.assertIn(decision, {"SELECT", "DEFER"})

    def test_evidence_uses_only_policy_approved_terms(self) -> None:
        self.assertEqual(approved_terms(self.report["vocabulary_policy"]), approved_terms(_load_policy()))

    def test_production_boundary_remains_closed(self) -> None:
        boundary = self.report["production_boundary"]
        self.assertTrue(boundary)
        for key, value in boundary.items():
            self.assertIs(value, False, f"{key} crossed the production boundary")
        self.assertEqual(self.report["embedding"]["execution"], "NOT_RUN")


if __name__ == "__main__":
    unittest.main()
