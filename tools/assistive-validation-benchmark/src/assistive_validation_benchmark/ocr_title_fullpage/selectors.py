"""The bounded set of metadata-blind title selectors this iteration may choose between.

The baseline is the selector merged in PR #213 and reused unchanged in PR #215. The protocol
permits exactly one alternative: the same top-band prominence ranking with a typographically
consistent join predicate. Which one is frozen is decided by the pre-registered selector
diagnostic on the *new* calibration corpus, never by inspecting consumed holdout output.
"""

from __future__ import annotations

from typing import Any, Callable

from ..ocr_productionization.title_safety import Candidate
from ..ocr_title_consistency.selector import (
    SELECTOR_ID as BASELINE_SELECTOR_ID,
    evaluate_title_outcome as baseline_evaluate_title_outcome,
    select_title_candidates as baseline_select_title_candidates,
)
from .selector import (
    SELECTOR_ID as TYPOGRAPHY_SELECTOR_ID,
    evaluate_title_outcome as typography_evaluate_title_outcome,
    select_title_candidates as typography_select_title_candidates,
)


SelectorFn = Callable[[list[dict[str, Any]]], list[Candidate]]
OutcomeFn = Callable[[str, list[Candidate]], dict[str, Any]]

SELECTORS: dict[str, tuple[SelectorFn, OutcomeFn]] = {
    BASELINE_SELECTOR_ID: (baseline_select_title_candidates, baseline_evaluate_title_outcome),
    TYPOGRAPHY_SELECTOR_ID: (typography_select_title_candidates, typography_evaluate_title_outcome),
}


def resolve(selector_id: str) -> tuple[SelectorFn, OutcomeFn]:
    if selector_id not in SELECTORS:
        raise ValueError(f"unknown title selector: {selector_id}")
    return SELECTORS[selector_id]
