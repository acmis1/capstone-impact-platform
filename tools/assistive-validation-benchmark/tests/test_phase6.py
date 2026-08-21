from __future__ import annotations

import copy
import json
import tempfile
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
from assistive_validation_benchmark.phase6.runner import compact_phase6_evidence, validate_phase6_evidence

TOOL_ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = TOOL_ROOT / "phase6" / "corpus" / "manifest.json"
HASH_PATH = TOOL_ROOT / "phase6" / "corpus" / "manifest.sha256"
POLICY_PATH = TOOL_ROOT / "phase6" / "grammar" / "vocabulary-policy.json"
EVIDENCE_PATH = TOOL_ROOT.parents[1] / "docs" / "assistive-validation" / "evidence" / "phase-6a-report.json"


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

    def test_stored_evidence_and_decisions_match_frozen_contract(self) -> None:
        manifest = load_phase6_manifest(MANIFEST_PATH)
        report = json.loads(EVIDENCE_PATH.read_text(encoding="utf-8"))
        self.assertIs(validate_phase6_evidence(report, manifest, POLICY_PATH), report)
        self.assertEqual(compact_phase6_evidence(report), report)


class Phase6GrammarContractTests(unittest.TestCase):
    def test_vocabulary_provenance_contract(self) -> None:
        policy = json.loads(POLICY_PATH.read_text(encoding="utf-8"))
        manifest = load_phase6_manifest(MANIFEST_PATH)
        approved_terms = policy["approved_terms"]
        
        self.assertEqual(policy["policy_version"], 2)
        
        terms = [item["term"] for item in approved_terms]
        self.assertEqual(len(terms), len(set(terms)), "Duplicate terms in vocabulary policy")
        
        for item in approved_terms:
            term = item["term"]
            source_type = item["sourceType"]
            source = item["source"]
            
            self.assertIn(source_type, ["repository", "calibration", "controlled_pp1"])
            self.assertTrue(source, f"{term} missing explicit source")
            
            if source_type == "calibration":
                # Must be a valid calibration case
                is_grammar = any(c["id"] == source and c["split"] == "calibration" for c in manifest["grammar_cases"])
                is_duplicate = any(q["id"] == source and q["split"] == "calibration" for q in manifest["duplicate_queries"])
                self.assertTrue(is_grammar or is_duplicate, f"{term} claims calibration source {source} but it is not a calibration case")
                
                # Check that term is actually in the text
                found = False
                for c in manifest["grammar_cases"]:
                    if c["id"] == source and term in c["source_text"]:
                        found = True
                for q in manifest["duplicate_queries"]:
                    if q["id"] == source:
                        if term in q["title"] or term in q["summary"] or term in q["background"] or term in q["solution"]:
                            found = True
                self.assertTrue(found, f"{term} not found in calibration case {source}")
            
            # 3. no policy term has a holdout case as provenance
            self.assertFalse("holdout" in source.lower() or source.startswith("g6-04") or source.startswith("g6-05") or source.startswith("g6-06") or source.startswith("g6-07") or source.startswith("g6-08") or "holdout" in source_type)

    def test_masking_preserves_offsets_and_removes_non_prose(self) -> None:
        source = "Run `npm run test` then visit https://example.invalid/path."
        prepared, spans = prepare_grammar_text(source)
        self.assertEqual(len(prepared), len(source))
        self.assertNotIn("npm", prepared)
        self.assertNotIn("https", prepared)
        self.assertEqual(len(spans), 2)

    def test_vocabulary_policy_is_exact_case_sensitive_and_spelling_only(self) -> None:
        case = {
            "field": "summary",
            "source_text": "Kubernetes Kubernetees",
        }
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
            "id": "unit-grammar",
            "split": "calibration",
            "field": "summary",
            "source_text": "The nodes reports status.",
            "intentionally_clean": False,
            "legitimate_technical_terms": [],
            "issues": [{
                "start": 10,
                "end": 17,
                "source": "reports",
                "category": "GRAMMAR_SUBJECT_VERB_AGREEMENT",
                "accepted_corrections": ["report"],
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


if __name__ == "__main__":
    unittest.main()
