from __future__ import annotations

import math
import re
import unicodedata
from dataclasses import dataclass
from typing import Any


_PUNCTUATION = re.compile(r'''[.,;:!?()\[\]{}"']''')
_TOKENS = re.compile(r"[^\W_]+", re.UNICODE)


def normalize_production_title(value: str) -> str:
    value = unicodedata.normalize("NFKC", value)
    value = re.sub("[\u2018\u2019\u201B]", "'", value)
    value = re.sub("[\u201C\u201D\u201F]", '"', value)
    value = re.sub("[\u2010-\u2015\u2212]", "-", value)
    value = _PUNCTUATION.sub(" ", value)
    return " ".join(value.split()).lower()


def normalize_metric_title(value: str) -> str:
    value = unicodedata.normalize("NFKC", value).casefold()
    value = re.sub("[\u2010-\u2015\u2212]", "-", value)
    value = re.sub("[\u2018\u2019\u201B]", "'", value)
    value = re.sub("[\u201C\u201D\u201F]", '"', value)
    value = re.sub(r"[^\w]+", " ", value, flags=re.UNICODE)
    return " ".join(value.split())


def _tokens(value: str) -> list[str]:
    return _TOKENS.findall(normalize_production_title(value))


def levenshtein(left: str, right: str) -> int:
    row = list(range(len(right) + 1))
    for left_index, left_character in enumerate(left, start=1):
        diagonal = row[0]
        row[0] = left_index
        for right_index, right_character in enumerate(right, start=1):
            previous = row[right_index]
            row[right_index] = min(
                row[right_index] + 1,
                row[right_index - 1] + 1,
                diagonal + (left_character != right_character),
            )
            diagonal = previous
    return row[-1]


def lexical_score(metadata: str, candidate: str) -> float:
    left = normalize_production_title(metadata)
    right = normalize_production_title(candidate)
    edit = 1 - levenshtein(left, right) / max(1, len(left), len(right))
    left_tokens, right_tokens = set(_tokens(metadata)), set(_tokens(candidate))
    shared = len(left_tokens & right_tokens)
    dice = 0 if not left_tokens and not right_tokens else (2 * shared) / (len(left_tokens) + len(right_tokens))
    return round((edit + dice) / 2, 3)


@dataclass(frozen=True)
class Candidate:
    text: str
    page_number: int
    box: dict[str, float] | None
    block_indexes: tuple[int, ...]
    prominence: float
    rank: int


def _cleaned_line(value: str) -> str | None:
    text = " ".join(value.split())
    if len(text) < 3 or len(text) > 160 or re.search(r"[\u0000-\u001F\u007F\uFFFD]", text):
        return None
    return text


def _can_join(previous: dict[str, Any] | None, following: dict[str, Any] | None) -> bool:
    if previous is None or following is None:
        return True
    if following["top"] < previous["top"]:
        return False
    previous_height = max(1.0, previous["bottom"] - previous["top"])
    following_height = max(1.0, following["bottom"] - following["top"])
    return following["top"] - previous["bottom"] <= 2 * min(previous_height, following_height)


def _combined_box(boxes: list[dict[str, Any] | None]) -> dict[str, float] | None:
    if any(box is None for box in boxes):
        return None
    present = [box for box in boxes if box is not None]
    return {
        "left": min(float(box["left"]) for box in present),
        "top": min(float(box["top"]) for box in present),
        "right": max(float(box["right"]) for box in present),
        "bottom": max(float(box["bottom"]) for box in present),
    }


def _geometry_score(box: dict[str, Any] | None) -> float:
    if box is None:
        return 0.0
    height = max(0.0, float(box["bottom"]) - float(box["top"]))
    return min(10_000.0, height * 3) - min(100.0, float(box["top"]) / max(1.0, height))


def extract_title_candidates(blocks: list[dict[str, Any]]) -> list[Candidate]:
    prepared = [{**block, "index": index, "cleaned": _cleaned_line(str(block["text"]))} for index, block in enumerate(blocks)]
    drafts = []
    for block in prepared:
        if block["cleaned"] is None:
            continue
        for length in range(1, 4):
            group = prepared[block["index"] : block["index"] + length]
            if len(group) != length or any(item["cleaned"] is None or item["page_number"] != block["page_number"] for item in group):
                break
            if length > 1 and not _can_join(group[-2].get("box"), group[-1].get("box")):
                break
            text = " ".join(str(item["cleaned"]) for item in group)
            if len(text) > 400:
                break
            box = _combined_box([item.get("box") for item in group])
            drafts.append(
                {
                    "text": text,
                    "page_number": block["page_number"],
                    "box": box,
                    "block_indexes": tuple(item["index"] for item in group),
                    "first_index": block["index"],
                    "geometry_score": _geometry_score(box) + (length - 1) * 2,
                }
            )
    drafts.sort(key=lambda item: (item["page_number"], -item["geometry_score"], item["first_index"]))
    result: list[Candidate] = []
    seen: set[str] = set()
    for draft in drafts:
        key = f"{draft['page_number']}:{normalize_production_title(draft['text'])}"
        if key in seen:
            continue
        seen.add(key)
        result.append(
            Candidate(
                text=draft["text"],
                page_number=draft["page_number"],
                box=draft["box"],
                block_indexes=draft["block_indexes"],
                prominence=round(draft["geometry_score"], 3),
                rank=len(result) + 1,
            )
        )
        if len(result) == 8:
            break
    return result


def _likely_noise_or_variant(metadata: str, candidate: str) -> bool:
    left, right = _tokens(metadata), _tokens(candidate)
    if len(left) != len(right):
        return False
    differences = [(a, b) for a, b in zip(left, right) if a != b]
    if len(differences) != 1:
        return False
    a, b = differences[0]
    if a.startswith(b) or b.startswith(a):
        return bool(re.search(r"(?:ing|er|or|re|s|es)$", a) or re.search(r"(?:ing|er|or|re|s|es)$", b))
    if levenshtein(a, b) != 1:
        return False
    pairs = {"il", "li", "o0", "0o", "i1", "1i", "sz", "zs"}
    return any(a[index] != b[index] and f"{a[index]}{b[index]}" in pairs for index in range(min(len(a), len(b))))


def _material_mismatch(metadata: str, candidate: str) -> bool:
    if _likely_noise_or_variant(metadata, candidate):
        return False
    left, right = set(_tokens(metadata)), set(_tokens(candidate))
    shared = len(left & right)
    dice = 0 if not left and not right else (2 * shared) / (len(left) + len(right))
    return dice <= 0.8 or lexical_score(metadata, candidate) <= 0.65


def _independent_ambiguity(candidates: list[Candidate]) -> bool:
    if len(candidates) < 2:
        return False
    first = set(candidates[0].block_indexes)
    return any(
        all(index not in first for index in candidate.block_indexes)
        and candidate.prominence >= candidates[0].prominence * 0.85
        for candidate in candidates[1:3]
    )


def evaluate_title_safety(metadata_title: str, candidates: list[Candidate]) -> dict[str, Any]:
    if not candidates:
        return {"outcome": "NOT_EVALUATED", "reason": "NO_CREDIBLE_TITLE_CANDIDATE", "score": None, "candidate": ""}
    candidate = candidates[0]
    score = lexical_score(metadata_title, candidate.text)
    if _independent_ambiguity(candidates):
        outcome, reason = "REVIEW", "AMBIGUOUS_TITLE_CANDIDATES"
    elif normalize_production_title(metadata_title) == normalize_production_title(candidate.text):
        outcome, reason = "AGREES", "NORMALIZED_EXACT_MATCH"
    elif _material_mismatch(metadata_title, candidate.text):
        outcome, reason = "MISMATCH", "MATERIAL_TOKEN_DIFFERENCE"
    else:
        outcome, reason = "REVIEW", "POSSIBLE_OCR_OR_SPELLING_VARIANT"
    if not math.isfinite(score):
        raise ValueError("title lexical score is not finite")
    return {"outcome": outcome, "reason": reason, "score": score, "candidate": candidate.text}


def binary_metrics(expected: list[bool], predicted: list[bool]) -> dict[str, Any]:
    if len(expected) != len(predicted):
        raise ValueError("binary metric inputs differ in length")
    tp = sum(wanted and observed for wanted, observed in zip(expected, predicted))
    fp = sum(not wanted and observed for wanted, observed in zip(expected, predicted))
    fn = sum(wanted and not observed for wanted, observed in zip(expected, predicted))
    tn = len(expected) - tp - fp - fn
    return {
        "true_positive": tp,
        "false_positive": fp,
        "false_negative": fn,
        "true_negative": tn,
        "precision": tp / (tp + fp) if tp + fp else 1.0,
        "recall": tp / (tp + fn) if tp + fn else 1.0,
    }
