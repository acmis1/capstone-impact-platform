"""Deterministic failure classification and WER decomposition.

Categories are computed from evidence, never assigned by intuition. Each per-case record
carries the raw signals (oracle coverage, best group similarity, per-ordering WER) that
produced its category, so any reviewer can re-derive the classification independently.
"""

from __future__ import annotations

from typing import Any

from ..core import levenshtein_distance, normalize_metric_text
from .ordering import apply_order
from .selectors import similarity, title_oracle


# A group is treated as "the title region, imperfectly transcribed" at or above this
# normalized similarity, and as "the title is not present" below it. The per-case
# best_group_similarity is stored so the boundary can be re-audited without a rerun.
RECOGNITION_SIMILARITY_FLOOR = 0.70

# A reading order materially changes whole-page WER when it moves it by at least this much.
MATERIAL_WER_DELTA = 0.05

CATEGORIES = (
    "TITLE_EXACT",
    "A_TITLE_ABSENT",
    "B_SELECTOR_MISS",
    "C_RECOGNITION_ERROR",
    "D_READING_ORDER",
    "E_RESOLUTION_SENSITIVE",
    "F_OTHER",
)


def reference_text(case: dict[str, Any]) -> str:
    """The merged v1 whole-page reference string, reproduced exactly."""
    columns = {"one_column": 1, "two_column": 2, "three_column": 3}[case["layout"]]
    headings = " ".join(["BACKGROUND", "METHOD", "EVIDENCE"][:columns])
    return f"{case['title']}\n{headings}\n{case['body']}"


def edit_counts(reference: str, hypothesis: str) -> dict[str, Any]:
    """The merged v1 CER/WER arithmetic, reproduced exactly."""
    normalized_reference = normalize_metric_text(reference)
    normalized_hypothesis = normalize_metric_text(hypothesis)
    reference_words = normalized_reference.split()
    hypothesis_words = normalized_hypothesis.split()
    character_edits = levenshtein_distance(normalized_reference, normalized_hypothesis)
    word_edits = levenshtein_distance(reference_words, hypothesis_words)
    return {
        "character_edits": character_edits,
        "reference_characters": len(normalized_reference),
        "cer": character_edits / max(1, len(normalized_reference)),
        "word_edits": word_edits,
        "reference_words": len(reference_words),
        "wer": word_edits / max(1, len(reference_words)),
    }


def order_text(blocks: list[dict[str, Any]], order: str) -> str:
    return "\n".join(
        text for text in (" ".join(str(block.get("text") or "").split()) for block in apply_order(blocks, order)) if text
    )


def wer_decomposition(case: dict[str, Any], blocks: list[dict[str, Any]]) -> dict[str, Any]:
    """Whole-page WER under provider order, geometry order and bounded column order."""
    reference = reference_text(case)
    orders = {name: edit_counts(reference, order_text(blocks, name)) for name in ("raw", "geometry", "column")}
    best = min(orders, key=lambda name: (orders[name]["wer"], name))
    return {
        "raw_wer": orders["raw"]["wer"],
        "geometry_wer": orders["geometry"]["wer"],
        "column_wer": orders["column"]["wer"],
        "raw_cer": orders["raw"]["cer"],
        "geometry_cer": orders["geometry"]["cer"],
        "column_cer": orders["column"]["cer"],
        "best_order": best,
        "best_wer": orders[best]["wer"],
        "reading_order_gain": orders["raw"]["wer"] - orders[best]["wer"],
        "reading_order_material": orders["raw"]["wer"] - orders[best]["wer"] >= MATERIAL_WER_DELTA,
    }


def classify(case: dict[str, Any], blocks: list[dict[str, Any]]) -> dict[str, Any]:
    """Classify one engine/case observation into the evidence-backed failure taxonomy.

    Precedence is fixed and documented:

    1. The title is recovered by the current top-1 selector -> ``TITLE_EXACT``, unless a
       bounded reading order materially reduces whole-page WER, which is ``D_READING_ORDER``.
    2. Otherwise the title *is* recoverable from the OCR output -> ``B_SELECTOR_MISS``.
    3. Otherwise the title region was transcribed close enough to be recognisable ->
       ``C_RECOGNITION_ERROR``.
    4. Otherwise the title is not in the OCR output at all -> ``A_TITLE_ABSENT``.

    ``E_RESOLUTION_SENSITIVE`` is not decidable from a single configuration; it is applied
    later by :func:`apply_resolution_sensitivity` across the configuration matrix.
    """
    oracle = title_oracle(blocks, case["title"])
    decomposition = wer_decomposition(case, blocks)
    if oracle["top1"]:
        category = "D_READING_ORDER" if decomposition["reading_order_material"] else "TITLE_EXACT"
    elif oracle["recoverable"]:
        category = "B_SELECTOR_MISS"
    elif oracle["best_group_similarity"] >= RECOGNITION_SIMILARITY_FLOOR:
        category = "C_RECOGNITION_ERROR"
    elif blocks:
        category = "A_TITLE_ABSENT"
    else:
        category = "F_OTHER"
    return {
        "case_id": case["id"],
        "split": case["split"],
        "media": case["media"],
        "layout": case["layout"],
        "difficulty": case["difficulty"],
        "tags": list(case["tags"]),
        "category": category,
        "baseline_category": category,
        "block_count": len(blocks),
        "title_exact": oracle["top1"],
        "oracle": oracle,
        "wer": decomposition,
    }


def apply_resolution_sensitivity(
    baseline: list[dict[str, Any]],
    comparisons: dict[str, dict[str, bool]],
) -> list[dict[str, Any]]:
    """Promote recognition/absence failures that a different raster configuration repairs.

    ``comparisons`` maps a configuration id to ``{case_id: title_exact}``. A case only
    becomes ``E_RESOLUTION_SENSITIVE`` when the failure materially changes under a
    deterministic resolution change, which is exactly the evidence category E requires.
    """
    resolved = []
    for record in baseline:
        updated = dict(record)
        if record["baseline_category"] in {"A_TITLE_ABSENT", "C_RECOGNITION_ERROR"}:
            repaired = sorted(
                config for config, outcomes in comparisons.items() if outcomes.get(record["case_id"]) is True
            )
            if repaired:
                updated["category"] = "E_RESOLUTION_SENSITIVE"
                updated["repaired_by_configurations"] = repaired
        resolved.append(updated)
    return resolved


def category_counts(records: list[dict[str, Any]], key: str = "category") -> dict[str, int]:
    return {category: sum(record[key] == category for record in records) for category in CATEGORIES}
