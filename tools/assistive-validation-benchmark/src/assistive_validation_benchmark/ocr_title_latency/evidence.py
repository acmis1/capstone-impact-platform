from __future__ import annotations

from typing import Any

from ..ocr_title_consistency.evidence import non_reuse_evidence as prior_non_reuse_evidence
from ..ocr_title_consistency.schema import load_json as load_prior_json
from .schema import repository_root


def calibration_non_reuse(corpus: dict[str, Any]) -> dict[str, Any]:
    root = repository_root()
    calibration = load_prior_json(
        root / "docs" / "assistive-validation" / "evidence" / "ocr-title-consistency-calibration" / "calibration-report.json"
    )
    holdout = load_prior_json(
        root / "tools" / "assistive-validation-benchmark" / "ocr-title-consistency-holdout" / "non-reuse.json"
    )
    additional = [*calibration["non_reuse"]["records"], *holdout["records"]]
    result = prior_non_reuse_evidence(corpus, split="calibration", additional=additional)
    result["prohibited_title_calibration_case_count"] = len(calibration["non_reuse"]["records"])
    result["prohibited_consumed_title_holdout_case_count"] = len(holdout["records"])
    return result
