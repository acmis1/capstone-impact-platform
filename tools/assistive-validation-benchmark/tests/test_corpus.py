import tempfile
import unittest
from pathlib import Path

from assistive_validation_benchmark.corpus import generate_corpus
from assistive_validation_benchmark.manifest import cases_of_kind, load_manifest

TOOL_ROOT = Path(__file__).resolve().parents[1]


class CorpusTests(unittest.TestCase):
    def setUp(self):
        self.manifest = load_manifest(TOOL_ROOT / "corpus" / "manifest.json")

    def test_same_seed_generation_is_byte_identical(self):
        with tempfile.TemporaryDirectory() as first_dir, tempfile.TemporaryDirectory() as second_dir:
            first = generate_corpus(self.manifest, Path(first_dir))
            second = generate_corpus(self.manifest, Path(second_dir))
        self.assertEqual(first["seed"], second["seed"])
        self.assertEqual(first["assets"], second["assets"])
        self.assertEqual(first["document_count"], len(cases_of_kind(self.manifest, "document")))

    def test_generation_records_more_than_one_resolved_typeface(self):
        with tempfile.TemporaryDirectory() as directory:
            generation = generate_corpus(self.manifest, Path(directory))
        families = set(generation["resolved_fonts"].values())
        self.assertGreater(len(families), 1, "the corpus must not silently collapse to one font family")

    def test_scanned_pdfs_carry_no_extractable_native_text(self):
        from assistive_validation_benchmark.engines import pdfium_extract

        scanned = [case for case in cases_of_kind(self.manifest, "document")
                   if case["document_type"] == "scanned_pdf"]
        with tempfile.TemporaryDirectory() as directory:
            generate_corpus(self.manifest, Path(directory))
            for case in scanned:
                observation = pdfium_extract(Path(directory) / case["asset"])
                with self.subTest(case=case["id"]):
                    self.assertEqual(observation["status"], "ok")
                    self.assertLess(observation["extracted_character_count"], 20)

    def test_multi_column_born_digital_pdf_uses_real_columns(self):
        from assistive_validation_benchmark.engines import pdfium_extract

        case = next(case for case in cases_of_kind(self.manifest, "document")
                    if case["document_type"] == "born_digital_pdf" and case["layout"] == "multi_column")
        with tempfile.TemporaryDirectory() as directory:
            generate_corpus(self.manifest, Path(directory))
            observation = pdfium_extract(Path(directory) / case["asset"])
        self.assertEqual(observation["status"], "ok")
        self.assertGreater(observation["extracted_character_count"], 20)


if __name__ == "__main__":
    unittest.main()
