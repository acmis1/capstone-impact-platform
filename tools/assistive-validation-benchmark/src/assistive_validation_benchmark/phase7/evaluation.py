from __future__ import annotations

from collections import Counter, defaultdict
from typing import Any

from .grammar import _finding_matches_issue, _score
from .policy import apply_finding_policy

FINDING_KEYS = {"start", "end", "kind", "rule", "category", "message", "replacements"}


def normalise_finding(value: dict[str, Any]) -> dict[str, Any]:
    return {
        "start": int(value["start"]),
        "end": int(value["end"]),
        "kind": str(value.get("kind", "")),
        "rule": str(value.get("rule", "")),
        "category": str(value.get("category", "")),
        "message": str(value.get("message", ""))[:1000],
        "replacements": [str(item)[:200] for item in value.get("replacements", [])[:20]],
    }


def _finding_classifications(
    cases: list[dict[str, Any]], findings_by_case: list[list[dict[str, Any]]]
) -> list[tuple[dict[str, Any], str]]:
    classified: list[tuple[dict[str, Any], str]] = []
    for case, findings in zip(cases, findings_by_case, strict=True):
        unmatched = set(range(len(case["issues"])))
        matched_indices: set[int] = set()
        for finding in findings:
            matched_index = next(
                (
                    index
                    for index in sorted(unmatched)
                    if _finding_matches_issue(finding, case["issues"][index])
                ),
                None,
            )
            if matched_index is not None:
                unmatched.remove(matched_index)
                matched_indices.add(matched_index)
                outcome = "true_positive"
            elif any(_finding_matches_issue(finding, case["issues"][index]) for index in matched_indices):
                outcome = "redundant"
            else:
                outcome = "false_positive"
            classified.append((finding, outcome))
    return classified


def _rule_observations(
    engine: str,
    cases: list[dict[str, Any]],
    findings_by_case: list[list[dict[str, Any]]],
) -> list[dict[str, Any]]:
    counts: dict[tuple[str, str], Counter[str]] = defaultdict(Counter)
    for finding, outcome in _finding_classifications(cases, findings_by_case):
        dimensions = [("excluded_kinds", finding["kind"])] if engine == "harper" else [
            ("excluded_rules", finding["rule"]),
            ("excluded_categories", finding["category"]),
        ]
        for dimension, identifier in dimensions:
            if identifier:
                counts[(dimension, identifier)][outcome] += 1
    return [
        {
            "dimension": dimension,
            "id": identifier,
            "true_positives": outcome_counts["true_positive"],
            "false_positives": outcome_counts["false_positive"],
            "redundant_findings": outcome_counts["redundant"],
        }
        for (dimension, identifier), outcome_counts in sorted(counts.items())
    ]


def _group_metrics(
    cases: list[dict[str, Any]],
    findings_by_case: list[list[dict[str, Any]]],
    key: str,
) -> dict[str, dict[str, Any]]:
    names = sorted({str(case[key]) for case in cases})
    return {
        name: _score(
            [case for case in cases if str(case[key]) == name],
            [findings for case, findings in zip(cases, findings_by_case, strict=True) if str(case[key]) == name],
        )
        for name in names
    }


def _truth_category_metrics(
    cases: list[dict[str, Any]], policy_metrics: dict[str, Any]
) -> list[dict[str, Any]]:
    issue_counts: Counter[str] = Counter(
        issue["category"] for case in cases for issue in case["issues"]
    )
    missed_counts: Counter[str] = Counter(
        category for record in policy_metrics["records"] for category in record["missed_issue_categories"]
    )
    return [
        {
            "category": category,
            "issue_count": issue_counts[category],
            "true_positives": issue_counts[category] - missed_counts[category],
            "missed_issues": missed_counts[category],
            "recall": (issue_counts[category] - missed_counts[category]) / issue_counts[category],
        }
        for category in sorted(issue_counts)
    ]


def evaluate_engine_findings(
    engine: str,
    cases: list[dict[str, Any]],
    raw_findings: list[list[dict[str, Any]]],
    policy: dict[str, Any],
) -> dict[str, Any]:
    normalised = [[normalise_finding(finding) for finding in findings] for findings in raw_findings]
    policy_findings: list[list[dict[str, Any]]] = []
    reason_counts: Counter[str] = Counter()
    affected_cases = 0
    for case, findings in zip(cases, normalised, strict=True):
        retained, filtered = apply_finding_policy(case, findings, policy, engine)
        policy_findings.append(retained)
        if filtered:
            affected_cases += 1
        reason_counts.update(str(finding["policy_reason"]) for finding in filtered)
    policy_metrics = _score(cases, policy_findings)
    return {
        "raw": _score(cases, normalised),
        "policy": policy_metrics,
        "breakdowns": {
            "partitions": _group_metrics(cases, policy_findings, "partition"),
            "fields": _group_metrics(cases, policy_findings, "field"),
            "truth_categories": _truth_category_metrics(cases, policy_metrics),
        },
        "policy_filter_summary": {
            "filtered_findings": sum(reason_counts.values()),
            "affected_cases": affected_cases,
            "reasons": dict(sorted(reason_counts.items())),
        },
        "rule_observations": _rule_observations(engine, cases, normalised),
    }
