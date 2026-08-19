import tempfile
import unittest
from pathlib import Path

from assistive_validation_benchmark.corpus import generate_corpus
from assistive_validation_benchmark.manifest import load_manifest


TOOL_ROOT = Path(__file__).resolve().parents[1]


class CorpusTests(unittest.TestCase):
    def test_same_seed_generation_is_byte_identical(self):
        manifest = load_manifest(TOOL_ROOT / "corpus" / "manifest.json")
        with tempfile.TemporaryDirectory() as first_dir, tempfile.TemporaryDirectory() as second_dir:
            first = generate_corpus(manifest, Path(first_dir))
            second = generate_corpus(manifest, Path(second_dir))
        self.assertEqual(first["seed"], second["seed"])
        self.assertEqual(first["assets"], second["assets"])
        self.assertEqual(first["document_count"], 26)


if __name__ == "__main__":
    unittest.main()
