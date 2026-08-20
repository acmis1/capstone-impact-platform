from __future__ import annotations

import json
import unittest
from pathlib import Path

from capstone_assistive_worker.contract import ExtractionResult


class Phase2ConsumerFixtureTests(unittest.TestCase):
    def test_shared_native_pdf_fixture_is_valid_phase1_output(self) -> None:
        fixture = Path(__file__).parent / "fixtures" / "phase-2-consumer-native-pdf.json"
        ExtractionResult.from_dict(json.loads(fixture.read_text(encoding="utf-8")))


if __name__ == "__main__":
    unittest.main()
