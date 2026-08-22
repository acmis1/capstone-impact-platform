from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from pathlib import Path
from typing import Any

from PIL import ImageFont


CORPUS_VERSION = "pp1-ocr-productionization-corpus-v2"
SEED = 2026082201
SCORED_ID = re.compile(r"^ocr2-cal-[0-9]{3}$")
WARMUP_ID = "ocr2-warmup-001"
ALLOWED_MEDIA = {"png", "jpeg", "scanned_pdf"}
ALLOWED_LAYOUTS = {"one_column", "two_column", "three_column"}
ALLOWED_STYLES = {"plain", "wrapped", "tracked", "shadow", "outlined"}
REQUIRED_CORPUS_GLYPHS = {"é", "’", "–", "—", "₂"}
ALLOWED_DECISIONS = {
    "READY_TO_FREEZE_OCR_ITERATION_2_HOLDOUT_PROTOCOL",
    "NEEDS_OCR_MODEL_CHALLENGER",
    "NEEDS_MORE_OCR_CORPUS_CALIBRATION",
}
FROZEN_OPERATIONAL_CEILINGS = {
    "cold_start_ms_maximum": 30000,
    "p50_ms_maximum": 10000,
    "p95_ms_maximum": 20000,
    "peak_working_set_bytes_maximum": 4294967296,
    "artifact_footprint_bytes_maximum": 1073741824,
    "per_case_timeout_seconds": 90,
}


def tool_root() -> Path:
    return Path(__file__).resolve().parents[3]


def repository_root() -> Path:
    return tool_root().parents[1]


def data_root() -> Path:
    return tool_root() / "ocr-iteration2-calibration"


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path.name} must contain one JSON object")
    return value


def canonical_json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n").encode("utf-8")


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalized_text_file_sha256(path: Path) -> str:
    """Hash tracked text as LF so Git's Windows CRLF checkout does not change evidence identity."""
    return hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest()


def value_sha256(value: Any) -> str:
    return hashlib.sha256(canonical_json_bytes(value)).hexdigest()


def normalized_content_hash(title: str, body: str) -> str:
    text = unicodedata.normalize("NFKC", f"{title}\n{body}").casefold()
    return hashlib.sha256(" ".join(text.split()).encode("utf-8")).hexdigest()


def validate_protocol(value: dict[str, Any]) -> dict[str, Any]:
    if value.get("schema_version") != "pp1-ocr-iteration2-calibration-protocol/v1":
        raise ValueError("unsupported Iteration 2 calibration protocol")
    if value.get("corpus_version") != CORPUS_VERSION or value.get("seed") != SEED:
        raise ValueError("Iteration 2 protocol identity changed")
    if value.get("measurement_role") != "calibration_only":
        raise ValueError("Iteration 2 measurement role must be calibration_only")
    if value.get("independent_holdout") is not False or value.get("production_selection_authorized") is not False:
        raise ValueError("this protocol may not create a holdout or authorize production selection")
    if value.get("candidates") != ["tesseract", "paddle-tiny", "paddle-small", "paddle-medium"]:
        raise ValueError("only the already-provisioned OCR candidates are allowed")
    gate = value.get("development_gate", {})
    if (
        gate.get("exact_title_rate_minimum") != 0.9
        or gate.get("primary_mean_wer_maximum") != 0.15
        or gate.get("material_false_agreements_maximum") != 0
    ):
        raise ValueError("the development gate must remain 90% exact title, 15% WER, and zero false agreements")
    if gate.get("all_cases_execute_safely") is not True or gate.get("operational_plausibility_required") is not True:
        raise ValueError("the development gate must keep safe execution and operational plausibility required")
    if value.get("operational_ceilings") != FROZEN_OPERATIONAL_CEILINGS:
        raise ValueError("the frozen operational ceilings may not be loosened or removed")
    final_gate = value.get("future_holdout_gate", {})
    if (
        final_gate.get("exact_title_rate_minimum") != 0.95
        or final_gate.get("primary_mean_wer_maximum") != 0.12
        or final_gate.get("material_false_agreements_maximum") != 0
    ):
        raise ValueError("the future holdout gate must remain 95% exact title, 12% WER, and zero false agreements")
    ceilings = value.get("worker_safety_ceilings", {})
    configurations = value.get("raster_configurations", {})
    if set(configurations) != {"dpi150-edge960", "dpi180-edge1920"}:
        raise ValueError("the bounded two-configuration raster matrix changed")
    for name, configuration in configurations.items():
        dpi = configuration.get("raster_dpi")
        edge = configuration.get("max_input_dimension")
        if not isinstance(dpi, int) or dpi > ceilings.get("max_raster_dpi", 0):
            raise ValueError(f"{name} exceeds the production worker DPI ceiling")
        if not isinstance(edge, int) or edge <= 0 or edge * edge > ceilings.get("max_raster_pixels_per_page", 0):
            raise ValueError(f"{name} exceeds the production worker raster ceiling")
    if set(value.get("allowed_decisions", [])) != ALLOWED_DECISIONS:
        raise ValueError("calibration decision contract changed")
    return value


def _glyph_mask(font: ImageFont.FreeTypeFont, character: str) -> bytes:
    return bytes(font.getmask(character, mode="L"))


def validate_font_manifest(value: dict[str, Any]) -> dict[str, Any]:
    if value.get("schema_version") != "pp1-ocr-renderer-font/v1" or value.get("runtime_download") is not False:
        raise ValueError("renderer font manifest is invalid")
    root = data_root() / "font"
    font_path = root / str(value.get("file"))
    license_path = root / str(value.get("license_file"))
    if not font_path.is_file() or not license_path.is_file():
        raise ValueError("renderer font or license is missing")
    if font_path.stat().st_size != value.get("bytes") or font_path.stat().st_size > 1024 * 1024:
        raise ValueError("renderer font size is not the reviewed bounded value")
    if file_sha256(font_path) != value.get("sha256") or file_sha256(license_path) != value.get("license_sha256"):
        raise ValueError("renderer font or license hash changed")
    magic = font_path.read_bytes()[:4]
    if magic != b"\x00\x01\x00\x00" or magic in {b"MZ\x90\x00", b"\x7fELF", b"PK\x03\x04"}:
        raise ValueError("renderer input is not a bounded TrueType font")
    font = ImageFont.truetype(str(font_path), size=40)
    if font.getname() != (value.get("family"), value.get("style")):
        raise ValueError("renderer font identity changed")
    missing = _glyph_mask(font, "\u0378")
    required = value.get("required_glyphs")
    if not isinstance(required, list) or not required:
        raise ValueError("renderer glyph contract is empty")
    for glyph in required:
        if not isinstance(glyph, str) or len(glyph) != 1 or not _glyph_mask(font, glyph):
            raise ValueError(f"renderer glyph is empty: {glyph!r}")
        if _glyph_mask(font, glyph) == missing:
            raise ValueError(f"renderer substitutes a missing glyph for {glyph!r}")
    if "SIL OPEN FONT LICENSE Version 1.1" not in license_path.read_text(encoding="utf-8"):
        raise ValueError("renderer font license is not the recorded SIL OFL 1.1 text")
    return value


def _case_body(case: dict[str, Any]) -> str:
    return " ".join(str(section) for section in case["body_sections"])


def validate_corpus(value: dict[str, Any]) -> dict[str, Any]:
    if value.get("schema_version") != "pp1-ocr-iteration2-corpus-part/v1":
        raise ValueError("unsupported Iteration 2 corpus schema")
    if value.get("corpus_version") != CORPUS_VERSION or value.get("seed") != SEED:
        raise ValueError("Iteration 2 corpus identity changed")
    if value.get("part") != "calibration" or value.get("measurement_role") != "calibration_only":
        raise ValueError("Iteration 2 corpus must be calibration only")
    if value.get("independent_holdout") is not False:
        raise ValueError("Iteration 2 corpus must not claim holdout independence")
    cases = value.get("ocr_cases")
    if not isinstance(cases, list):
        raise ValueError("OCR cases must be a list")
    warmups = [case for case in cases if case.get("split") == "warmup"]
    scored = [case for case in cases if case.get("split") == "calibration"]
    if len(warmups) != 1 or warmups[0].get("id") != WARMUP_ID:
        raise ValueError("the corpus must contain exactly one named warm-up")
    if not 24 <= len(scored) <= 32:
        raise ValueError("the corrected corpus must contain 24-32 scored calibration cases")
    seen: set[str] = set()
    for case in cases:
        required = {
            "id", "split", "asset", "media", "layout", "difficulty", "width", "height", "title",
            "metadata_title", "expected_agreement", "body_sections", "title_style", "tracking_px",
            "contrast", "noise", "jpeg_quality", "tags",
        }
        if not isinstance(case, dict) or set(case) != required:
            raise ValueError("Iteration 2 case uses an unknown or missing field")
        case_id = case["id"]
        if case_id in seen or (case_id != WARMUP_ID and not SCORED_ID.fullmatch(str(case_id))):
            raise ValueError("Iteration 2 case ID is invalid or duplicated")
        seen.add(case_id)
        if "hold" in case_id.casefold() or case["split"] not in {"warmup", "calibration"}:
            raise ValueError("Iteration 2 holdout case IDs are forbidden")
        if case["media"] not in ALLOWED_MEDIA or case["layout"] not in ALLOWED_LAYOUTS:
            raise ValueError("case media or layout is unsupported")
        suffix = {"png": ".png", "jpeg": ".jpg", "scanned_pdf": ".pdf"}[case["media"]]
        if case["asset"] != f"{case_id}{suffix}":
            raise ValueError("case asset path is not deterministic")
        if case["difficulty"] not in {"clean", "challenging"} or case["title_style"] not in ALLOWED_STYLES:
            raise ValueError("case difficulty or title style is invalid")
        if not 640 <= case["width"] <= 2200 or not 480 <= case["height"] <= 1600:
            raise ValueError("case dimensions exceed the corrected corpus bounds")
        if not isinstance(case["body_sections"], list) or len(case["body_sections"]) != 3:
            raise ValueError("every poster must have three deterministic semantic sections")
        if not all(isinstance(item, str) and 20 <= len(item) <= 300 for item in case["body_sections"]):
            raise ValueError("poster body section text is outside its bounds")
        if not isinstance(case["title"], str) or not 15 <= len(case["title"]) <= 90:
            raise ValueError("poster title is outside its bounds")
        if "  " in case["title"]:
            raise ValueError("semantic title text may not encode visual tracking with repeated spaces")
        if case["title_style"] == "tracked":
            if not isinstance(case["tracking_px"], (int, float)) or not 0 < case["tracking_px"] <= 4:
                raise ValueError("tracked titles require bounded visual pixel tracking")
        elif case["tracking_px"] != 0:
            raise ValueError("non-tracked title styles must not carry tracking")
    if {case["media"] for case in scored} != ALLOWED_MEDIA or {case["layout"] for case in scored} != ALLOWED_LAYOUTS:
        raise ValueError("corrected corpus media/layout diversity is incomplete")
    if {case["difficulty"] for case in scored} != {"clean", "challenging"}:
        raise ValueError("corrected corpus must preserve clean and challenging cases")
    if sum(case["title_style"] == "outlined" for case in scored) != 1:
        raise ValueError("outlined title must remain an explicit one-case minority style")
    if sum(case["title_style"] == "plain" for case in scored) < len(scored) // 2:
        raise ValueError("ordinary unstroked titles must remain the corpus majority")
    corpus_text = "\n".join(case["title"] + " " + _case_body(case) for case in scored)
    missing = sorted(REQUIRED_CORPUS_GLYPHS - set(corpus_text))
    if missing:
        raise ValueError(f"corpus claims Unicode coverage but omits: {missing}")
    controls = value.get("native_controls")
    security = value.get("security_controls")
    if not isinstance(controls, list) or len(controls) < 2 or not isinstance(security, list) or len(security) != 2:
        raise ValueError("native and malformed/security controls are incomplete")
    return value


def corpus_novelty(corpus: dict[str, Any]) -> dict[str, Any]:
    scored = [case for case in corpus["ocr_cases"] if case["split"] == "calibration"]
    current = {
        case["id"]: normalized_content_hash(case["title"], _case_body(case))
        for case in scored
    }
    historical: dict[str, str] = {}
    phase0 = load_json(tool_root() / "corpus" / "manifest.json")
    for case in phase0["cases"]:
        if case.get("kind") == "document":
            historical[f"phase0:{case['id']}"] = normalized_content_hash(case["poster_title"], case["body"])
    old_root = tool_root() / "ocr-productionization" / "corpus"
    for part_name in ("calibration", "holdout"):
        part = load_json(old_root / f"{part_name}.json")
        for case in part["ocr_cases"]:
            if case["split"] in {"calibration", "holdout"}:
                historical[f"v1:{case['id']}"] = normalized_content_hash(case["title"], case["body"])
    reverse: dict[str, list[str]] = {}
    for identifier, digest in historical.items():
        reverse.setdefault(digest, []).append(identifier)
    reused = [
        {"case_id": case_id, "historical_ids": reverse[digest]}
        for case_id, digest in current.items()
        if digest in reverse
    ]
    return {
        "comparison_role": "corpus_novelty_non_reuse_not_holdout_independence",
        "scored_case_count": len(current),
        "historical_case_count": len(historical),
        "exact_title_body_reuse_count": len(reused),
        "reused_cases": reused,
    }


def verify_historical_evidence(protocol: dict[str, Any]) -> dict[str, str]:
    observed: dict[str, str] = {}
    for relative, expected in protocol["historical_evidence_sha256"].items():
        path = repository_root() / relative
        digest = normalized_text_file_sha256(path)
        if digest != expected:
            raise ValueError(f"historical evidence changed: {relative}")
        observed[relative] = digest
    return observed


def assert_no_holdout_artifacts() -> dict[str, Any]:
    root = data_root()
    package_root = Path(__file__).resolve().parent
    scoped_paths = [
        *root.rglob("*"),
        *package_root.rglob("*"),
        tool_root() / "tests" / "test_ocr_iteration2_calibration.py",
        repository_root() / "docs" / "assistive-validation" / "ocr-productionization-iteration2-calibration.md",
        repository_root() / "docs" / "assistive-validation" / "evidence" / "ocr-productionization-iteration2-calibration.json",
    ]
    files = sorted({path.resolve() for path in scoped_paths if path.is_file()})
    forbidden_files = [
        str(path)
        for path in files
        if path.name.casefold() == "holdout.json" or "ocr2-hold" in path.name.casefold()
    ]
    if forbidden_files:
        raise ValueError(f"Iteration 2 holdout artifacts are forbidden: {forbidden_files}")
    forbidden_text = {
        "Iteration 2 holdout case ID": re.compile(r"ocr2-hold-[0-9]{3}"),
        "final holdout metrics": re.compile(r'"final_holdout_metrics"\s*:'),
        "production selection authorization": re.compile(r'"production_selection_authorized"\s*:\s*true'),
        "production SELECT classification": re.compile(r'"production_select_classification"\s*:\s*true'),
    }
    for path in files:
        if path.suffix.casefold() not in {".py", ".json", ".md"}:
            continue
        text = path.read_text(encoding="utf-8")
        for label, pattern in forbidden_text.items():
            if pattern.search(text):
                raise ValueError(f"forbidden {label} in {path}")
    return {"independent_holdout": False, "holdout_artifact_count": 0, "scanned_file_count": len(files)}


def check_inputs() -> dict[str, Any]:
    protocol = validate_protocol(load_json(data_root() / "protocol.json"))
    font = validate_font_manifest(load_json(data_root() / "font" / "manifest.json"))
    corpus = validate_corpus(load_json(data_root() / "corpus" / "calibration.json"))
    novelty = corpus_novelty(corpus)
    if novelty["exact_title_body_reuse_count"] != 0:
        raise ValueError("corrected corpus exactly reuses historical title+body content")
    return {
        "protocol_sha256": value_sha256(protocol),
        "corpus_sha256": value_sha256(corpus),
        "font_sha256": font["sha256"],
        "calibration_case_count": novelty["scored_case_count"],
        "corpus_novelty": novelty,
        "historical_evidence": verify_historical_evidence(protocol),
        "no_holdout_assertion": assert_no_holdout_artifacts(),
    }
