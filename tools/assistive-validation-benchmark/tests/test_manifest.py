import copy
import json
import unittest
from pathlib import Path

from assistive_validation_benchmark.manifest import ManifestError, cases_of_kind, load_manifest, validate_manifest

MANIFEST = Path(__file__).resolve().parents[1] / "corpus" / "manifest.json"


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.manifest = load_manifest(MANIFEST)

    def test_committed_manifest_is_valid_and_split_assigned(self):
        cases = self.manifest["cases"]
        self.assertEqual({case["kind"] for case in cases}, {"document", "grammar", "duplicate"})
        self.assertEqual({case["split"] for case in cases}, {"calibration", "holdout"})
        for kind in ("document", "grammar", "duplicate"):
            splits = {case["split"] for case in cases_of_kind(self.manifest, kind)}
            with self.subTest(kind=kind):
                self.assertEqual(splits, {"calibration", "holdout"},
                                 "every kind needs both splits or its holdout evidence is meaningless")

    def test_corpus_contains_decision_band_title_cases_on_both_sides(self):
        documents = cases_of_kind(self.manifest, "document")
        variants = {case["title_variant"] for case in documents}
        self.assertIn("material_single_token", variants)
        self.assertIn("ocr_glyph_confusion", variants)
        material = [case for case in documents if case["title_variant"] == "material_single_token"]
        self.assertTrue(material and all(case["expected_title_match"] is False for case in material))

    def test_grammar_corpus_is_false_positive_weighted(self):
        grammar = cases_of_kind(self.manifest, "grammar")
        clean = [case for case in grammar if not case["expected_issues"]]
        self.assertGreaterEqual(len(grammar), 30)
        self.assertGreaterEqual(len(clean), len(grammar) // 2,
                                "false-positive evidence needs at least as many clean cases as faulty ones")

    def test_duplicate_corpus_contains_hard_negatives(self):
        relations = {candidate["relation"]
                     for case in cases_of_kind(self.manifest, "duplicate")
                     for candidate in case["candidates"]}
        for required in ("same_technology_different_problem", "shared_boilerplate_different_problem",
                         "renamed_similar_description", "lightly_rewritten_duplicate"):
            with self.subTest(relation=required):
                self.assertIn(required, relations)

    def test_rejects_path_traversal_and_malformed_shape(self):
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        invalid = copy.deepcopy(manifest)
        invalid["cases"][0]["asset"] = "../escape.pdf"
        with self.assertRaises(ManifestError):
            validate_manifest(invalid)
        with self.assertRaises(ManifestError):
            validate_manifest({"schema_version": 1, "corpus_version": "x", "seed": 1, "cases": "bad"})

    def test_rejects_unsupported_layout_and_typeface(self):
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        for field, value in (("layout", "spiral"), ("typeface", "comic")):
            invalid = copy.deepcopy(manifest)
            document = next(case for case in invalid["cases"] if case["kind"] == "document")
            document[field] = value
            with self.subTest(field=field), self.assertRaises(ManifestError):
                validate_manifest(invalid)


if __name__ == "__main__":
    unittest.main()
