import copy
import json
import unittest
from pathlib import Path

from assistive_validation_benchmark.manifest import ManifestError, load_manifest, validate_manifest


MANIFEST = Path(__file__).resolve().parents[1] / "corpus" / "manifest.json"


class ManifestTests(unittest.TestCase):
    def test_committed_manifest_has_42_valid_cases(self):
        manifest = load_manifest(MANIFEST)
        self.assertEqual(len(manifest["cases"]), 42)
        self.assertEqual({case["kind"] for case in manifest["cases"]}, {"document", "grammar", "duplicate"})

    def test_rejects_path_traversal_and_malformed_shape(self):
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        invalid = copy.deepcopy(manifest)
        invalid["cases"][0]["asset"] = "../escape.pdf"
        with self.assertRaises(ManifestError):
            validate_manifest(invalid)
        with self.assertRaises(ManifestError):
            validate_manifest({"schema_version": 1, "corpus_version": "x", "seed": 1, "cases": "bad"})


if __name__ == "__main__":
    unittest.main()
