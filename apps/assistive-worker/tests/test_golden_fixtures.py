from __future__ import annotations

import json
import tempfile
import unittest
from io import BytesIO
from pathlib import Path

from PIL import Image

from tests.fixture_support import generate_fixtures


class GoldenFixtureTests(unittest.TestCase):
    def test_generation_matches_committed_golden_hashes(self) -> None:
        temporary, _, generated = generate_fixtures()
        try:
            expected = json.loads(
                (Path(__file__).parent / "fixtures" / "expected.json").read_text(encoding="utf-8")
            )
            self.assertEqual(generated, expected)
        finally:
            temporary.cleanup()

    def test_generation_is_repeatable(self) -> None:
        first, _, first_manifest = generate_fixtures()
        second, _, second_manifest = generate_fixtures()
        try:
            self.assertEqual(first_manifest, second_manifest)
        finally:
            first.cleanup()
            second.cleanup()

    def test_canonical_rasters_are_valid_and_have_expected_dimensions(self) -> None:
        temporary, output, generated = generate_fixtures()
        try:
            expected_dimensions = {
                "valid.png": ("PNG", (640, 480)),
                "valid.jpg": ("JPEG", (640, 480)),
                "low-resolution.png": ("PNG", (64, 64)),
            }
            for name, (expected_format, expected_size) in expected_dimensions.items():
                with Image.open(BytesIO((output / name).read_bytes())) as image:
                    self.assertEqual(image.format, expected_format)
                    self.assertEqual(image.size, expected_size)
            self.assertEqual(generated["scanned-raster.pdf"], json.loads(
                (Path(__file__).parent / "fixtures" / "expected.json").read_text(encoding="utf-8")
            )["scanned-raster.pdf"])
        finally:
            temporary.cleanup()


if __name__ == "__main__":
    unittest.main()
