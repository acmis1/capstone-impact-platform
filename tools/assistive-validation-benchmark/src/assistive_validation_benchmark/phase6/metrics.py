from __future__ import annotations

from typing import Any, Iterator

# Only float representation error is tolerated; a stale copied metric must never pass.
METRIC_TOLERANCE = 1e-9
_COUNT_FIELDS = ("true_positives", "false_positives", "missed_issues")
_DERIVED_FIELDS = ("precision", "recall", "f1")


def recompute_metrics(true_positives: int, false_positives: int, missed_issues: int) -> dict[str, float]:
    """Derive precision, recall, and F1 from counts alone."""
    predicted = true_positives + false_positives
    actual = true_positives + missed_issues
    precision = true_positives / predicted if predicted else 0.0
    recall = true_positives / actual if actual else 0.0
    denominator = precision + recall
    return {
        "precision": precision,
        "recall": recall,
        "f1": 2 * precision * recall / denominator if denominator else 0.0,
    }


def iter_metric_groups(report: dict[str, Any]) -> Iterator[tuple[str, dict[str, Any]]]:
    """Yield every stored split/configuration metric group in a Phase 6 report."""
    for engine_name, engine in sorted(report.get("grammar", {}).items()):
        scores = engine.get("scores")
        if not isinstance(scores, dict):
            continue
        groups = [("all", scores)]
        groups.extend(sorted(scores.get("by_split", {}).items()))
        for split_name, group in groups:
            for configuration in ("raw", "vocabulary_policy"):
                result = group.get(configuration)
                if isinstance(result, dict):
                    yield f"{engine_name}/{split_name}/{configuration}", result


def check_metric_group(label: str, result: dict[str, Any]) -> None:
    """Reject any stored precision/recall/F1 that disagrees with its own TP/FP/FN counts."""
    missing = [field for field in _COUNT_FIELDS + _DERIVED_FIELDS if field not in result]
    if missing:
        raise ValueError(f"{label} metric group is missing {', '.join(missing)}")
    counts = [result[field] for field in _COUNT_FIELDS]
    if not all(isinstance(value, int) and value >= 0 for value in counts):
        raise ValueError(f"{label} TP/FP/FN counts must be non-negative integers")
    true_positives, false_positives, missed_issues = counts
    expected = recompute_metrics(true_positives, false_positives, missed_issues)
    for field, value in expected.items():
        stored = result[field]
        if not isinstance(stored, (int, float)) or abs(float(stored) - value) > METRIC_TOLERANCE:
            raise ValueError(
                f"{label} stored {field} {stored!r} disagrees with TP={true_positives} "
                f"FP={false_positives} FN={missed_issues}, which give {value!r}"
            )
    if result.get("issue_count") != true_positives + missed_issues:
        raise ValueError(f"{label} issue_count must equal TP + FN")


def check_report_metrics(report: dict[str, Any]) -> int:
    """Recompute every printed metric group; returns the number of groups verified."""
    verified = 0
    for label, result in iter_metric_groups(report):
        check_metric_group(label, result)
        verified += 1
    if not verified:
        raise ValueError("Phase 6 evidence contains no verifiable grammar metric group")
    return verified
