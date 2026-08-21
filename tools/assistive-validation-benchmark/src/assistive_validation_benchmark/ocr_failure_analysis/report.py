"""Build and re-verify the compact machine diagnostic report.

The report is development evidence, not holdout evidence. Its own schema records that
status so a later reader cannot mistake these numbers for an independent measurement.
Validation recomputes every stored aggregate from the stored per-case values, so CI can
prove the arithmetic without rerunning OCR.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

from ..ocr_productionization.boundary import check_production_boundary
from ..ocr_productionization.schema import (
    file_sha256,
    load_json,
    repository_root,
    value_sha256,
)
from .analysis import DEVELOPMENT_GATE, OPERATIONAL_CEILINGS, development_gate
from .capture import exposed_development_cases
from .ordering import COLUMN_GAP_RATIO, MAX_COLUMNS, ROW_OVERLAP_RATIO
from .selectors import (
    CENTRE_TOLERANCE_RATIO,
    GAP_LINE_HEIGHTS,
    HEIGHT_TOLERANCE,
    MAX_GROUP_LINES,
    TOP_BAND_RATIO,
)
from .taxonomy import (
    CATEGORIES,
    MATERIAL_WER_DELTA,
    RECOGNITION_SIMILARITY_FLOOR,
    apply_resolution_sensitivity,
    category_counts,
)


REPORT_SCHEMA = "pp1-ocr-failure-analysis/v1"
MERGED_REPORT_RELATIVE = "docs/assistive-validation/evidence/ocr-productionization-report.json"
BASELINE_CONFIGURATION = "dpi150-edge960"
BASELINE_VARIANT = "production_geometry_prominence@raw"

DECISIONS = (
    "READY_TO_FREEZE_OCR_ITERATION_2_HOLDOUT",
    "NEEDS_OCR_MODEL_CHALLENGER",
    "NEEDS_MORE_OCR_FAILURE_ANALYSIS",
)


RECORD_PRECISION = 6


def _compact_record(record: dict[str, Any]) -> dict[str, Any]:
    """Per-case evidence, without OCR transcripts. Enough to re-derive every aggregate."""
    return {
        "case_id": record["case_id"],
        "split": record["split"],
        "media": record["media"],
        "layout": record["layout"],
        "difficulty": record["difficulty"],
        "category": record["category"],
        "baseline_category": record["baseline_category"],
        "repaired_by_configurations": record.get("repaired_by_configurations", []),
        "title_exact": record["title_exact"],
        "oracle_top3": record["oracle"]["top3"],
        "oracle_top8": record["oracle"]["top8"],
        "oracle_recoverable": record["oracle"]["recoverable"],
        "best_group_similarity": round(record["oracle"]["best_group_similarity"], RECORD_PRECISION),
        "raw_wer": round(record["wer"]["raw_wer"], RECORD_PRECISION),
        "geometry_wer": round(record["wer"]["geometry_wer"], RECORD_PRECISION),
        "column_wer": round(record["wer"]["column_wer"], RECORD_PRECISION),
        "best_order": record["wer"]["best_order"],
        "reading_order_material": record["wer"]["reading_order_material"],
        "block_count": record["block_count"],
    }


def _compact_summary(summary: dict[str, Any], *, retain_records: bool) -> dict[str, Any]:
    """Compact one engine/configuration summary.

    Primary configurations keep per-case rows so CI can re-derive every aggregate from them.
    Exploratory sweep configurations keep aggregates only, which keeps the committed evidence
    small without hiding any number the decision depends on. Aggregate means are recomputed
    from the rounded rows so the stored arithmetic stays exactly reproducible.
    """
    compact = {key: value for key, value in summary.items() if key != "records"}
    records = [_compact_record(record) for record in summary["records"]]
    compact["records_retained"] = retain_records
    compact["records"] = records if retain_records else []
    if not retain_records:
        # A sweep configuration only has to justify why it was not promoted, so it keeps the
        # selector counts and the difficulty split rather than the full cross-tabulation.
        compact["selector_study"] = {
            key: {
                "selector": value["selector"],
                "reading_order": value["reading_order"],
                "exact_title_count": value["exact_title_count"],
                "exact_title_rate": value["exact_title_rate"],
                "material_false_agreements": value["material_false_agreements"],
            }
            for key, value in summary["selector_study"].items()
        }
        compact["breakdown"] = {"difficulty": summary["breakdown"]["difficulty"]}
    if retain_records and records:
        for key, field in (
            ("mean_raw_wer", "raw_wer"),
            ("mean_geometry_wer", "geometry_wer"),
            ("mean_column_wer", "column_wer"),
        ):
            compact[key] = sum(record[field] for record in records) / len(records)
        compact["mean_best_wer"] = sum(
            record[f"{record['best_order']}_wer"] for record in records
        ) / len(records)
    return compact


def source_main_sha() -> str:
    result = subprocess.run(
        ["git", "rev-parse", "origin/main"],
        cwd=repository_root(),
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        shell=False,
        check=True,
    )
    return result.stdout.strip()


def merged_evidence_fingerprint() -> dict[str, Any]:
    """Prove the merged v1 evidence is byte-unchanged and still says what it said."""
    path = repository_root() / MERGED_REPORT_RELATIVE
    merged = load_json(path)
    return {
        "path": MERGED_REPORT_RELATIVE,
        "file_sha256": file_sha256(path),
        "benchmark_version": merged["benchmark_version"],
        "final_decision": merged["final_decision"],
        "protocol_freeze_commit_sha": merged["protocol_freeze"]["protocol_freeze_commit_sha"],
        "corpus_manifest_sha256": merged["hashes"]["corpus_manifest_sha256"],
        "engine_exact_title_counts": {
            engine: merged["engines"][engine]["exact_title_count"] for engine in sorted(merged["engines"])
        },
        "engine_mean_wer": {engine: merged["engines"][engine]["mean_wer"] for engine in sorted(merged["engines"])},
    }


def development_corpus_identity() -> dict[str, Any]:
    from ..ocr_productionization.schema import data_root

    calibration = load_json(data_root() / "corpus" / "calibration.json")
    holdout = load_json(data_root() / "corpus" / "holdout.json")
    cases = exposed_development_cases()
    return {
        "role": "exposed_development_corpus",
        "independent_holdout": False,
        "may_claim_unbiased_accuracy": False,
        "corpus_version": calibration["corpus_version"],
        "calibration_part_sha256": value_sha256(calibration),
        "holdout_part_sha256": value_sha256(holdout),
        "exposed_case_count": len(cases),
        "former_calibration_cases": sum(case["split"] == "calibration" for case in cases),
        "former_holdout_cases": sum(case["split"] == "holdout" for case in cases),
        "case_ids_sha256": value_sha256([case["id"] for case in cases]),
    }


def diagnostic_parameters() -> dict[str, Any]:
    return {
        "recognition_similarity_floor": RECOGNITION_SIMILARITY_FLOOR,
        "material_wer_delta": MATERIAL_WER_DELTA,
        "max_group_lines": MAX_GROUP_LINES,
        "top_band_ratio": TOP_BAND_RATIO,
        "height_tolerance": HEIGHT_TOLERANCE,
        "gap_line_heights": GAP_LINE_HEIGHTS,
        "centre_tolerance_ratio": CENTRE_TOLERANCE_RATIO,
        "row_overlap_ratio": ROW_OVERLAP_RATIO,
        "column_gap_ratio": COLUMN_GAP_RATIO,
        "max_columns": MAX_COLUMNS,
        "tuning_basis": "developed against the exposed v1 corpus; not validated on any independent holdout",
    }


def capture_reproduction(summary: dict[str, Any]) -> dict[str, Any]:
    """Check a baseline-configuration capture against the merged per-case measurements.

    Agreement here is what licenses every other diagnostic: it shows the capture pipeline
    reproduces the merged pipeline rather than measuring something subtly different.
    """
    merged = load_json(repository_root() / MERGED_REPORT_RELATIVE)
    engine = summary["engine"]
    if engine not in merged["engines"]:
        return {"comparable": False, "reason": "engine absent from merged evidence"}
    merged_records = {record["case_id"]: record for record in merged["engines"][engine]["records"]}
    compared = [record for record in summary["records"] if record["case_id"] in merged_records]
    title_matches = sum(
        record["title_exact"] == merged_records[record["case_id"]]["title_exact"] for record in compared
    )
    wer_matches = sum(
        abs(record["wer"]["raw_wer"] - merged_records[record["case_id"]]["wer"]) <= 1e-9 for record in compared
    )
    return {
        "comparable": True,
        "engine": engine,
        "configuration_id": summary["configuration_id"],
        "compared_case_count": len(compared),
        "title_exact_agreements": title_matches,
        "raw_wer_exact_agreements": wer_matches,
        "title_exact_agreement_rate": title_matches / len(compared) if compared else None,
        "raw_wer_agreement_rate": wer_matches / len(compared) if compared else None,
    }


FINAL_EXACT_TITLE_GATE = 0.95


def latency_comparability(summaries: dict[str, dict[str, dict[str, Any]]]) -> dict[str, Any]:
    """Compare diagnostic timings with the merged run's timings for the same engine/config.

    Quality here is deterministic and reproduces the merged measurement exactly, but wall-clock
    timing is environment dependent. Recording the ratio keeps a faster diagnostic machine from
    silently overturning the merged operational conclusion.
    """
    merged = load_json(repository_root() / MERGED_REPORT_RELATIVE)
    engines = {}
    for engine, configurations in sorted(summaries.items()):
        summary = configurations.get(BASELINE_CONFIGURATION)
        if summary is None or engine not in merged["engines"]:
            continue
        merged_p50 = merged["engines"][engine]["latency"]["p50_ms"]
        observed = summary["latency"]["p50_ms"]
        engines[engine] = {
            "merged_p50_ms": merged_p50,
            "diagnostic_p50_ms": observed,
            "ratio": observed / merged_p50 if merged_p50 else None,
        }
    ratios = [value["ratio"] for value in engines.values() if value["ratio"] is not None]
    return {
        "engines": engines,
        "max_absolute_log_deviation_engine": max(
            engines, key=lambda engine: abs((engines[engine]["ratio"] or 1.0) - 1.0), default=None
        ),
        "comparable": bool(ratios) and all(0.8 <= ratio <= 1.25 for ratio in ratios),
        "authority": "merged operational measurements remain authoritative; diagnostic timings are indicative only",
    }


# A corpus rendering choice is treated as a measured confound when toggling it moves the
# exact-title recovery of at least one tested candidate by this much. It is deliberately the
# same materiality threshold already used for reading-order WER changes.
MATERIAL_CONFOUND_DELTA = 0.05


def stroke_sensitivity(probes: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Summarize how much the corpus title stroke moves the *tested* candidates.

    Scope is deliberately narrow. Every figure here describes the provisioned PP-OCRv6
    candidate set under this diagnostic. None of it bounds what an unseen OCR model, a
    different recognition architecture, or another legitimate deterministic configuration
    could recover, and none of it establishes a theoretical maximum for the corpus.
    """
    if not probes:
        return {"measured": False, "reason": "no stroke probe available"}
    case_ids = sorted({record["case_id"] for probe in probes.values() for record in probe["records"]})
    outcomes = {
        engine: {record["case_id"]: record for record in probe["records"]} for engine, probe in probes.items()
    }

    selector_keys = sorted(
        {key for probe in probes.values() for key in (probe.get("by_selector") or {})}
    ) or [None]

    def union(variant: str, selector: str | None) -> list[str]:
        def hit(engine: str, case_id: str) -> bool:
            record = outcomes[engine].get(case_id)
            if record is None:
                return False
            if selector is None:
                return bool(record[variant]["exact"])
            return bool(record[variant].get("exact_by_selector", {}).get(selector))

        return [case_id for case_id in case_ids if any(hit(engine, case_id) for engine in outcomes)]

    unions = {
        (selector or "scored_selector"): {
            "with_stroke": len(union("stroke", selector)),
            "without_stroke": len(union("no_stroke", selector)),
            "not_recovered_without_stroke": [
                case_id for case_id in case_ids if case_id not in set(union("no_stroke", selector))
            ],
        }
        for selector in selector_keys
    }
    # The headline union uses the strongest selector measured, so it is not depressed by the
    # separately-established selector defect.
    best_key = max(unions, key=lambda key: (unions[key]["without_stroke"], key))
    with_stroke = unions[best_key]["with_stroke"]
    without_stroke = unions[best_key]["without_stroke"]
    union_rate = without_stroke / len(case_ids) if case_ids else None
    engines = {
        engine: {
            "stroke_exact_count": probe["stroke_exact_count"],
            "no_stroke_exact_count": probe["no_stroke_exact_count"],
            "by_selector": probe.get("by_selector", {}),
            "recovered_only_without_stroke": probe["recovered_only_without_stroke"],
            "recovered_only_with_stroke": probe["recovered_only_with_stroke"],
        }
        for engine, probe in sorted(probes.items())
    }
    deltas = {
        engine: {
            key: (value["no_stroke_exact_count"] - value["stroke_exact_count"]) / len(case_ids)
            for key, value in (probes[engine].get("by_selector") or {}).items()
        }
        for engine in engines
    }
    largest = max(
        (abs(delta) for engine in deltas for delta in deltas[engine].values()),
        default=(
            max(
                abs(value["no_stroke_exact_count"] - value["stroke_exact_count"]) / len(case_ids)
                for value in engines.values()
            )
            if engines and case_ids
            else 0.0
        ),
    )
    return {
        "measured": True,
        "probe_schema": next(iter(probes.values())).get("schema_version"),
        "scope": "provisioned PP-OCRv6 candidates under this diagnostic; not a bound on OCR models generally",
        "method": "complete posters rendered twice; the stroke variant is byte-identical to the corpus and only the title stroke differs",
        "full_poster_context": all(probe.get("full_poster_context") for probe in probes.values()),
        "engines": engines,
        "exact_rate_delta_by_selector": deltas,
        "case_count": len(case_ids),
        "union_by_selector": unions,
        "union_selector": best_key,
        "tested_engine_union_with_stroke": with_stroke,
        "tested_engine_union_without_stroke": without_stroke,
        "tested_engine_union_exact_rate": union_rate,
        "final_gate_exact_title_minimum": FINAL_EXACT_TITLE_GATE,
        "tested_candidates_reach_final_gate": union_rate is not None and union_rate >= FINAL_EXACT_TITLE_GATE,
        "cases_not_recovered_by_any_tested_candidate": unions[best_key]["not_recovered_without_stroke"],
        "largest_absolute_exact_rate_delta": largest,
        "material_confound_delta": MATERIAL_CONFOUND_DELTA,
        "corpus_rendering_confound_detected": largest >= MATERIAL_CONFOUND_DELTA,
    }


def rank_finalists(gates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Rank development candidates: holdout-worthy first, then quality, then latency."""
    return sorted(
        gates,
        key=lambda gate: (
            not gate["holdout_worthy"],
            -(gate["exact_title_rate"] or 0.0),
            gate["mean_wer"] if gate["mean_wer"] is not None else 1.0,
            gate["p95_ms"] if gate["p95_ms"] is not None else float("inf"),
            gate["engine"],
            gate["configuration_id"],
        ),
    )


def decide(finalists: list[dict[str, Any]], recognition_dominant: bool, conflicting: bool) -> str:
    """Derive the iteration decision from defensible, measured inputs.

    ``conflicting`` means the development evidence cannot support an attribution: either the
    diagnostic did not reproduce the merged measurement, or a measured corpus rendering choice
    materially moves the tested candidates' recognition outcomes. In the latter case the
    residual recognition failure is partly a property of the corpus, so spending a challenger
    benchmark against that corpus would measure the rendering as much as the model.

    Note what is deliberately *not* an input: the tested-engine union recovery rate. That rate
    describes only the candidates actually measured, so it cannot license a statement about
    OCR models in general and must not by itself force a decision.
    """
    if any(gate["holdout_worthy"] for gate in finalists):
        return "READY_TO_FREEZE_OCR_ITERATION_2_HOLDOUT"
    if conflicting:
        return "NEEDS_MORE_OCR_FAILURE_ANALYSIS"
    if recognition_dominant:
        return "NEEDS_OCR_MODEL_CHALLENGER"
    return "NEEDS_MORE_OCR_FAILURE_ANALYSIS"


def build_report(
    *,
    summaries: dict[str, dict[str, dict[str, Any]]],
    stages: list[dict[str, Any]],
    scored_variants: dict[str, str],
    probes: dict[str, dict[str, Any]],
    recognition_dominant: bool,
    conflicting: bool,
    notes: list[str],
) -> dict[str, Any]:
    """Assemble the diagnostic report from per-engine, per-configuration analyses."""
    resolved: dict[str, dict[str, Any]] = {}
    for engine, configurations in summaries.items():
        baseline = configurations.get(BASELINE_CONFIGURATION)
        comparisons = {
            config: {record["case_id"]: record["title_exact"] for record in summary["records"]}
            for config, summary in configurations.items()
            if config != BASELINE_CONFIGURATION
        }
        promoted = max(
            configurations,
            key=lambda config: (
                configurations[config]["exact_title_rate"] or 0.0,
                -(configurations[config]["mean_best_wer"] or 1.0),
                config,
            ),
        )
        primary = {BASELINE_CONFIGURATION, promoted}
        resolved[engine] = {}
        for config, summary in configurations.items():
            updated = dict(summary)
            if config == BASELINE_CONFIGURATION and baseline is not None and comparisons:
                updated["records"] = apply_resolution_sensitivity(summary["records"], comparisons)
                updated["failure_taxonomy"] = category_counts(updated["records"])
            resolved[engine][config] = _compact_summary(updated, retain_records=config in primary)

    # Gates are computed from the compacted summaries so every published finalist number is
    # exactly the number a reader can recompute from the committed report.
    gates = [
        development_gate(resolved[engine][config], scored_variants[f"{engine}@{config}"])
        for engine in resolved
        for config in resolved[engine]
        if f"{engine}@{config}" in scored_variants
    ]
    finalists = rank_finalists(gates)
    baseline_engine = next(
        (engine for engine in ("paddle-medium", "paddle-small", "paddle-tiny", "tesseract") if engine in summaries),
        None,
    )
    reproduction = (
        capture_reproduction(summaries[baseline_engine][BASELINE_CONFIGURATION])
        if baseline_engine and BASELINE_CONFIGURATION in summaries[baseline_engine]
        else {"comparable": False, "reason": "no baseline-configuration capture"}
    )
    sensitivity = stroke_sensitivity(probes)
    # A measured corpus rendering confound blocks attribution of residual recognition failure
    # to engine capability. The tested-engine union rate is deliberately NOT consulted here.
    conflicting = bool(conflicting or sensitivity.get("corpus_rendering_confound_detected"))
    decision = decide(finalists, recognition_dominant, conflicting)
    return {
        "schema_version": REPORT_SCHEMA,
        "iteration": "pp1-ocr-productionization-iteration-2a",
        "purpose": "failure decomposition and calibration optimization; diagnostic and development evidence only",
        "source": {
            "benchmark_version": "pp1-ocr-productionization-v1",
            "source_main_sha": source_main_sha(),
            "merged_evidence": merged_evidence_fingerprint(),
        },
        "development_corpus": development_corpus_identity(),
        "diagnostic_parameters": diagnostic_parameters(),
        "development_gate": DEVELOPMENT_GATE,
        "operational_ceilings": OPERATIONAL_CEILINGS,
        "final_production_gate_unchanged": {
            "holdout_exact_title_recovery_minimum": 0.95,
            "holdout_mean_wer_maximum": 0.12,
            "material_false_agreements_maximum": 0,
            "altered_by_this_iteration": False,
        },
        "stages": stages,
        "capture_reproduction": reproduction,
        "latency_comparability": latency_comparability(summaries),
        "stroke_sensitivity": sensitivity,
        "engines": resolved,
        "scored_variants": scored_variants,
        "finalists": finalists,
        "holdout_worthy_candidates": [gate for gate in finalists if gate["holdout_worthy"]],
        "recognition_dominant": recognition_dominant,
        "evidence_conflicting": conflicting,
        "notes": notes,
        "production_boundary": check_production_boundary(repository_root()),
        "decision": decision,
    }


def validate_report(report: dict[str, Any]) -> dict[str, Any]:
    """Recompute every stored aggregate from stored per-case values and re-prove the boundary."""
    if report.get("schema_version") != REPORT_SCHEMA:
        raise ValueError("unsupported OCR failure-analysis schema")
    if report["decision"] not in DECISIONS:
        raise ValueError(f"unsupported diagnostic decision: {report['decision']}")

    corpus = report["development_corpus"]
    observed_corpus = development_corpus_identity()
    for key in ("corpus_version", "calibration_part_sha256", "holdout_part_sha256", "exposed_case_count", "case_ids_sha256"):
        if corpus[key] != observed_corpus[key]:
            raise ValueError(f"development corpus identity changed: {key}")
    if corpus["independent_holdout"] is not False or corpus["may_claim_unbiased_accuracy"] is not False:
        raise ValueError("diagnostic evidence must not claim independent holdout status")

    merged = merged_evidence_fingerprint()
    stored_merged = report["source"]["merged_evidence"]
    for key in ("file_sha256", "final_decision", "benchmark_version", "protocol_freeze_commit_sha"):
        if stored_merged[key] != merged[key]:
            raise ValueError(f"merged v1 evidence changed since the diagnostic was recorded: {key}")

    if report["final_production_gate_unchanged"]["holdout_exact_title_recovery_minimum"] != 0.95:
        raise ValueError("the final production exact-title gate must remain 0.95")
    if report["final_production_gate_unchanged"]["holdout_mean_wer_maximum"] != 0.12:
        raise ValueError("the final production WER gate must remain 0.12")
    if report["final_production_gate_unchanged"]["altered_by_this_iteration"] is not False:
        raise ValueError("this iteration must not alter the final production gate")

    retained = 0
    for engine, configurations in report["engines"].items():
        for config, summary in configurations.items():
            records = summary["records"]
            scored = summary["scored_case_count"]
            exact = summary["exact_title_count"]
            if scored and abs(summary["exact_title_rate"] - exact / scored) > 1e-12:
                raise ValueError(f"stored exact-title rate is inconsistent for {engine}/{config}")
            if sum(summary["failure_taxonomy"].values()) != scored:
                raise ValueError(f"stored failure taxonomy does not cover every case for {engine}/{config}")
            if set(summary["failure_taxonomy"]) != set(CATEGORIES):
                raise ValueError(f"stored failure taxonomy has unexpected categories for {engine}/{config}")
            if summary["title_oracle"]["top1"]["count"] != exact:
                raise ValueError(f"stored oracle top-1 disagrees with exact-title count for {engine}/{config}")
            for key in ("top1", "top3", "top5", "top8", "in_individual_blocks", "recoverable"):
                if not 0 <= summary["title_oracle"][key]["count"] <= scored:
                    raise ValueError(f"stored oracle coverage is out of range for {engine}/{config}/{key}")
            if not summary["records_retained"]:
                if records:
                    raise ValueError(f"aggregate-only configuration must not store rows: {engine}/{config}")
                continue
            retained += 1
            if len(records) != scored:
                raise ValueError(f"stored record count is inconsistent for {engine}/{config}")
            if sum(record["title_exact"] for record in records) != exact:
                raise ValueError(f"stored exact-title count is inconsistent for {engine}/{config}")
            for key, field in (
                ("mean_raw_wer", "raw_wer"),
                ("mean_geometry_wer", "geometry_wer"),
                ("mean_column_wer", "column_wer"),
            ):
                expected = sum(record[field] for record in records) / scored
                if abs(summary[key] - expected) > 1e-12:
                    raise ValueError(f"stored {key} is inconsistent for {engine}/{config}")
            expected_best = sum(record[f"{record['best_order']}_wer"] for record in records) / scored
            if abs(summary["mean_best_wer"] - expected_best) > 1e-12:
                raise ValueError(f"stored mean_best_wer is inconsistent for {engine}/{config}")
            counts = {category: sum(record["category"] == category for record in records) for category in CATEGORIES}
            if summary["failure_taxonomy"] != counts:
                raise ValueError(f"stored failure taxonomy is inconsistent for {engine}/{config}")
            for key, field in (("top3", "oracle_top3"), ("top8", "oracle_top8"), ("recoverable", "oracle_recoverable")):
                if summary["title_oracle"][key]["count"] != sum(record[field] for record in records):
                    raise ValueError(f"stored oracle coverage is inconsistent for {engine}/{config}/{key}")
            if summary["reading_order_material_cases"] != sum(record["reading_order_material"] for record in records):
                raise ValueError(f"stored reading-order counts are inconsistent for {engine}/{config}")
    if not retained:
        raise ValueError("diagnostic evidence must retain per-case rows for at least one configuration")

    for gate in report["finalists"]:
        summary = report["engines"][gate["engine"]][gate["configuration_id"]]
        variant = summary["selector_study"][gate["selector"]]
        if gate["exact_title_count"] != variant["exact_title_count"]:
            raise ValueError(f"finalist exact-title count is inconsistent for {gate['engine']}")
        if gate["material_false_agreements"] != variant["material_false_agreements"]:
            raise ValueError(f"finalist false-agreement count is inconsistent for {gate['engine']}")
        checks = {
            "exact_title": (gate["exact_title_rate"] or 0.0) >= DEVELOPMENT_GATE["exact_title_rate_minimum"],
            "mean_wer": gate["mean_wer"] is not None and gate["mean_wer"] <= DEVELOPMENT_GATE["mean_wer_maximum"],
            "material_false_agreements": gate["material_false_agreements"]
            <= DEVELOPMENT_GATE["material_false_agreements_maximum"],
            "cold_start": gate["cold_start_ms"] <= OPERATIONAL_CEILINGS["cold_start_ms_maximum"],
            "p50": gate["p50_ms"] is not None and gate["p50_ms"] <= OPERATIONAL_CEILINGS["p50_ms_maximum"],
            "p95": gate["p95_ms"] is not None and gate["p95_ms"] <= OPERATIONAL_CEILINGS["p95_ms_maximum"],
            "peak_memory": gate["peak_working_set_bytes"]
            <= OPERATIONAL_CEILINGS["peak_working_set_bytes_maximum"],
        }
        for key, expected in checks.items():
            if gate["checks"][key] != expected:
                raise ValueError(f"finalist gate check {key} is inconsistent for {gate['engine']}")
        if gate["holdout_worthy"] != all(gate["checks"].values()):
            raise ValueError(f"finalist holdout-worthiness is inconsistent for {gate['engine']}")

    sensitivity = report["stroke_sensitivity"]
    if sensitivity.get("measured"):
        if sensitivity["case_count"] <= 0:
            raise ValueError("stroke sensitivity must cover at least one case")
        expected_rate = sensitivity["tested_engine_union_without_stroke"] / sensitivity["case_count"]
        if abs(sensitivity["tested_engine_union_exact_rate"] - expected_rate) > 1e-12:
            raise ValueError("stored tested-engine union arithmetic is inconsistent")
        if sensitivity["tested_engine_union_without_stroke"] > sensitivity["case_count"]:
            raise ValueError("tested-engine union exceeds the case count")
        if len(sensitivity["cases_not_recovered_by_any_tested_candidate"]) != sensitivity["case_count"] - sensitivity[
            "tested_engine_union_without_stroke"
        ]:
            raise ValueError("stored not-recovered case list is inconsistent with the tested-engine union")
        if sensitivity["final_gate_exact_title_minimum"] != FINAL_EXACT_TITLE_GATE:
            raise ValueError("stroke sensitivity must compare against the unchanged final gate")
        if sensitivity["tested_candidates_reach_final_gate"] != (expected_rate >= FINAL_EXACT_TITLE_GATE):
            raise ValueError("stored tested-candidate gate verdict is inconsistent")
        expected_confound = sensitivity["largest_absolute_exact_rate_delta"] >= sensitivity["material_confound_delta"]
        if sensitivity["corpus_rendering_confound_detected"] != expected_confound:
            raise ValueError("stored corpus-confound verdict is inconsistent with its own measurement")
        # Guard the scientific error this iteration corrected: the tested-engine union rate
        # describes only the measured candidates and must never be recorded as a bound on
        # OCR models generally, nor be the sole reason a decision was taken.
        serialized = json.dumps(sensitivity, sort_keys=True).lower()
        for forbidden in ("upper bound", "ceiling for", "any ocr model", "corpus_caps", "instrument_ceiling"):
            if forbidden in serialized:
                raise ValueError(f"stroke sensitivity must not claim a universal model bound: {forbidden}")

    expected_worthy = [gate for gate in report["finalists"] if gate["holdout_worthy"]]
    if report["holdout_worthy_candidates"] != expected_worthy:
        raise ValueError("stored holdout-worthy candidate list is inconsistent")
    expected_decision = decide(report["finalists"], report["recognition_dominant"], report["evidence_conflicting"])
    if report["decision"] != expected_decision:
        raise ValueError("stored diagnostic decision is inconsistent with the stored evidence")

    boundary = check_production_boundary(repository_root())
    if report["production_boundary"] != boundary:
        raise ValueError("stored production boundary no longer matches the repository")
    return report


def load_report(path: Path) -> dict[str, Any]:
    return load_json(path)
