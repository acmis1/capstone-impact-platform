from __future__ import annotations

from typing import Any

from .schema import CORPUS_SCHEMA, ASSET_SUFFIX


CALIBRATION_SEED = 2026082603
CALIBRATION_TOPICS = (
    ("Adaptive Streetlight Demand Atlas", "street lighting", "evening demand", "lamp groups"),
    ("Library Study Zone Occupancy Map", "study zones", "desk counts", "quiet periods"),
    ("Coastal Path Shade Forecast", "coastal paths", "shade windows", "walking segments"),
    ("Community Battery Dispatch Ledger", "shared batteries", "dispatch windows", "energy bands"),
    ("Rain Garden Maintenance Planner", "rain gardens", "maintenance cues", "garden cells"),
    ("Local Food Pantry Route Board", "food routes", "delivery windows", "pantry stops"),
    ("Bicycle Crossing Delay Monitor", "cycle crossings", "delay samples", "crossing phases"),
    ("Classroom Airflow Balance Guide", "classroom airflow", "ventilation checks", "room zones"),
    ("Neighbourhood Heat Refuge Index", "heat refuges", "comfort readings", "refuge sites"),
    ("Water Tank Overflow Alert Panel", "water tanks", "overflow signals", "tank levels"),
    ("Urban Tree Nursery Stock Tracker", "tree nurseries", "stock tallies", "seedling groups"),
    ("Accessible Bus Stop Audit Map", "bus stops", "access checks", "audit locations"),
    ("Reuse Workshop Tool Queue", "workshop tools", "queue intervals", "tool stations"),
    ("Wetland Sensor Calibration Notes", "wetland sensors", "calibration readings", "sensor points"),
    ("Food Rescue Chiller Status v3", "food chillers", "status checks", "chiller units"),
    ("Stormwater Litter Capture Review", "stormwater traps", "capture totals", "drain sectors"),
    ("Community Hall Energy Baseline", "community halls", "energy baselines", "hall circuits"),
    ("Regional Trail Surface Risk Log", "regional trails", "surface observations", "trail sections"),
)


def _metadata(index: int, title: str) -> tuple[str, bool, list[str]]:
    if index == 0:
        return "Adaptive Trafficlight Demand Atlas", False, ["semantic_negative"]
    if index == 5:
        return "Local Food Pharmacy Route Board", False, ["semantic_negative"]
    if index == 8:
        return "Neighbourhood Fire Refuge Index", False, ["semantic_negative"]
    if index == 14:
        return "Food Rescue Chiller Status v4", False, ["number_version_negative"]
    if index == 2:
        return "Coastal Path: Shade Forecast", True, ["punctuation_only_variation"]
    if index == 15:
        return "Stormwater Litter-Capture Review", True, ["punctuation_only_variation"]
    return title, True, []


def _style(index: int) -> str:
    if index in {1, 7, 13}:
        return "wrapped"
    if index in {4, 10, 16}:
        return "multiline"
    if index in {6, 12}:
        return "shadow"
    return "plain"


def _feature(index: int) -> str:
    return ("table", "diagram", "none")[index % 3]


def _case(index: int, *, media: str, layout: str, difficulty: str) -> dict[str, Any]:
    title, subject, measure, units = CALIBRATION_TOPICS[index]
    metadata, agreement, relationship_tags = _metadata(index, title)
    columns = {"one_column": 1, "two_column": 2, "three_column": 3}[layout]
    headings = ("CONTEXT", "METHOD", "EVIDENCE")
    sections: list[list[dict[str, str]]] = [[] for _ in range(columns)]
    for position, heading in enumerate(headings):
        column = min(position, columns - 1)
        sections[column].append(
            {
                "heading": heading,
                "body": (
                    f"Synthetic calibration {index + 1:02d} describes {subject}; {measure} are grouped into "
                    f"bounded {units} for an offline assistive reading-order check."
                ),
            }
        )
    closing = [
        {
            "heading": f"LIMIT {position + 1}",
            "body": f"Column {position + 1} uses invented values only and leaves every decision to staff review.",
        }
        for position in range(columns)
    ]
    feature = _feature(index)
    if feature == "table":
        feature_heading = "SYNTHETIC SUMMARY TABLE: bounded local counts across each poster column for staff inspection"
        feature_items = [f"Band {position + 1}: {index + position + 3} invented records" for position in range(columns)]
        feature_caption = "Table caption: totals are illustrative, offline, and never participant evidence."
    elif feature == "diagram":
        feature_heading = "OFFLINE FLOW DIAGRAM: staged input moves through local checks before any staff review"
        feature_items = [f"Node {position + 1}: bounded {units}" for position in range(columns)]
        feature_caption = "Diagram caption: arrows carry no authority and extracted labels remain plain text."
    else:
        feature_heading, feature_items, feature_caption = "", [], ""
    top_controls = [f"PP1 SYNTHETIC BOARD {index + 1:02d}"] if index % 2 == 0 else ["OFFLINE REVIEW COPY"]
    distractors = []
    if index % 4 == 0:
        distractors.append({"position": "above", "text": "CAPSTONE EVIDENCE LAB"})
    if index % 5 == 0:
        distractors.append({"position": "near", "text": f"Display group {index + 11}"})
    tags = ["top_page_control", *relationship_tags]
    if _style(index) in {"wrapped", "multiline"}:
        tags.append("wrapped_or_multiline_title")
    if distractors:
        tags.append("distractor_heading")
    if feature == "table":
        tags.append("table")
    if feature == "diagram":
        tags.append("diagram_caption")
    if difficulty == "challenging":
        tags.extend(["low_contrast", "compression", "mild_noise", "small_body_text"])
    return {
        "id": f"ocr3-cal-{index + 1:03d}",
        "split": "calibration",
        "media": media,
        "layout": layout,
        "difficulty": difficulty,
        "title": title,
        "metadata_title": metadata,
        "expected_agreement": agreement,
        "title_style": _style(index),
        "tracking_px": 0.0,
        "contrast": "low" if difficulty == "challenging" else "high",
        "noise": "mild" if difficulty == "challenging" else "none",
        "jpeg_quality": 68 if difficulty == "challenging" else 88,
        "width": 1600,
        "height": 1100,
        "asset": f"ocr3-cal-{index + 1:03d}{ASSET_SUFFIX[media]}",
        "top_controls": top_controls,
        "distractors": distractors,
        "column_sections": sections,
        "feature": feature,
        "feature_heading": feature_heading,
        "feature_items": feature_items,
        "feature_caption": feature_caption,
        "closing_sections": closing,
        "tags": sorted(set(tags)),
    }


def build_calibration_corpus() -> dict[str, Any]:
    media = ("png", "jpeg", "scanned_pdf")
    layouts = ("one_column", "two_column", "three_column")
    cases = []
    index = 0
    for media_name in media:
        for layout in layouts:
            for difficulty in ("clean", "challenging"):
                cases.append(_case(index, media=media_name, layout=layout, difficulty=difficulty))
                index += 1
    warmup = _case(0, media="png", layout="one_column", difficulty="clean")
    warmup.update(
        {
            "id": "ocr3-warmup-001",
            "split": "warmup",
            "title": "Synthetic OCR Warmup Card",
            "metadata_title": "Synthetic OCR Warmup Card",
            "asset": "ocr3-warmup-001.png",
            "tags": ["top_page_control"],
        }
    )
    return {
        "schema_version": CORPUS_SCHEMA,
        "corpus_version": "pp1-ocr-iteration3-calibration-v1",
        "role": "calibration",
        "seed": CALIBRATION_SEED,
        "ocr_cases": [warmup, *cases],
        "native_controls": [
            {"id": "ocr3-cal-native-001", "title": "Native Coastal Asset Register", "body": "Synthetic born digital PDF control.", "layout": "one_column", "asset": "ocr3-cal-native-001.pdf"},
            {"id": "ocr3-cal-native-002", "title": "Native Workshop Queue Notes", "body": "Synthetic born digital two column control.", "layout": "two_column", "asset": "ocr3-cal-native-002.pdf"},
            {"id": "ocr3-cal-native-003", "title": "Native Wetland Review Sheet", "body": "Synthetic born digital three column control.", "layout": "three_column", "asset": "ocr3-cal-native-003.pdf"},
        ],
        "security_controls": [
            {"id": "ocr3-cal-security-001", "kind": "malformed_pdf", "asset": "ocr3-cal-security-001.pdf"},
            {"id": "ocr3-cal-security-002", "kind": "malformed_image", "asset": "ocr3-cal-security-002.png"},
        ],
    }
