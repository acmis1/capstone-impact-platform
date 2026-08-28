"""Pre-registered selector decision.

The protocol keeps the merged baseline selector unless the *new* calibration corpus shows a
generalizable defect. This module captures one diagnostic OCR pass, replays the identical
blocks through every permitted selector, and applies the frozen decision rule:

* if the baseline recovers every visible title, the baseline is kept;
* otherwise the smallest permitted alternative that removes the demonstrated defect wins,
  and the affected difficulty families are recorded as the justification.

No consumed holdout output is consulted, and the decision never sees a case identifier.
"""

from __future__ import annotations

import os
import platform
import time
from pathlib import Path
from typing import Any

from ..ocr_iteration3.capture import verify_small_candidate
from ..ocr_productionization.offline import enable_offline_guard
from ..ocr_productionization.title_safety import normalize_metric_title
from .capture import candidate_configuration
from .pipeline import PaddleStageProfiler, make_paddle, run_paddle
from .renderer import generate_assets, raster_path
from .schema import value_sha256
from .selectors import BASELINE_SELECTOR_ID, SELECTORS, TYPOGRAPHY_SELECTOR_ID

DIAGNOSTIC_SCHEMA = "pp1-ocr-title-fullpage-selector-diagnostic/v1"
DIAGNOSTIC_CANDIDATE_ID = "selector-diagnostic-fullpage-t4"
# Ordered simplest-first: the baseline is preferred, and only one bounded alternative exists.
SELECTOR_PREFERENCE = (BASELINE_SELECTOR_ID, TYPOGRAPHY_SELECTOR_ID)


def selector_diagnostic(
    corpus: dict[str, Any],
    protocol: dict[str, Any],
    *,
    run_dir: Path,
    models_dir: Path,
) -> dict[str, Any]:
    """One OCR pass over the calibration corpus, replayed through every permitted selector."""
    configuration = candidate_configuration(protocol, candidate_id=DIAGNOSTIC_CANDIDATE_ID, cpu_threads=4)
    assets_dir = run_dir / "corpus"
    generation = generate_assets(corpus, assets_dir)
    provisioning = verify_small_candidate(protocol, models_dir)
    offline = enable_offline_guard()
    instance, versions, effective = make_paddle(models_dir, configuration)
    profiler = PaddleStageProfiler(instance)
    rendered_dir = run_dir / "rendered"
    observations: dict[str, list[dict[str, Any]]] = {}
    started = time.perf_counter()
    for case in corpus["ocr_cases"]:
        page = raster_path(
            case, assets_dir, rendered_dir, configuration["raster_dpi"], configuration["max_input_dimension"]
        )
        observations[case["id"]] = run_paddle(instance, profiler, page)["blocks"]
    elapsed_ms = (time.perf_counter() - started) * 1000

    scored = [case for case in corpus["ocr_cases"] if case["split"] == "calibration"]
    selectors: dict[str, Any] = {}
    for selector_id in SELECTOR_PREFERENCE:
        select, evaluate = SELECTORS[selector_id]
        failures = []
        agreements_wrong = 0
        for case in scored:
            candidates = select(observations[case["id"]])
            selected = candidates[0].text if candidates else ""
            expected = case["expected_visible_title"]
            outcome = evaluate(case["metadata_title"], candidates)
            if outcome["outcome"] == "AGREES" and case["expected_consistency"] == "INCONSISTENT":
                agreements_wrong += 1
            if expected is None:
                continue
            if not selected or normalize_metric_title(selected) != normalize_metric_title(expected):
                failures.append(
                    {
                        "case_id": case["id"],
                        "family": case["family"],
                        "expected_visible_title": expected,
                        "selected_title": selected,
                    }
                )
        visible = [case for case in scored if case["expected_visible_title"] is not None]
        selectors[selector_id] = {
            "selector_id": selector_id,
            "visible_title_case_count": len(visible),
            "exact_title_count": len(visible) - len(failures),
            "exact_title_rate": (len(visible) - len(failures)) / len(visible) if visible else 1.0,
            "material_false_automatic_agreements": agreements_wrong,
            "failing_families": sorted({item["family"] for item in failures}),
            "failures": failures,
        }
    return {
        "schema_version": DIAGNOSTIC_SCHEMA,
        "role": "selector_diagnostic",
        "candidate_id": DIAGNOSTIC_CANDIDATE_ID,
        "configuration": configuration,
        "effective_paddle_configuration": effective,
        "versions": versions,
        "provisioning": provisioning,
        "offline": offline,
        "environment": {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "machine": platform.machine(),
            "logical_cpu_count": os.cpu_count(),
        },
        "corpus_asset_sha256": generation["corpus_asset_sha256"],
        "scored_case_count": len(scored),
        "diagnostic_ocr_ms": round(elapsed_ms, 3),
        "selector_preference_order": list(SELECTOR_PREFERENCE),
        "selectors": selectors,
    }


def build_selector_decision(diagnostic: dict[str, Any], protocol: dict[str, Any]) -> dict[str, Any]:
    """Apply the frozen selector-decision rule to a stored diagnostic."""
    if diagnostic.get("schema_version") != DIAGNOSTIC_SCHEMA:
        raise ValueError("unsupported selector diagnostic")
    policy = protocol["selector_policy"]
    if policy["baseline_selector_id"] != BASELINE_SELECTOR_ID:
        raise ValueError("selector policy baseline changed")
    if policy["permitted_selector_ids"] != list(SELECTOR_PREFERENCE):
        raise ValueError("permitted selector set changed")
    required = protocol["calibration_margin"]["exact_title_rate_minimum"]
    results = diagnostic["selectors"]
    qualifying = [
        selector_id
        for selector_id in SELECTOR_PREFERENCE
        if results[selector_id]["exact_title_rate"] >= required
        and results[selector_id]["material_false_automatic_agreements"] == 0
    ]
    baseline = results[BASELINE_SELECTOR_ID]
    if not qualifying:
        selected = BASELINE_SELECTOR_ID
        decision = "NO_PERMITTED_SELECTOR_MEETS_THE_CALIBRATION_MARGIN"
    elif qualifying[0] == BASELINE_SELECTOR_ID:
        selected = BASELINE_SELECTOR_ID
        decision = "BASELINE_SELECTOR_RETAINED_NO_DEFECT_DEMONSTRATED"
    else:
        selected = qualifying[0]
        decision = "SMALLEST_PERMITTED_IMPROVEMENT_ADOPTED_AFTER_DEMONSTRATED_DEFECT"
    return {
        "schema_version": "pp1-ocr-title-fullpage-selector-decision/v1",
        "baseline_selector_id": BASELINE_SELECTOR_ID,
        "permitted_selector_ids": list(SELECTOR_PREFERENCE),
        "selected_selector_id": selected,
        "decision": decision,
        "baseline_exact_title_rate": baseline["exact_title_rate"],
        "baseline_failing_families": baseline["failing_families"],
        "selected_exact_title_rate": results[selected]["exact_title_rate"],
        "improvement_constraints": policy["improvement_constraints"],
        "diagnostic_sha256": value_sha256(diagnostic),
        "diagnostic": diagnostic,
    }
