"""Create exactly one synthetic fresh-holdout candidate before any OCR execution."""

from __future__ import annotations

import copy
import hashlib
import random
from pathlib import Path
from typing import Any

from ..ocr_iteration2_holdout_protocol.holdout_contract import (
    CASE_FIELDS,
    HOLDOUT_CORPUS_SCHEMA_VERSION,
    HOLDOUT_CORPUS_VERSION,
    NON_MATERIAL_NEGATIVE_KIND,
    SEMANTIC_RELATION_AUTHORITY,
    _validate_title_relationship,
    distractor_summary,
    holdout_non_reuse_evidence,
    title_text_coverage,
    validate_holdout_corpus,
)
from ..ocr_iteration2_holdout_protocol.manifest import (
    manifest_path,
    validate_freeze_commit_record,
    verify_candidate_artifacts,
    verify_freeze_manifest,
)
from ..ocr_iteration2_holdout_protocol.fingerprint import require_canonical_renderer
from ..ocr_iteration2_holdout_protocol.schema import (
    canonical_json_bytes,
    data_root as protocol_data_root,
    load_json,
    tool_root,
    validate_protocol,
    value_sha256,
)


STARTING_MAIN_SHA = "c0b175380fef5f328a9b079884c437300ea9b7a4"
SEED_INPUT = f"pp1-ocr-iteration2-fresh-holdout-v2|{STARTING_MAIN_SHA}"
SEED_DERIVATION_SHA256 = hashlib.sha256(SEED_INPUT.encode("utf-8")).hexdigest()
SEED_INTEGER_DERIVATION = "unsigned big-endian integer represented by the full 32-byte SHA-256 digest"
SEED = int(SEED_DERIVATION_SHA256, 16)

PREAPPROVAL_SCHEMA = "pp1-ocr-iteration2-holdout-preapproval/v1"
FIXTURE_PREFIX = "fixture2b3a"
REAL_PREFIX = "ocr2h"

DISTRACTOR_TEXT = {
    "school_or_faculty_masthead": "School of Computing and Engineering",
    "program_name": "Bachelor of Applied Technology",
    "discipline": "Discipline: Responsible Computing",
    "unit_or_course_code": "COSC2799 Capstone Studio",
    "year_or_date": "Synthetic Showcase 2026",
    "supervisor_label": "Supervisor Review Copy",
    "category_or_tag": "Category: Community Systems",
    "event_or_showcase_heading": "Future Systems Poster Showcase",
    "team_label": "Team: Offline Prototype Lab",
}
DISTRACTOR_KINDS = tuple(DISTRACTOR_TEXT)

TITLES = (
    "Coastal Sensor Ledger",
    "Café Queue Balance Monitor",
    "Urban Heat Island Mapper",
    "Circular Textile Exchange Planner",
    "Wetland Habitat Recovery Atlas",
    "Accessible Campus Navigation Guide",
    "Battery Reuse Lab Version 2",
    "Night Bus Demand Route N7",
    "Farmer’s Waterwise Advisory Tool",
    "Drone-to-GIS Survey Dashboard",
    "CO₂ Classroom Comfort Index",
    "Réseau Bicycle Safety Explorer",
    "Bushfire Alert — Community Drill",
    "Microgrid Load-Sharing Console",
    "Harbour Plastics Audit: 2026",
    "Secure API Gateway Observatory",
    "Tram Stop Accessibility Map",
    "TinyML Acoustic Leak Sentinel",
    "Biodiversity eDNA Sampling Log",
    "Australian Kerbside Sorting Coach",
    "Solar Inverter Fault Triage",
    "Library Occupancy – Privacy First",
    "Rainwater Tank Forecast v4",
    "Low-Cost Air Quality Beacon",
    "Inclusive Sports Scheduling Hub",
    "Regional Telehealth Queue Simulator",
    "Quantum-Safe Key Rotation Lab",
    "Food Rescue Cold-Chain Tracker",
    "Floodplain Evacuation Route Sketch",
    "Reef Temperature Anomaly Notebook",
    "Smart Meter Demand-Shifting Adviser",
    "Community Battery Sharing Sandbox",
    "Agricultural Drone Boundary Checker",
    "Multilingual Museum Wayfinding Board",
    "Urban Tree Canopy Change Viewer",
    "Water Sensitive Design Scorecard",
    "Cyclist Near-Miss Pattern Atlas",
    "Offline Disaster Supply Register",
    "Assistive Caption Timing Workbench",
    "Satellite Crop Stress Mosaic",
)

METADATA_OVERRIDES = {
    0: ("Coastal Sensor Ledge", "one_character_material"),
    1: ("Café Queue Balanc Monitor", "one_character_material"),
    2: ("Urban Heat Island Monitor", "one_word_material"),
    3: ("Circular Textile Exchange Tracker", "one_word_material"),
    4: ("Wetland Restoration Planning Map", "semantically_related_incorrect"),
    5: ("Inclusive Wayfinding Support Manual", "semantically_related_incorrect"),
    6: ("Battery Reuse Lab Version 3", "number_or_version"),
    7: ("Night Bus Demand Route N8", "number_or_version"),
    8: ("Farmer's Waterwise Advisory Tool", NON_MATERIAL_NEGATIVE_KIND),
    9: ("Drone–to–GIS Survey Dashboard", NON_MATERIAL_NEGATIVE_KIND),
}

PROPOSED_SEMANTIC_RATIONALES = {
    4: (
        "Both titles concern planned wetland improvement, but habitat recovery evidence is not "
        "the same project title as a restoration planning map."
    ),
    5: (
        "Both titles concern accessible wayfinding, but a campus navigation guide is materially "
        "different from an inclusive support manual."
    ),
}

WRAPPED_INDEXES = {5, 12, 24, 25, 33, 38}
TRACKED_INDEXES = {10, 17, 31}
SHADOW_INDEXES = {14, 28, 34}
OUTLINED_INDEXES = {20, 36}


def data_root() -> Path:
    return tool_root() / "ocr-iteration2-fresh-holdout"


def corpus_path() -> Path:
    return data_root() / "corpus" / "holdout.json"


def preapproval_path() -> Path:
    return data_root() / "pre-approval.json"


def _style(index: int) -> tuple[str, float]:
    if index in WRAPPED_INDEXES:
        return "wrapped", 0
    if index in TRACKED_INDEXES:
        return "tracked", (1.5, 2.0, 2.5)[sorted(TRACKED_INDEXES).index(index)]
    if index in SHADOW_INDEXES:
        return "shadow", 0
    if index in OUTLINED_INDEXES:
        return "outlined", 0
    return "plain", 0


def _structural_slots(seed: int) -> list[dict[str, Any]]:
    media = {
        "clean": ["png"] * 7 + ["jpeg"] * 6 + ["scanned_pdf"] * 7,
        "challenging": ["png"] * 7 + ["jpeg"] * 7 + ["scanned_pdf"] * 6,
    }
    layouts = {
        "clean": ["one_column"] * 7 + ["two_column"] * 6 + ["three_column"] * 7,
        "challenging": ["one_column"] * 7 + ["two_column"] * 7 + ["three_column"] * 6,
    }
    slots: list[dict[str, Any]] = []
    for global_index in range(40):
        difficulty = "clean" if global_index % 2 == 0 else "challenging"
        local_index = global_index // 2
        distractors = []
        if global_index < 32:
            kind = DISTRACTOR_KINDS[global_index % len(DISTRACTOR_KINDS)]
            distractors.append({"kind": kind, "text": DISTRACTOR_TEXT[kind], "position": "above"})
        if global_index < 16:
            kind = DISTRACTOR_KINDS[(global_index + 4) % len(DISTRACTOR_KINDS)]
            distractors.append({"kind": kind, "text": DISTRACTOR_TEXT[kind], "position": "near"})
        challenging = difficulty == "challenging"
        tags = []
        if challenging and local_index < 6:
            tags.append("low_resolution")
        if challenging and 6 <= local_index < 12:
            tags.append("small_body_text")
        slots.append(
            {
                "difficulty": difficulty,
                "media": media[difficulty][local_index],
                "layout": layouts[difficulty][local_index],
                "width": 900 if "low_resolution" in tags else 1600,
                "height": 650 if "low_resolution" in tags else 1100,
                "contrast": "low" if challenging and local_index < 4 else "medium" if challenging and local_index < 12 else "high",
                "noise": "mild" if challenging and local_index < 6 else "none",
                "jpeg_quality": 72 if challenging else 90,
                "distractors": distractors,
                "tags": tags,
            }
        )
    random.Random(seed).shuffle(slots)
    return slots


def _body_sections(title: str, index: int) -> list[str]:
    return [
        f"A wholly fictional scenario explores {title.lower()} with synthetic observations prepared only for this benchmark.",
        f"Offline method {index + 1:02d} groups bounded invented samples and reports advisory patterns without external services.",
        "The evidence uses no real participant, student, project, organisation, account, operational site, or private record.",
    ]


def _case(prefix: str, index: int, slot: dict[str, Any]) -> dict[str, Any]:
    title = TITLES[index]
    metadata_title, negative_kind = METADATA_OVERRIDES.get(index, (title, None))
    style, tracking = _style(index)
    tags = list(slot["tags"])
    if index in {1, 8, 19, 35}:
        tags.append("australian_english")
    if index in {9, 10, 15, 17, 18, 26}:
        tags.append("technical_vocabulary")
    if index == 10:
        tags.append("subscript")
    case_id = f"{prefix}-{index + 1:03d}"
    return {
        "id": case_id,
        "split": "holdout",
        "asset": f"{case_id}.{'jpg' if slot['media'] == 'jpeg' else 'pdf' if slot['media'] == 'scanned_pdf' else 'png'}",
        "media": slot["media"],
        "layout": slot["layout"],
        "difficulty": slot["difficulty"],
        "width": slot["width"],
        "height": slot["height"],
        "title": title,
        "metadata_title": metadata_title,
        "expected_agreement": negative_kind not in {
            "one_character_material",
            "one_word_material",
            "semantically_related_incorrect",
            "number_or_version",
        },
        "negative_kind": negative_kind,
        "negative_relation_evidence": None,
        "body_sections": _body_sections(title, index),
        "title_style": style,
        "tracking_px": tracking,
        "contrast": slot["contrast"],
        "noise": slot["noise"],
        "jpeg_quality": slot["jpeg_quality"],
        "distractors": slot["distractors"],
        "tags": tags,
    }


def _warmup(prefix: str) -> dict[str, Any]:
    case_id = f"{prefix}-warmup-001"
    return {
        "id": case_id,
        "split": "warmup",
        "asset": f"{case_id}.png",
        "media": "png",
        "layout": "one_column",
        "difficulty": "clean",
        "width": 1200,
        "height": 800,
        "title": "Synthetic OCR Warm-Up Card",
        "metadata_title": "Synthetic OCR Warm-Up Card",
        "expected_agreement": True,
        "negative_kind": None,
        "negative_relation_evidence": None,
        "body_sections": [
            "This unscored synthetic card prepares the frozen model before measured cases begin.",
            "The content is deterministic, offline, bounded, and excluded from every quality percentage.",
            "No participant, project, account, private record, or operational decision is represented.",
        ],
        "title_style": "plain",
        "tracking_px": 0,
        "contrast": "high",
        "noise": "none",
        "jpeg_quality": 90,
        "distractors": [],
        "tags": [],
    }


def build_candidate(*, prefix: str, seed: int = SEED) -> dict[str, Any]:
    """Build one deterministic corpus in memory; callers control whether it is persisted."""
    slots = _structural_slots(seed)
    return {
        "schema_version": HOLDOUT_CORPUS_SCHEMA_VERSION,
        "corpus_version": HOLDOUT_CORPUS_VERSION,
        "part": "holdout",
        "measurement_role": "independent_holdout",
        "independent_holdout": True,
        "content_policy": "entirely_synthetic_no_real_participant_or_project_data",
        "seed_input": SEED_INPUT,
        "seed_derivation_sha256": SEED_DERIVATION_SHA256,
        "seed_integer_derivation": SEED_INTEGER_DERIVATION,
        "seed": seed,
        "ocr_cases": [_case(prefix, index, slot) for index, slot in enumerate(slots)] + [_warmup(prefix)],
        "native_controls": [
            {
                "id": f"{prefix}-native-{index:03d}",
                "asset": f"{prefix}-native-{index:03d}.pdf",
                "title": f"Synthetic Native PDF Control {index}",
                "body": "Selectable native text verifies the non-OCR control path with invented content only.",
                "layout": ("one_column", "two_column", "three_column")[index - 1],
            }
            for index in range(1, 4)
        ],
        "security_controls": [
            {"id": f"{prefix}-security-001", "asset": f"{prefix}-security-001.pdf", "kind": "malformed_pdf"},
            {"id": f"{prefix}-security-002", "asset": f"{prefix}-security-002.png", "kind": "truncated_image"},
        ],
    }


def _scored(corpus: dict[str, Any]) -> list[dict[str, Any]]:
    return [case for case in corpus["ocr_cases"] if case["split"] == "holdout"]


def allocation_summary(corpus: dict[str, Any]) -> dict[str, Any]:
    scored = _scored(corpus)

    def counts(key: str) -> dict[str, int]:
        return {value: sum(case[key] == value for case in scored) for value in sorted({case[key] for case in scored})}

    def cells(key: str) -> dict[str, int]:
        result: dict[str, int] = {}
        for case in scored:
            cell = f"{case[key]}/{case['difficulty']}"
            result[cell] = result.get(cell, 0) + 1
        return result

    return {
        "scored_case_count": len(scored),
        "warmup_count": sum(case["split"] == "warmup" for case in corpus["ocr_cases"]),
        "media": counts("media"),
        "layout": counts("layout"),
        "difficulty": counts("difficulty"),
        "media_difficulty_cells": cells("media"),
        "layout_difficulty_cells": cells("layout"),
        "title_style": counts("title_style"),
        "distractors": distractor_summary(scored),
        "title_text_coverage": title_text_coverage(scored),
        "degradation": {
            "low_resolution": sum("low_resolution" in case["tags"] for case in scored),
            "moderate_compression": sum(
                case["media"] == "jpeg" and 40 <= case["jpeg_quality"] <= 80 for case in scored
            ),
            "mild_noise": sum(case["noise"] == "mild" for case in scored),
            "medium_or_low_contrast": sum(case["contrast"] in {"medium", "low"} for case in scored),
            "small_body_text": sum("small_body_text" in case["tags"] for case in scored),
        },
        "negative_kind": {
            value: sum(case["negative_kind"] == value for case in scored)
            for value in sorted({case["negative_kind"] for case in scored if case["negative_kind"] is not None})
        },
        "native_control_count": len(corpus["native_controls"]),
        "security_control_count": len(corpus["security_controls"]),
    }


def _relationship_preview(case: dict[str, Any], rationale: str | None) -> None:
    candidate = copy.deepcopy(case)
    if candidate["negative_kind"] == "semantically_related_incorrect":
        if not rationale:
            raise ValueError("semantic case is missing its proposed rationale")
        candidate["negative_relation_evidence"] = {
            "authority": SEMANTIC_RELATION_AUTHORITY,
            "classified_before_ocr": True,
            "rationale": rationale,
        }
    _validate_title_relationship(candidate)


def validate_fixture_allocation(corpus: dict[str, Any], protocol: dict[str, Any]) -> dict[str, Any]:
    """Validate the non-holdout fixture namespace before any real case is persisted."""
    scored = _scored(corpus)
    if not all(case["id"].startswith(f"{FIXTURE_PREFIX}-") for case in corpus["ocr_cases"]):
        raise ValueError("test allocation must stay in the fixture namespace")
    if any(set(case) != CASE_FIELDS for case in corpus["ocr_cases"]):
        raise ValueError("fixture case field set differs from the frozen schema")
    for index, case in enumerate(scored):
        _relationship_preview(case, PROPOSED_SEMANTIC_RATIONALES.get(index))
    summary = allocation_summary(corpus)
    distribution = protocol["holdout_distribution"]
    if summary["scored_case_count"] != 40 or summary["warmup_count"] != 1:
        raise ValueError("fixture case or warm-up count differs from the frozen contract")
    for key in ("media", "layout", "difficulty"):
        if summary[key] != distribution[key]:
            raise ValueError(f"fixture {key} distribution differs from the frozen contract")
    if min(summary["media_difficulty_cells"].values()) < distribution["minimum_cases_per_media_difficulty_cell"]:
        raise ValueError("fixture media/difficulty floor is not satisfied")
    if min(summary["layout_difficulty_cells"].values()) < distribution["minimum_cases_per_layout_difficulty_cell"]:
        raise ValueError("fixture layout/difficulty floor is not satisfied")
    distractors = summary["distractors"]
    distractor_contract = protocol["upper_page_distractors"]
    floor_mapping = {
        "cases_with_any_distractor": "cases_with_any_distractor_minimum",
        "cases_with_distractor_above_title": "cases_with_distractor_above_title_minimum",
        "cases_with_distractor_near_title": "cases_with_distractor_near_title_minimum",
        "cases_with_both_above_and_near": "cases_with_both_above_and_near_minimum",
    }
    for observed, required in floor_mapping.items():
        if distractors[observed] < distractor_contract[required]:
            raise ValueError(f"fixture distractor floor is not satisfied: {observed}")
    if distractors["cases_with_title_as_topmost_region"] > distractor_contract["cases_with_title_as_topmost_region_maximum"]:
        raise ValueError("fixture topmost-title ceiling is exceeded")
    if any(distractors["kinds"][kind] < floor for kind, floor in distractor_contract["required_kinds"].items()):
        raise ValueError("fixture distractor-kind floor is not satisfied")
    if not all(summary["title_text_coverage"].values()):
        raise ValueError("fixture title coverage is incomplete")
    style = summary["title_style"]
    style_contract = protocol["title_style_coverage"]
    for name, key in (("plain", "plain_minimum"), ("wrapped", "wrapped_minimum"), ("tracked", "tracked_minimum"), ("shadow", "shadow_minimum")):
        if style.get(name, 0) < style_contract[key]:
            raise ValueError(f"fixture title style is under-represented: {name}")
    if style.get("outlined", 0) > style_contract["outlined_maximum"]:
        raise ValueError("fixture outlined title ceiling is exceeded")
    degradation = summary["degradation"]
    for observed, required in (
        ("low_resolution", "low_resolution_minimum"),
        ("moderate_compression", "moderate_compression_minimum"),
        ("mild_noise", "mild_noise_minimum"),
        ("medium_or_low_contrast", "medium_or_low_contrast_minimum"),
        ("small_body_text", "small_body_text_minimum"),
    ):
        if degradation[observed] < protocol["degradation_coverage"][required]:
            raise ValueError(f"fixture degradation floor is not satisfied: {observed}")
    negatives = summary["negative_kind"]
    for kind, floor in protocol["material_title_negatives"]["required_kinds"].items():
        if negatives.get(kind, 0) < floor:
            raise ValueError(f"fixture negative floor is not satisfied: {kind}")
    if negatives.get(NON_MATERIAL_NEGATIVE_KIND, 0) < 2:
        raise ValueError("fixture punctuation controls are incomplete")
    if summary["native_control_count"] < 3 or summary["security_control_count"] < 2:
        raise ValueError("fixture controls are incomplete")
    return summary


def semantic_review_cases(corpus: dict[str, Any]) -> list[dict[str, str]]:
    result = []
    for index, case in enumerate(_scored(corpus)):
        if case["negative_kind"] == "semantically_related_incorrect":
            result.append(
                {
                    "case_id": case["id"],
                    "poster_title": case["title"],
                    "metadata_title": case["metadata_title"],
                    "proposed_rationale": PROPOSED_SEMANTIC_RATIONALES[index],
                }
            )
    return result


def preapproval_payload(corpus: dict[str, Any]) -> dict[str, Any]:
    payload = copy.deepcopy(corpus)
    for case in payload["ocr_cases"]:
        if case["negative_kind"] == "semantically_related_incorrect":
            case["negative_relation_evidence"] = None
    return payload


def preapproval_corpus_sha256(corpus: dict[str, Any]) -> str:
    return value_sha256(preapproval_payload(corpus))


def validate_real_preapproval(corpus: dict[str, Any], protocol: dict[str, Any]) -> dict[str, Any]:
    semantic = semantic_review_cases(corpus)
    if len(semantic) != 2:
        raise ValueError("the candidate must contain exactly two pending semantic-review cases")
    preview = copy.deepcopy(corpus)
    rationale_by_id = {item["case_id"]: item["proposed_rationale"] for item in semantic}
    for case in preview["ocr_cases"]:
        if case["negative_kind"] == "semantically_related_incorrect":
            if case["negative_relation_evidence"] is not None:
                raise ValueError("pre-approval corpus may not persist human relation authority")
            case["negative_relation_evidence"] = {
                "authority": SEMANTIC_RELATION_AUTHORITY,
                "classified_before_ocr": True,
                "rationale": rationale_by_id[case["id"]],
            }
    frozen_summary = validate_holdout_corpus(preview, protocol)
    return {
        "frozen_contract_preview": "PASS",
        "human_ground_truth_status": "AWAITING_APPROVAL",
        "semantic_case_count": len(semantic),
        "summary": frozen_summary,
    }


def preflight() -> dict[str, Any]:
    protocol = validate_protocol(load_json(protocol_data_root() / "protocol.json"))
    freeze = verify_freeze_manifest(load_json(manifest_path()))
    freeze_commit = validate_freeze_commit_record(load_json(protocol_data_root() / "freeze-commit.json"))
    renderer = require_canonical_renderer()
    candidate = verify_candidate_artifacts(protocol, tool_root() / "artifacts" / "ocr-provisioning" / "models")
    return {
        "protocol": protocol,
        "freeze": freeze,
        "freeze_commit": freeze_commit,
        "renderer": renderer,
        "candidate": candidate,
    }


def create_and_lock_candidate() -> dict[str, Any]:
    """Persist the one real candidate exactly once, with no human authority and no assets."""
    if data_root().exists():
        raise ValueError("fresh holdout candidate path already exists; refusing to regenerate")
    checked = preflight()
    fixture = build_candidate(prefix=FIXTURE_PREFIX)
    validate_fixture_allocation(fixture, checked["protocol"])
    corpus = build_candidate(prefix=REAL_PREFIX)
    validation = validate_real_preapproval(corpus, checked["protocol"])
    freshness = holdout_non_reuse_evidence(corpus)
    if freshness["exact_title_body_reuse_count"] != 0 or freshness["real_participant_or_project_data"] is not False:
        raise ValueError("fresh candidate failed the frozen non-reuse or synthetic-content rule")
    review = semantic_review_cases(corpus)
    record = {
        "schema_version": PREAPPROVAL_SCHEMA,
        "protocol_version": checked["protocol"]["protocol_version"],
        "corpus_version": corpus["corpus_version"],
        "corpus_schema_version": corpus["schema_version"],
        "starting_main_sha": STARTING_MAIN_SHA,
        "seed_input": SEED_INPUT,
        "seed_derivation_sha256": SEED_DERIVATION_SHA256,
        "seed_integer_derivation": SEED_INTEGER_DERIVATION,
        "seed": SEED,
        "preapproval_corpus_sha256": preapproval_corpus_sha256(corpus),
        "contract_validation": validation,
        "semantic_review_cases": review,
        "semantic_review_status": "awaiting_human_ground_truth",
        "corpus_will_not_be_regenerated_after_approval": True,
        "non_reuse_preview": freshness,
        "ocr_run_count": 0,
        "ocr_executed": False,
        "holdout_result_exists": False,
    }
    (data_root() / "corpus").mkdir(parents=True, exist_ok=False)
    corpus_path().write_bytes(canonical_json_bytes(corpus))
    preapproval_path().write_bytes(canonical_json_bytes(record))
    return record
