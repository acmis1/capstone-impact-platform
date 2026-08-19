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


def match_title(
    metadata_title: str,
    candidate_title: str,
    *,
    aliases: Iterable[str] = (),
    allow_subtitle: bool = False,
    threshold: float = 0.90,
) -> TitleMatch:
    metadata = normalize_title(metadata_title)
    candidate = normalize_title(candidate_title)
    if not candidate:
        return TitleMatch(False, "missing", 0.0, metadata, candidate)
    if candidate == metadata:
        return TitleMatch(True, "exact_normalized", 1.0, metadata, candidate)
    if candidate in {normalize_title(alias) for alias in aliases}:
        return TitleMatch(True, "approved_alias", 1.0, metadata, candidate)
    if allow_subtitle and (candidate.startswith(f"{metadata} ") or metadata.startswith(f"{candidate} ")):
        return TitleMatch(True, "allowed_subtitle", 1.0, metadata, candidate)

    char_score = SequenceMatcher(None, metadata, candidate, autojunk=False).ratio()
    token_score = _token_jaccard(metadata, candidate)
    score = 0.60 * char_score + 0.40 * token_score
    metadata_tokens, candidate_tokens = metadata.split(), candidate.split()
    differing_pairs = [
        (left, right)
        for left, right in zip(metadata_tokens, candidate_tokens)
        if left != right
    ]
    ocr_like_single_token = (
        len(metadata_tokens) == len(candidate_tokens)
        and len(differing_pairs) == 1
        and (
            SequenceMatcher(None, differing_pairs[0][0], differing_pairs[0][1], autojunk=False).ratio() >= 0.80
            or _ocr_confusion_skeleton(differing_pairs[0][0]) == _ocr_confusion_skeleton(differing_pairs[0][1])
        )
        and char_score >= 0.96
    )
    matched = score >= threshold or ocr_like_single_token
    return TitleMatch(matched, "fuzzy_ocr" if matched else "mismatch", score, metadata, candidate)


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


def duplicate_metrics(cases: list[dict[str, Any]], *, candidate_threshold: float = 0.55) -> dict[str, Any]:
    rankings = []
    candidate_pool = []
    seen_candidate_ids: set[str] = set()
    for case in cases:
        for candidate in case["candidates"]:
            if candidate["id"] not in seen_candidate_ids:
                candidate_pool.append(candidate)
                seen_candidate_ids.add(candidate["id"])
    exact_total = exact_found = recall_1 = recall_3 = recall_5 = false_candidates = 0
    total_candidates = 0
    for case in cases:
        own_candidates = {candidate["id"]: candidate for candidate in case["candidates"]}
        query_pool = [
            {
                **candidate,
                "relevant": bool(own_candidates.get(candidate["id"], {}).get("relevant", False)),
                "relation": own_candidates.get(candidate["id"], {}).get("relation", "cross_case"),
            }
            for candidate in candidate_pool
        ]
        ranking = rank_duplicate_candidates({**case, "candidates": query_pool})
        rankings.append({"case_id": case["id"], "ranking": ranking})
        relevant = {item["id"] for item in ranking if item["relevant"]}
        exact_relevant = {item["id"] for item in ranking if item["relevant"] and item["relation"] in {"exact", "normalized"}}
        if exact_relevant:
            exact_total += 1
            exact_found += int(any(item["id"] in exact_relevant and (item["exact_hash"] or item["normalized_title_equal"]) for item in ranking))
        recall_1 += int(bool(relevant & {item["id"] for item in ranking[:1]}))
        recall_3 += int(bool(relevant & {item["id"] for item in ranking[:3]}))
        recall_5 += int(bool(relevant & {item["id"] for item in ranking[:5]}))
        false_candidates += sum(1 for item in ranking if not item["relevant"] and item["score"] >= candidate_threshold)
        total_candidates += sum(1 for item in ranking if item["score"] >= candidate_threshold)
    count = len(cases)
    return {
        "case_count": count,
        "candidate_pool_size": len(candidate_pool),
        "exact_duplicate_detection": exact_found / exact_total if exact_total else None,
        "recall_at_1": recall_1 / count if count else None,
        "recall_at_3": recall_3 / count if count else None,
        "recall_at_5": recall_5 / count if count else None,
        "false_candidate_count": false_candidates,
        "irrelevant_candidate_rate": false_candidates / total_candidates if total_candidates else 0.0,
        "candidate_threshold": candidate_threshold,
        "rankings": rankings,
    }
