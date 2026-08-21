from __future__ import annotations

import statistics
import time
from typing import Any

from ..core import rank_duplicate_candidates

DUPLICATE_RELATIONSHIPS = {"EXACT_DUPLICATE", "NEAR_DUPLICATE"}


def _project_text(project: dict[str, str]) -> str:
    """Phase 0 lexical input reproduced over the actual prose fields available on main."""
    return "\n".join(project[field] for field in ("summary", "background", "solution"))


def _percentile(values: list[float], percentile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = (len(ordered) - 1) * percentile
    lower = int(index)
    upper = min(lower + 1, len(ordered) - 1)
    fraction = index - lower
    return ordered[lower] * (1 - fraction) + ordered[upper] * fraction


def rank_phase6_query(query: dict[str, Any], candidates: list[dict[str, str]]) -> list[dict[str, Any]]:
    """Rank without exposing relationship labels to the Phase 0 lexical scorer."""
    ranked = rank_duplicate_candidates({
        "query_title": query["title"],
        "query_text": _project_text(query),
        "candidates": [{
            "id": candidate["id"],
            "title": candidate["title"],
            "text": _project_text(candidate),
            "relevant": False,
        } for candidate in candidates],
    })
    for item in ranked:
        item.pop("relevant", None)
        item.pop("relation", None)
    return ranked


def _aggregate(records: list[dict[str, Any]]) -> dict[str, Any]:
    count = len(records)
    exact_records = [record for record in records if record["duplicate_relationship"] == "EXACT_DUPLICATE"]
    return {
        "query_count": count,
        "exact_query_count": len(exact_records),
        "exact_duplicate_detection": (
            sum(record["exact_detected"] for record in exact_records) / len(exact_records) if exact_records else None
        ),
        "recall_at_1": sum(record["duplicate_rank"] <= 1 for record in records) / count if count else None,
        "recall_at_3": sum(record["duplicate_rank"] <= 3 for record in records) / count if count else None,
        "recall_at_5": sum(record["duplicate_rank"] <= 5 for record in records) / count if count else None,
        "candidate_precision_at_3": sum(record["duplicate_rank"] <= 3 for record in records) / (count * 3) if count else None,
        "candidate_precision_at_5": sum(record["duplicate_rank"] <= 5 for record in records) / (count * 5) if count else None,
        "average_irrelevant_candidates_at_3": (
            sum(3 - int(record["duplicate_rank"] <= 3) for record in records) / count if count else None
        ),
        "average_irrelevant_candidates_at_5": (
            sum(5 - int(record["duplicate_rank"] <= 5) for record in records) / count if count else None
        ),
        "queries_missed_at_5": sum(record["duplicate_rank"] > 5 for record in records),
        "related_not_duplicate_in_top_5": sum(record["related_not_duplicate_top_5"] for record in records),
        "average_related_not_duplicate_in_top_5": (
            sum(record["related_not_duplicate_top_5"] for record in records) / count if count else None
        ),
        "queries_where_related_outranks_duplicate": sum(record["related_outranks_duplicate"] for record in records),
        "related_outranks_duplicate_rate": (
            sum(record["related_outranks_duplicate"] for record in records) / count if count else None
        ),
        "worst_duplicate_rank": max((record["duplicate_rank"] for record in records), default=None),
    }


def evaluate_lexical_duplicates(
    queries: list[dict[str, Any]], candidates: list[dict[str, str]]
) -> dict[str, Any]:
    records: list[dict[str, Any]] = []
    runtimes: list[float] = []
    for query in queries:
        started = time.perf_counter()
        ranking = rank_phase6_query(query, candidates)
        runtimes.append((time.perf_counter() - started) * 1000)
        relationships = query["relationships"]
        duplicate_id = next(candidate_id for candidate_id, relationship in relationships.items()
                            if relationship in DUPLICATE_RELATIONSHIPS)
        duplicate_relationship = relationships[duplicate_id]
        duplicate_rank = next(index for index, item in enumerate(ranking, start=1) if item["id"] == duplicate_id)
        duplicate_item = ranking[duplicate_rank - 1]
        top5 = ranking[:5]
        related_ranks = [index for index, item in enumerate(ranking, start=1)
                         if relationships[item["id"]] == "RELATED_NOT_DUPLICATE"]
        records.append({
            "query_id": query["id"],
            "split": query["split"],
            "transformation": query["transformation"],
            "duplicate_id": duplicate_id,
            "duplicate_relationship": duplicate_relationship,
            "duplicate_rank": duplicate_rank,
            "duplicate_score": duplicate_item["score"],
            "exact_detected": bool(duplicate_item["exact_hash"] or duplicate_item["normalized_title_equal"]),
            "related_not_duplicate_top_5": sum(relationships[item["id"]] == "RELATED_NOT_DUPLICATE" for item in top5),
            "related_outranks_duplicate": min(related_ranks) < duplicate_rank,
            "top_5": [{
                "candidate_id": item["id"],
                "score": item["score"],
                "relationship": relationships[item["id"]],
            } for item in top5],
        })
    by_split = {
        split: _aggregate([record for record in records if record["split"] == split])
        for split in ("calibration", "holdout")
    }
    overall = _aggregate(records)
    holdout = by_split["holdout"]
    evaluated_split = holdout if holdout["query_count"] else overall
    systematic_decoys = (
        (evaluated_split["related_outranks_duplicate_rate"] or 0.0) >= 0.25
        and (evaluated_split["recall_at_1"] or 0.0) < 0.75
    )
    trigger_reasons: list[str] = []
    if overall["queries_missed_at_5"] > 0:
        trigger_reasons.append("at least one labelled duplicate is missing from the top-five shortlist")
    if (evaluated_split["recall_at_5"] or 0.0) < 0.95:
        trigger_reasons.append("holdout Recall@5 is below 95%")
    if systematic_decoys:
        trigger_reasons.append("related lexical decoys systematically outrank duplicates")
    return {
        "configuration": {
            "name": "phase0_lexical_v1_reproduced",
            "input_fields": ["title", "summary", "background", "solution"],
            "excluded_fields": ["id", "timestamps", "run identifiers", "workflow state", "relationship labels"],
            "scoring": "Phase 0 canonical equality, normalised title equality, token Jaccard, and character-trigram cosine",
            "weights": "unchanged Phase 0 scorer; no Phase 6 weight search",
        },
        "candidate_pool_size": len(candidates),
        **overall,
        "by_split": by_split,
        "latency_p50_ms": statistics.median(runtimes) if runtimes else None,
        "latency_p95_ms": _percentile(runtimes, 0.95),
        "embedding_trigger": {
            "triggered": bool(trigger_reasons),
            "reasons": trigger_reasons or ["lexical top-five recall meets the bounded target without systematic decoy failure"],
            "challenger_status": "REQUIRED" if trigger_reasons else "NOT_RUN",
        },
        "records": records,
        "note": "Relationships are attached only after ranking. The production-facing contract is a ranked shortlist for human review, never a score threshold or authoritative duplicate decision.",
    }
