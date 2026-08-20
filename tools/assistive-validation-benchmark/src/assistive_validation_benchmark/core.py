from __future__ import annotations

import hashlib
import math
import re
import statistics
import unicodedata
from collections import Counter
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Any, Iterable


def levenshtein_distance(reference: list[str] | str, hypothesis: list[str] | str) -> int:
    if len(reference) < len(hypothesis):
        reference, hypothesis = hypothesis, reference
    previous = list(range(len(hypothesis) + 1))
    for row, reference_item in enumerate(reference, start=1):
        current = [row]
        for column, hypothesis_item in enumerate(hypothesis, start=1):
            current.append(min(
                current[-1] + 1,
                previous[column] + 1,
                previous[column - 1] + (reference_item != hypothesis_item),
            ))
        previous = current
    return previous[-1]


def normalize_metric_text(text: str) -> str:
    """Minimal OCR normalization: Unicode canonicalization and whitespace only."""
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", text)).strip()


def character_error_rate(reference: str, hypothesis: str) -> float:
    reference = normalize_metric_text(reference)
    hypothesis = normalize_metric_text(hypothesis)
    if not reference:
        return 0.0 if not hypothesis else 1.0
    return levenshtein_distance(reference, hypothesis) / len(reference)


def word_error_rate(reference: str, hypothesis: str) -> float:
    reference_words = normalize_metric_text(reference).split()
    hypothesis_words = normalize_metric_text(hypothesis).split()
    if not reference_words:
        return 0.0 if not hypothesis_words else 1.0
    return levenshtein_distance(reference_words, hypothesis_words) / len(reference_words)


_DASHES = str.maketrans({"‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "―": "-"})
_QUOTES = str.maketrans({"‘": "'", "’": "'", "‚": "'", "“": '"', "”": '"', "„": '"'})


def normalize_title(text: str) -> str:
    value = unicodedata.normalize("NFKC", text).translate(_DASHES).translate(_QUOTES).casefold()
    value = re.sub(r"[-_/]", " ", value)
    value = re.sub(r"[^\w\s]", " ", value, flags=re.UNICODE)
    return re.sub(r"\s+", " ", value).strip()


def _tokens(text: str) -> list[str]:
    return normalize_title(text).split()


def _token_jaccard(left: str, right: str) -> float:
    left_tokens, right_tokens = set(_tokens(left)), set(_tokens(right))
    if not left_tokens and not right_tokens:
        return 1.0
    return len(left_tokens & right_tokens) / max(1, len(left_tokens | right_tokens))


def _ocr_confusion_skeleton(text: str) -> str:
    """Collapse only high-frequency glyph confusions; never rewrite whole words semantically."""
    return normalize_title(text).translate(str.maketrans({"l": "i", "1": "i", "|": "i", "0": "o"}))


@dataclass(frozen=True)
class TitleMatch:
    matched: bool
    classification: str
    score: float
    normalized_metadata: str
    normalized_candidate: str
    decision: str = "mismatch"


CONFIDENT_CLASSIFICATIONS = {"exact_normalized", "approved_alias", "allowed_subtitle"}


def match_title(
    metadata_title: str,
    candidate_title: str,
    *,
    aliases: Iterable[str] = (),
    allow_subtitle: bool = False,
    threshold: float = 0.90,
) -> TitleMatch:
    """Compare a metadata title with a title candidate taken from a document.

    Three decisions are produced, because Phase 0 measurement showed that a single
    boolean hides where the evidence actually is:

    - ``match``     deterministic equality after documented normalization, an approved
                    alias, or an explicitly allowed subtitle. Only this path may be
                    treated as a confident automatic agreement.
    - ``review``    lexically close but not equal. Assistive only; a human decides.
    - ``mismatch``  clearly different.

    ``matched`` stays true for ``match`` and ``review`` so the permissive assistive view
    remains reportable, but the benchmark reports the two tracks separately.
    """
    metadata = normalize_title(metadata_title)
    candidate = normalize_title(candidate_title)
    if not candidate:
        return TitleMatch(False, "missing", 0.0, metadata, candidate, "mismatch")
    if candidate == metadata:
        return TitleMatch(True, "exact_normalized", 1.0, metadata, candidate, "match")
    if candidate in {normalize_title(alias) for alias in aliases}:
        return TitleMatch(True, "approved_alias", 1.0, metadata, candidate, "match")
    if allow_subtitle and (candidate.startswith(f"{metadata} ") or metadata.startswith(f"{candidate} ")):
        return TitleMatch(True, "allowed_subtitle", 1.0, metadata, candidate, "match")

    char_score = SequenceMatcher(None, metadata, candidate, autojunk=False).ratio()
    token_score = _token_jaccard(metadata, candidate)
    score = 0.60 * char_score + 0.40 * token_score
    metadata_tokens, candidate_tokens = metadata.split(), candidate.split()
    differing_pairs = [
        (left, right)
        for left, right in zip(metadata_tokens, candidate_tokens)
        if left != right
    ]
    # Narrow, deterministic glyph-confusion rule only. An earlier revision also accepted any
    # single differing token pair with SequenceMatcher ratio >= 0.80, which admitted material
    # substitutions such as "Waste Stream" / "Water Stream"; that arm was a measured
    # false-positive source and was removed.
    ocr_confusion_single_token = (
        len(metadata_tokens) == len(candidate_tokens)
        and len(differing_pairs) == 1
        and _ocr_confusion_skeleton(differing_pairs[0][0]) == _ocr_confusion_skeleton(differing_pairs[0][1])
    )
    if ocr_confusion_single_token:
        return TitleMatch(True, "ocr_glyph_confusion", score, metadata, candidate, "review")
    if score >= threshold:
        return TitleMatch(True, "lexical_near_match", score, metadata, candidate, "review")
    return TitleMatch(False, "mismatch", score, metadata, candidate, "mismatch")


def binary_metrics(expected: Iterable[bool], predicted: Iterable[bool]) -> dict[str, float | int]:
    pairs = list(zip(expected, predicted))
    tp = sum(1 for truth, guess in pairs if truth and guess)
    fp = sum(1 for truth, guess in pairs if not truth and guess)
    fn = sum(1 for truth, guess in pairs if truth and not guess)
    tn = sum(1 for truth, guess in pairs if not truth and not guess)
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {"true_positive": tp, "false_positive": fp, "false_negative": fn, "true_negative": tn,
            "precision": precision, "recall": recall, "f1": f1}


def percentile(values: list[float], quantile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, math.ceil(len(ordered) * quantile) - 1))
    return ordered[index]


def timing_summary(values: list[float]) -> dict[str, float | int | None]:
    return {
        "count": len(values),
        "mean_ms": statistics.fmean(values) if values else None,
        "p50_ms": percentile(values, 0.50),
        "p95_ms": percentile(values, 0.95),
    }


def canonical_duplicate_text(title: str, text: str) -> str:
    return f"{normalize_title(title)}\n{normalize_title(text)}"


def _ngrams(text: str, size: int = 3) -> Counter[str]:
    normalized = normalize_title(text)
    padded = f"  {normalized}  "
    return Counter(padded[index:index + size] for index in range(max(0, len(padded) - size + 1)))


def _cosine(left: Counter[str], right: Counter[str]) -> float:
    numerator = sum(count * right.get(token, 0) for token, count in left.items())
    left_norm = math.sqrt(sum(count * count for count in left.values()))
    right_norm = math.sqrt(sum(count * count for count in right.values()))
    return numerator / (left_norm * right_norm) if left_norm and right_norm else 0.0


def rank_duplicate_candidates(case: dict[str, Any]) -> list[dict[str, Any]]:
    query_canonical = canonical_duplicate_text(case["query_title"], case["query_text"])
    query_hash = hashlib.sha256(query_canonical.encode("utf-8")).hexdigest()
    query_tokens = set(query_canonical.split())
    query_ngrams = _ngrams(query_canonical)
    ranked = []
    for candidate in case["candidates"]:
        canonical = canonical_duplicate_text(candidate["title"], candidate["text"])
        candidate_tokens = set(canonical.split())
        token_overlap = len(query_tokens & candidate_tokens) / max(1, len(query_tokens | candidate_tokens))
        ngram_similarity = _cosine(query_ngrams, _ngrams(canonical))
        exact_hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest() == query_hash
        title_equal = normalize_title(candidate["title"]) == normalize_title(case["query_title"])
        score = 1.0 if exact_hash else min(0.999, 0.25 * float(title_equal) + 0.40 * token_overlap + 0.35 * ngram_similarity)
        ranked.append({
            "id": candidate["id"],
            "score": score,
            "exact_hash": exact_hash,
            "normalized_title_equal": title_equal,
            "token_overlap": token_overlap,
            "character_ngram_similarity": ngram_similarity,
            "relevant": candidate["relevant"],
            "relation": candidate.get("relation"),
        })
    return sorted(ranked, key=lambda item: (-item["score"], item["id"]))


DUPLICATE_THRESHOLDS = [0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70]


def _rank_all(cases: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Rank every query against the single shared candidate pool built from all cases.

    Relevance labels and duplicate-group metadata are attached only after ranking, and the
    ranking function is given nothing but candidate title and text, so ground truth cannot
    influence either the score or the candidate ordering.
    """
    candidate_pool: list[dict[str, Any]] = []
    seen: set[str] = set()
    for case in cases:
        for candidate in case["candidates"]:
            if candidate["id"] not in seen:
                candidate_pool.append({"id": candidate["id"], "title": candidate["title"], "text": candidate["text"]})
                seen.add(candidate["id"])
    ranked_cases = []
    for case in cases:
        own = {candidate["id"]: candidate for candidate in case["candidates"]}
        scored = rank_duplicate_candidates({
            **case,
            "candidates": [{**candidate, "relevant": False, "relation": None} for candidate in candidate_pool],
        })
        for item in scored:
            labelled = own.get(item["id"])
            item["relevant"] = bool(labelled["relevant"]) if labelled else False
            item["relation"] = labelled.get("relation") if labelled else "cross_case"
        ranked_cases.append({"case_id": case["id"], "split": case["split"], "ranking": scored})
    return ranked_cases


def _duplicate_aggregate(ranked_cases: list[dict[str, Any]], candidate_threshold: float) -> dict[str, Any]:
    exact_total = exact_found = recall_1 = recall_3 = recall_5 = false_candidates = 0
    total_flagged = missed_at_5 = 0
    for entry in ranked_cases:
        ranking = entry["ranking"]
        relevant = {item["id"] for item in ranking if item["relevant"]}
        exact_relevant = {item["id"] for item in ranking
                          if item["relevant"] and item["relation"] in {"exact", "normalized"}}
        if exact_relevant:
            exact_total += 1
            exact_found += int(any(item["id"] in exact_relevant and (item["exact_hash"] or item["normalized_title_equal"])
                                   for item in ranking))
        recall_1 += int(bool(relevant & {item["id"] for item in ranking[:1]}))
        recall_3 += int(bool(relevant & {item["id"] for item in ranking[:3]}))
        hit_5 = bool(relevant & {item["id"] for item in ranking[:5]})
        recall_5 += int(hit_5)
        missed_at_5 += int(not hit_5)
        false_candidates += sum(1 for item in ranking if not item["relevant"] and item["score"] >= candidate_threshold)
        total_flagged += sum(1 for item in ranking if item["score"] >= candidate_threshold)
    count = len(ranked_cases)
    flagged_relevant = total_flagged - false_candidates
    total_relevant = sum(sum(1 for item in entry["ranking"] if item["relevant"]) for entry in ranked_cases)
    return {
        "case_count": count,
        "exact_duplicate_detection": exact_found / exact_total if exact_total else None,
        "recall_at_1": recall_1 / count if count else None,
        "recall_at_3": recall_3 / count if count else None,
        "recall_at_5": recall_5 / count if count else None,
        "queries_missed_at_5": missed_at_5,
        "false_candidate_count": false_candidates,
        "flagged_candidate_count": total_flagged,
        "irrelevant_candidate_rate": false_candidates / total_flagged if total_flagged else 0.0,
        "threshold_precision": flagged_relevant / total_flagged if total_flagged else 0.0,
        "threshold_recall": flagged_relevant / total_relevant if total_relevant else 0.0,
    }


def duplicate_metrics(cases: list[dict[str, Any]], *, candidate_threshold: float | None = None) -> dict[str, Any]:
    ranked_cases = _rank_all(cases)
    calibration = [entry for entry in ranked_cases if entry["split"] == "calibration"]
    holdout = [entry for entry in ranked_cases if entry["split"] == "holdout"]
    sweep = []
    for threshold in DUPLICATE_THRESHOLDS:
        aggregate = _duplicate_aggregate(calibration or ranked_cases, threshold)
        precision, recall = aggregate["threshold_precision"], aggregate["threshold_recall"]
        aggregate["f1"] = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        sweep.append({"threshold": threshold, **aggregate})
    if candidate_threshold is None:
        candidate_threshold = max(sweep, key=lambda item: (item["f1"], item["threshold_precision"], item["threshold"]))["threshold"]
    overall = _duplicate_aggregate(ranked_cases, candidate_threshold)
    pool_size = len(ranked_cases[0]["ranking"]) if ranked_cases else 0
    return {
        **overall,
        "candidate_pool_size": pool_size,
        "candidate_threshold": candidate_threshold,
        "threshold_selection": "Calibration split only, maximising flagged-candidate F1 then precision then the "
                               "stricter threshold; holdout is scored once with the selected value.",
        "threshold_at_sweep_boundary": candidate_threshold in {DUPLICATE_THRESHOLDS[0], DUPLICATE_THRESHOLDS[-1]},
        "threshold_sweep_calibration": sweep,
        "by_split": {
            "calibration": _duplicate_aggregate(calibration, candidate_threshold) if calibration else {},
            "holdout": _duplicate_aggregate(holdout, candidate_threshold) if holdout else {},
        },
        "rankings": ranked_cases,
        "note": "Ranking sees only candidate title and text. Relevance labels, relation labels and split membership "
                "are attached after ranking and never affect the score or the candidate ordering.",
    }
