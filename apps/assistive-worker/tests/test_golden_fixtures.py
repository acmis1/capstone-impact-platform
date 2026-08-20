from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

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


if __name__ == "__main__":
    unittest.main()
