"""Bounded tests for the optional frozen PP-OCRv6 Small provider."""

from __future__ import annotations

import builtins
import io
import sys
import time
import types
import unittest
from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from PIL import Image

from capstone_assistive_worker.contract import GeometryUnit
from capstone_assistive_worker.ocr.contract import (
    OcrAvailabilityState,
    OcrInput,
    OcrProviderErrorCode,
    OcrResultStatus,
)
from capstone_assistive_worker.ocr.paddle_title import (
    DETECTION_MODEL,
    FROZEN_CPU_THREADS,
    FROZEN_MKLDNN_CACHE_CAPACITY,
    FROZEN_RUNTIME,
    MAX_INPUT_DIMENSION,
    PROVIDER_ID,
    RECOGNITION_MODEL,
    PaddleTitleOcrProvider,
    tree_sha256,
)
from capstone_assistive_worker.security.limits import DEFAULT_LIMITS

from tests.fixture_support import generate_fixtures


_FIXTURES: tuple = ()


def _raster() -> OcrInput:
    global _FIXTURES
    if not _FIXTURES:
        _FIXTURES = generate_fixtures()
    data = (_FIXTURES[1] / "valid.png").read_bytes()
    with Image.open(io.BytesIO(data)) as image:
        width, height = image.size
    return OcrInput(png_bytes=data, page_number=1, width=width, height=height)


class _FakeResult:
    def __init__(self, payload: dict) -> None:
        self.json = {"res": payload}


class _FakeEngine:
    def __init__(self, payload: dict, *, delay: float = 0.0) -> None:
        self._payload = payload
        self._delay = delay

    def predict(self, page):
        page_path = Path(page)
        if page_path.suffix != ".ppm" or not page_path.read_bytes().startswith(b"P6\n"):
            raise AssertionError("the provider must pass a bounded local PPM path")
        if self._delay:
            time.sleep(self._delay)
        return [_FakeResult(self._payload)]


def _provisioned(models: Path) -> None:
    for name in (DETECTION_MODEL, RECOGNITION_MODEL):
        directory = models / f"{name}_infer"
        directory.mkdir(parents=True)
        (directory / "inference.json").write_bytes(b"{}")


def _provider_with(models: Path, payload: dict | None = None, *, limits=DEFAULT_LIMITS):
    provider = PaddleTitleOcrProvider(models_dir=models, limits=limits)
    detection = tree_sha256(models / f"{DETECTION_MODEL}_infer")
    recognition = tree_sha256(models / f"{RECOGNITION_MODEL}_infer")
    provider._observed_runtime = lambda: FROZEN_RUNTIME  # noqa: SLF001
    if payload is not None:
        provider._engine = lambda *_args: _FakeEngine(payload)  # noqa: SLF001
    return provider, detection, recognition


class PaddleTitleProviderAvailabilityTests(unittest.TestCase):
    def test_absent_model_directory_is_unavailable_not_an_error(self) -> None:
        availability = PaddleTitleOcrProvider(models_dir=None).availability()
        self.assertIs(OcrAvailabilityState.UNAVAILABLE, availability.state)
        self.assertEqual(PROVIDER_ID, availability.provider.provider_id)

    def test_hash_mismatch_keeps_the_provider_unavailable(self) -> None:
        with TemporaryDirectory() as directory:
            models = Path(directory)
            _provisioned(models)
            provider, _detection, _recognition = _provider_with(models)
            availability = provider.availability()
        self.assertIs(OcrAvailabilityState.UNAVAILABLE, availability.state)
        self.assertIn("frozen identity", availability.message or "")

    def test_runtime_mismatch_keeps_the_provider_unavailable(self) -> None:
        with TemporaryDirectory() as directory:
            models = Path(directory)
            _provisioned(models)
            provider = PaddleTitleOcrProvider(models_dir=models)
            provider._observed_runtime = lambda: {"paddleocr": "9.9.9"}  # noqa: SLF001
            availability = provider.availability()
        self.assertIs(OcrAvailabilityState.UNAVAILABLE, availability.state)

    def test_unavailable_provider_fails_safely_instead_of_raising(self) -> None:
        provider = PaddleTitleOcrProvider(models_dir=None)
        provider._engine = lambda *_args: self.fail("an unavailable provider must not construct an engine")  # noqa: SLF001
        result = provider.extract(_raster())
        self.assertIs(OcrResultStatus.FAILED, result.status)
        self.assertIs(OcrProviderErrorCode.EXECUTION_FAILED, result.error_code)


class PaddleTitleProviderConfigurationTests(unittest.TestCase):
    def test_engine_uses_only_the_exact_frozen_configuration_and_offline_guard(self) -> None:
        import capstone_assistive_worker.ocr.paddle_title as module

        captured: dict = {}
        fake = types.ModuleType("paddleocr")
        fake.PaddleOCR = lambda **kwargs: captured.update(kwargs) or object()
        original_module = sys.modules.get("paddleocr")
        original_guard = module.enable_offline_guard
        guarded: list[bool] = []
        sys.modules["paddleocr"] = fake
        module.enable_offline_guard = lambda: guarded.append(True)
        try:
            provider = PaddleTitleOcrProvider(models_dir=None)
            provider._engine(Path("det"), Path("rec"))  # noqa: SLF001
        finally:
            module.enable_offline_guard = original_guard
            if original_module is None:
                del sys.modules["paddleocr"]
            else:
                sys.modules["paddleocr"] = original_module
        self.assertEqual([True], guarded)
        self.assertEqual(FROZEN_CPU_THREADS, captured["cpu_threads"])
        self.assertEqual(FROZEN_MKLDNN_CACHE_CAPACITY, captured["mkldnn_cache_capacity"])
        self.assertEqual("det", captured["text_detection_model_dir"])
        self.assertEqual("rec", captured["text_recognition_model_dir"])
        self.assertEqual("cpu", captured["device"])
        self.assertFalse(captured["enable_mkldnn"])
        self.assertFalse(captured["enable_hpi"])
        self.assertFalse(captured["use_doc_orientation_classify"])
        self.assertFalse(captured["use_doc_unwarping"])
        self.assertFalse(captured["use_textline_orientation"])

    def test_input_long_edge_is_bounded_to_the_frozen_dimension(self) -> None:
        image = Image.new("RGB", (3000, 1500), "white")
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        image.close()
        raster = OcrInput(png_bytes=buffer.getvalue(), page_number=1, width=3000, height=1500)
        decoded = PaddleTitleOcrProvider(models_dir=None)._decode_ppm(raster)  # noqa: SLF001
        with Image.open(io.BytesIO(decoded)) as page:
            self.assertEqual((MAX_INPUT_DIMENSION, MAX_INPUT_DIMENSION // 2), page.size)
            self.assertEqual("RGB", page.mode)


class PaddleTitleProviderExtractionTests(unittest.TestCase):
    def _run(self, payload: dict, *, limits=DEFAULT_LIMITS, delay: float = 0.0, raster: OcrInput | None = None):
        with TemporaryDirectory() as directory:
            models = Path(directory)
            _provisioned(models)
            provider, detection, recognition = _provider_with(models, payload, limits=limits)
            provider._engine = lambda *_args: _FakeEngine(payload, delay=delay)  # noqa: SLF001
            import capstone_assistive_worker.ocr.paddle_title as module

            original = (module.DETECTION_TREE_SHA256, module.RECOGNITION_TREE_SHA256)
            module.DETECTION_TREE_SHA256, module.RECOGNITION_TREE_SHA256 = detection, recognition
            try:
                return provider.extract(raster or _raster())
            finally:
                module.DETECTION_TREE_SHA256, module.RECOGNITION_TREE_SHA256 = original

    def test_recognised_lines_become_bounded_blocks_with_pixel_geometry(self) -> None:
        result = self._run({
            "rec_texts": ["Copper Foundry Airflow Digest", "SCOPE", "   "],
            "rec_scores": [0.99, 0.97, 0.5],
            "rec_boxes": [[200, 160, 1000, 212], [54, 609, 130, 633], [0, 0, 1, 1]],
        })
        self.assertIs(OcrResultStatus.SUCCESS, result.status)
        self.assertEqual(2, len(result.blocks))
        first = result.blocks[0]
        self.assertEqual("Copper Foundry Airflow Digest", first.text)
        self.assertEqual(GeometryUnit.IMAGE_PIXELS_TOP_LEFT, first.bounding_box.unit)
        self.assertEqual((200.0, 160.0, 1000.0, 212.0), (
            first.bounding_box.left, first.bounding_box.top,
            first.bounding_box.right, first.bounding_box.bottom,
        ))
        self.assertEqual("Copper Foundry Airflow Digest\nSCOPE", result.text)

    def test_lightweight_provider_path_never_imports_numpy(self) -> None:
        original_import = builtins.__import__

        def guarded_import(name, *args, **kwargs):
            if name == "numpy" or name.startswith("numpy."):
                raise AssertionError("the lightweight provider path must not import NumPy")
            return original_import(name, *args, **kwargs)

        with patch.object(builtins, "__import__", side_effect=guarded_import):
            result = self._run({"rec_texts": ["Title"], "rec_scores": [0.99], "rec_boxes": []})
        self.assertIs(OcrResultStatus.SUCCESS, result.status)

    def test_malformed_normalized_png_fails_safely(self) -> None:
        malformed = OcrInput(
            png_bytes=b"\x89PNG\r\n\x1a\nmalformed",
            page_number=1,
            width=1,
            height=1,
        )
        result = self._run({"rec_texts": ["Title"]}, raster=malformed)
        self.assertIs(OcrResultStatus.FAILED, result.status)
        self.assertIs(OcrProviderErrorCode.EXECUTION_FAILED, result.error_code)

    def test_provider_enforces_raster_bounds_before_prediction(self) -> None:
        limits = replace(DEFAULT_LIMITS, max_raster_width=1)
        result = self._run({"rec_texts": ["Title"]}, limits=limits)
        self.assertIs(OcrResultStatus.FAILED, result.status)
        self.assertIs(OcrProviderErrorCode.EXECUTION_FAILED, result.error_code)

    def test_polygon_geometry_is_reduced_to_an_axis_aligned_box(self) -> None:
        result = self._run({
            "rec_texts": ["Ledge Aviary Feather Count"],
            "rec_scores": [0.98],
            "dt_polys": [[[210, 158], [1010, 160], [1008, 214], [208, 212]]],
        })
        box = result.blocks[0].bounding_box
        self.assertEqual((208.0, 158.0, 1010.0, 214.0), (box.left, box.top, box.right, box.bottom))

    def test_malformed_geometry_degrades_to_a_block_without_a_box(self) -> None:
        result = self._run({"rec_texts": ["Title"], "rec_scores": [0.9], "rec_boxes": [["x", "y"]]})
        self.assertIs(OcrResultStatus.SUCCESS, result.status)
        self.assertIsNone(result.blocks[0].bounding_box)

    def test_output_limits_are_enforced_before_line_truncation(self) -> None:
        limits = replace(DEFAULT_LIMITS, max_extracted_characters=20)
        result = self._run({"rec_texts": ["x" * 21], "rec_scores": [0.9], "rec_boxes": []}, limits=limits)
        self.assertIs(OcrResultStatus.FAILED, result.status)
        self.assertIs(OcrProviderErrorCode.OUTPUT_LIMIT_EXCEEDED, result.error_code)

    def test_timeout_fails_safely(self) -> None:
        limits = replace(DEFAULT_LIMITS, provider_timeout_seconds=0.001)
        result = self._run({"rec_texts": ["Title"], "rec_scores": [0.9], "rec_boxes": []}, limits=limits, delay=0.05)
        self.assertIs(OcrResultStatus.FAILED, result.status)
        self.assertIs(OcrProviderErrorCode.TIMEOUT, result.error_code)

    def test_unrecognised_result_structure_fails_safely(self) -> None:
        class _BadEngine:
            def predict(self, _page):
                return [object()]

        with TemporaryDirectory() as directory:
            models = Path(directory)
            _provisioned(models)
            provider, detection, recognition = _provider_with(models)
            provider._engine = lambda *_args: _BadEngine()  # noqa: SLF001
            import capstone_assistive_worker.ocr.paddle_title as module

            original = (module.DETECTION_TREE_SHA256, module.RECOGNITION_TREE_SHA256)
            module.DETECTION_TREE_SHA256, module.RECOGNITION_TREE_SHA256 = detection, recognition
            try:
                result = provider.extract(_raster())
            finally:
                module.DETECTION_TREE_SHA256, module.RECOGNITION_TREE_SHA256 = original
        self.assertIs(OcrResultStatus.FAILED, result.status)
        self.assertIs(OcrProviderErrorCode.OUTPUT_INVALID, result.error_code)


if __name__ == "__main__":
    unittest.main()
