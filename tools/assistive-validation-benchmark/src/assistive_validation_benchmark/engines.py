from __future__ import annotations

import ctypes
import importlib.metadata
import json
import os
import platform
import shutil
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

MAX_INPUT_BYTES = 25 * 1024 * 1024
MAX_IMAGE_PIXELS = 30_000_000
MAX_PDF_PAGES = 4
PADDLE_VARIANTS = {
    "paddle-tiny": ("PP-OCRv6_tiny_det", "PP-OCRv6_tiny_rec"),
    "paddle-small": ("PP-OCRv6_small_det", "PP-OCRv6_small_rec"),
    "paddle-medium": ("PP-OCRv6_medium_det", "PP-OCRv6_medium_rec"),
}
_PADDLE_INSTANCES: dict[str, Any] = {}


def _process_memory_bytes(pid: int) -> int | None:
    if os.name == "nt":
        class Counter(ctypes.Structure):
            _fields_ = [
                ("cb", ctypes.c_ulong), ("PageFaultCount", ctypes.c_ulong),
                ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t),
            ]
        access = 0x0400 | 0x0010
        handle = ctypes.windll.kernel32.OpenProcess(access, False, pid)
        if not handle:
            return None
        try:
            counter = Counter()
            counter.cb = ctypes.sizeof(counter)
            if ctypes.windll.psapi.GetProcessMemoryInfo(handle, ctypes.byref(counter), counter.cb):
                return int(counter.PeakWorkingSetSize)
        finally:
            ctypes.windll.kernel32.CloseHandle(handle)
        return None
    status = Path(f"/proc/{pid}/status")
    try:
        for line in status.read_text().splitlines():
            if line.startswith("VmHWM:"):
                return int(line.split()[1]) * 1024
    except OSError:
        return None
    return None


def current_process_peak_memory() -> int | None:
    return _process_memory_bytes(os.getpid())


def run_command_measured(command: list[str], *, timeout: float = 180.0) -> dict[str, Any]:
    started = time.perf_counter()
    with tempfile.TemporaryFile() as stdout_file, tempfile.TemporaryFile() as stderr_file:
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=stdout_file, stderr=stderr_file, shell=False)
        peak = 0
        try:
            while process.poll() is None:
                observed = _process_memory_bytes(process.pid)
                peak = max(peak, observed or 0)
                if time.perf_counter() - started > timeout:
                    process.kill()
                    raise TimeoutError(f"command exceeded {timeout:.0f}s")
                time.sleep(0.01)
            observed = _process_memory_bytes(process.pid)
            peak = max(peak, observed or 0)
        finally:
            process.wait()
        stdout_file.seek(0)
        stderr_file.seek(0)
        stdout = stdout_file.read().decode("utf-8", errors="replace")
        stderr = stderr_file.read().decode("utf-8", errors="replace")
    return {
        "returncode": process.returncode,
        "stdout": stdout,
        "stderr": stderr,
        "runtime_ms": (time.perf_counter() - started) * 1000,
        "peak_memory_bytes": peak or None,
    }


def _unavailable(engine: str, reason: str, **extra: Any) -> dict[str, Any]:
    return {"engine": engine, "status": "unavailable", "error": reason, **extra}


def _validate_local_file(path: Path, suffixes: set[str]) -> None:
    if not path.is_file():
        raise ValueError("input is not a regular local file")
    if path.suffix.lower() not in suffixes:
        raise ValueError(f"unsupported extension {path.suffix}")
    if path.stat().st_size > MAX_INPUT_BYTES:
        raise ValueError(f"input exceeds {MAX_INPUT_BYTES} bytes")


def pdfium_extract(path: Path) -> dict[str, Any]:
    engine = "pdfium"
    try:
        _validate_local_file(path, {".pdf"})
        import pypdfium2 as pdfium
    except ImportError:
        return _unavailable(engine, "pypdfium2 is not installed")
    except ValueError as error:
        return {"engine": engine, "status": "failed", "error": str(error)}
    started = time.perf_counter()
    try:
        document = pdfium.PdfDocument(str(path))
        if len(document) > MAX_PDF_PAGES:
            raise ValueError(f"PDF has more than {MAX_PDF_PAGES} pages")
        page_texts, text_objects = [], 0
        for page_index in range(len(document)):
            page = document[page_index]
            text_page = page.get_textpage()
            if hasattr(text_page, "get_text_bounded"):
                page_text = text_page.get_text_bounded()
            else:
                page_text = text_page.get_text_range()
            page_texts.append(page_text)
            text_objects += len([line for line in page_text.splitlines() if line.strip()])
            text_page.close()
            page.close()
        document.close()
        text = "\n".join(page_texts)
        printable = sum(character.isprintable() or character.isspace() for character in text)
        return {
            "engine": engine,
            "status": "ok",
            "version": importlib.metadata.version("pypdfium2"),
            "library": "pypdfium2/PDFium",
            "device": "cpu",
            "backend": platform.system().lower(),
            "text": text,
            "runtime_ms": (time.perf_counter() - started) * 1000,
            "peak_memory_bytes": current_process_peak_memory(),
            "page_count": len(page_texts),
            "text_object_count": text_objects,
            "extracted_character_count": len(text),
            "printable_character_ratio": printable / len(text) if text else 0.0,
            "replacement_character_count": text.count("\ufffd"),
        }
    except Exception as error:  # Native parser failures are benchmark evidence.
        return {
            "engine": engine,
            "status": "failed",
            "version": importlib.metadata.version("pypdfium2"),
            "error": f"{type(error).__name__}: {error}",
            "runtime_ms": (time.perf_counter() - started) * 1000,
            "peak_memory_bytes": current_process_peak_memory(),
        }


def render_pdf(path: Path, output_path: Path, *, scale: float = 2.0) -> Path:
    _validate_local_file(path, {".pdf"})
    import pypdfium2 as pdfium
    document = pdfium.PdfDocument(str(path))
    try:
        if not 1 <= len(document) <= MAX_PDF_PAGES:
            raise ValueError("PDF page count is outside the benchmark bound")
        page = document[0]
        try:
            image = page.render(scale=scale).to_pil()
            if image.width * image.height > MAX_IMAGE_PIXELS:
                raise ValueError("rendered PDF exceeds the image-pixel bound")
            image.save(output_path, "PNG")
        finally:
            page.close()
    finally:
        document.close()
    return output_path


def tesseract_ocr(path: Path, *, executable: str | None = None, psm: str = "3") -> dict[str, Any]:
    """Run local Tesseract.

    ``psm`` defaults to 3 (automatic page segmentation). An earlier revision forced ``--psm 6``
    ("a single uniform block of text"), which suppresses layout analysis and is not equivalent to
    PP-OCR's detector stage, so the two engines were not being compared on equal terms.
    """
    engine = "tesseract"
    try:
        _validate_local_file(path, {".png", ".jpg", ".jpeg"})
    except ValueError as error:
        return {"engine": engine, "status": "failed", "error": str(error)}
    command = executable or os.environ.get("TESSERACT_CMD") or shutil.which("tesseract")
    if not command:
        return _unavailable(engine, "tesseract executable was not found; set TESSERACT_CMD")
    try:
        version_result = run_command_measured([command, "--version"], timeout=30)
    except (OSError, TimeoutError) as error:
        return _unavailable(engine, f"tesseract executable could not run: {error}")
    version_line = (version_result["stdout"] or version_result["stderr"]).splitlines()[0] if (version_result["stdout"] or version_result["stderr"]) else "unknown"
    if psm not in {str(value) for value in range(0, 14)}:
        return {"engine": engine, "status": "failed", "version": version_line, "error": f"unsupported psm {psm}"}
    try:
        result = run_command_measured([command, str(path), "stdout", "--psm", psm, "-l", "eng"])
    except (OSError, TimeoutError) as error:
        return {"engine": engine, "status": "failed", "version": version_line, "error": str(error)}
    settings = {"psm": psm, "language": "eng", "executable": command}
    if result["returncode"] != 0:
        return {"engine": engine, "status": "failed", "version": version_line, "error": result["stderr"].strip(),
                "settings": settings, "runtime_ms": result["runtime_ms"], "peak_memory_bytes": result["peak_memory_bytes"]}
    return {"engine": engine, "status": "ok", "version": version_line, "model": "eng traineddata",
            "device": "cpu", "backend": "tesseract-cli", "text": result["stdout"], "settings": settings,
            "runtime_ms": result["runtime_ms"], "peak_memory_bytes": result["peak_memory_bytes"]}


def _paddle_result_data(result: Any) -> dict[str, Any]:
    value = getattr(result, "json", result)
    value = value() if callable(value) else value
    if isinstance(value, str):
        value = json.loads(value)
    if isinstance(value, dict) and isinstance(value.get("res"), dict):
        value = value["res"]
    return value if isinstance(value, dict) else {}


def paddle_ocr(path: Path, variant: str) -> dict[str, Any]:
    if variant not in PADDLE_VARIANTS:
        return {"engine": variant, "status": "failed", "error": "unknown PP-OCRv6 variant"}
    try:
        _validate_local_file(path, {".png", ".jpg", ".jpeg"})
        from paddleocr import PaddleOCR
    except ImportError:
        return _unavailable(variant, "PaddleOCR/PaddlePaddle optional dependencies are not installed",
                            model={"detection": PADDLE_VARIANTS[variant][0], "recognition": PADDLE_VARIANTS[variant][1]})
    except ValueError as error:
        return {"engine": variant, "status": "failed", "error": str(error)}
    detection, recognition = PADDLE_VARIANTS[variant]
    # A first cold start that also downloads official weights is not comparable with one that only
    # loads a cached model, so record which of the two this was instead of blending them.
    cache_root = Path.home() / ".paddlex" / "official_models"
    weights_cached = all((cache_root / name).is_dir() for name in (detection, recognition))
    started = time.perf_counter()
    try:
        ocr = _PADDLE_INSTANCES.get(variant)
        cold_start = ocr is None
        if ocr is None:
            ocr = PaddleOCR(
                text_detection_model_name=detection,
                text_recognition_model_name=recognition,
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=False,
                device="cpu",
                enable_mkldnn=False,
            )
            _PADDLE_INSTANCES[variant] = ocr
        texts: list[str] = []
        confidences: list[float] = []
        geometry_count = 0
        for result in ocr.predict(str(path)):
            data = _paddle_result_data(result)
            result_texts = data.get("rec_texts") or data.get("texts") or []
            texts.extend(str(text) for text in result_texts if str(text).strip())
            confidences.extend(float(value) for value in (data.get("rec_scores") or []) if isinstance(value, (int, float)))
            geometry_count += len(data.get("rec_polys") or data.get("dt_polys") or [])
        return {
            "engine": variant,
            "status": "ok",
            "version": importlib.metadata.version("paddleocr"),
            "framework_version": importlib.metadata.version("paddlepaddle"),
            "model": {"detection": detection, "recognition": recognition},
            "device": "cpu",
            "backend": "paddle-cpu (oneDNN disabled for Windows compatibility)",
            "cold_start_included": cold_start,
            "weights_cached_before_run": weights_cached,
            "settings": {"device": "cpu", "enable_mkldnn": False, "use_doc_orientation_classify": False,
                         "use_doc_unwarping": False, "use_textline_orientation": False},
            "text": "\n".join(texts),
            "mean_confidence": sum(confidences) / len(confidences) if confidences else None,
            "geometry_count": geometry_count,
            "runtime_ms": (time.perf_counter() - started) * 1000,
            "peak_memory_bytes": current_process_peak_memory(),
        }
    except Exception as error:
        return {
            "engine": variant,
            "status": "failed",
            "version": importlib.metadata.version("paddleocr"),
            "model": {"detection": detection, "recognition": recognition},
            "device": "cpu",
            "weights_cached_before_run": weights_cached,
            "error": f"{type(error).__name__}: {error}",
            "runtime_ms": (time.perf_counter() - started) * 1000,
            "peak_memory_bytes": current_process_peak_memory(),
        }


def harper_check(texts: list[str], tool_root: Path) -> dict[str, Any]:
    runner = tool_root / "harper_runner.mjs"
    package = tool_root / "node_modules" / "harper.js" / "package.json"
    node = shutil.which("node")
    if not node:
        return _unavailable("harper", "node executable was not found")
    if not package.is_file():
        return _unavailable("harper", "isolated harper.js dependency is not installed; run npm install in the benchmark directory")
    with tempfile.TemporaryDirectory(prefix="pp1-harper-") as temp_dir:
        input_path = Path(temp_dir) / "input.json"
        input_path.write_text(json.dumps({"texts": texts}), encoding="utf-8")
        try:
            result = run_command_measured([node, str(runner), str(input_path)], timeout=180)
        except (OSError, TimeoutError) as error:
            return {"engine": "harper", "status": "failed", "error": str(error)}
    version = json.loads(package.read_text(encoding="utf-8")).get("version", "unknown")
    if result["returncode"] != 0:
        return {"engine": "harper", "status": "failed", "version": version, "error": result["stderr"].strip(),
                "runtime_ms": result["runtime_ms"], "peak_memory_bytes": result["peak_memory_bytes"]}
    try:
        findings = json.loads(result["stdout"])
    except json.JSONDecodeError as error:
        return {"engine": "harper", "status": "failed", "version": version, "error": f"invalid JSON output: {error}"}
    return {"engine": "harper", "status": "ok", "version": version, "backend": "harper.js wasm/local",
            "device": "cpu", "case_findings": findings, "runtime_ms": result["runtime_ms"],
            "peak_memory_bytes": result["peak_memory_bytes"]}


def _loopback_languagetool_url(value: str) -> str:
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("LanguageTool URL must be an http loopback address")
    return value.rstrip("/") + "/v2/check"


def languagetool_check(texts: list[str], base_url: str, *, process_id: int | None = None,
                       language: str = "en-AU") -> dict[str, Any]:
    try:
        endpoint = _loopback_languagetool_url(base_url)
    except ValueError as error:
        return {"engine": "languagetool", "status": "failed", "error": str(error)}
    started = time.perf_counter()
    case_findings, version, peak = [], "unknown", 0
    try:
        for text in texts:
            payload = urllib.parse.urlencode({"language": language, "text": text}).encode()
            request = urllib.request.Request(endpoint, data=payload, method="POST")
            with urllib.request.urlopen(request, timeout=30) as response:
                data = json.loads(response.read().decode("utf-8"))
            if process_id is not None:
                peak = max(peak, _process_memory_bytes(process_id) or 0)
            version = data.get("software", {}).get("version", version)
            case_findings.append([
                {"start": int(match["offset"]), "end": int(match["offset"] + match["length"]),
                 "message": match.get("message", ""), "rule": match.get("rule", {}).get("id", "unknown")}
                for match in data.get("matches", [])
            ])
    except Exception as error:
        return _unavailable("languagetool", f"local server unavailable: {type(error).__name__}: {error}")
    return {"engine": "languagetool", "status": "ok", "version": version, "backend": "local HTTP server",
            "device": "cpu", "settings": {"language": language, "endpoint": endpoint}, "case_findings": case_findings,
            "runtime_ms": (time.perf_counter() - started) * 1000,
            "peak_memory_bytes": peak or None,
            "memory_note": "local LanguageTool server peak working set" if process_id is not None else "server PID not supplied; memory not measured"}
