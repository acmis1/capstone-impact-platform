"""Build and re-verify the compact machine diagnostic report.

The report is development evidence, not holdout evidence. Its own schema records that
status so a later reader cannot mistake these numbers for an independent measurement.
Validation recomputes every stored aggregate from the stored per-case values, so CI can
prove the arithmetic without rerunning OCR.
"""

from __future__ import annotations

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


def instrument_validity(probes: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Measure what the corpus itself can support, independently of any selector or layout.

    The stroke probe isolates each title on its own band, so neither reading order nor
    candidate ranking can contribute. The union across engines is therefore an upper bound
    on exact-title recovery achievable on this corpus. If that bound sits below the final
    production gate, the corpus cannot demonstrate gate compliance for *any* OCR model, and
    an engine's score on it cannot be attributed to engine capability.
    """
    if not probes:
        return {"measured": False, "reason": "no stroke probe available"}
    case_ids = sorted({record["case_id"] for probe in probes.values() for record in probe["records"]})
    outcomes = {
        engine: {record["case_id"]: record for record in probe["records"]} for engine, probe in probes.items()
    }
    def union(variant: str) -> list[str]:
        return [
            case_id
            for case_id in case_ids
            if any(
                case_id in outcomes[engine] and outcomes[engine][case_id][variant]["exact"] for engine in outcomes
            )
        ]

    with_stroke = union("stroke")
    without_stroke = union("no_stroke")
    ceiling = len(without_stroke) / len(case_ids) if case_ids else None
    return {
        "measured": True,
        "probe_schema": "pp1-ocr-stroke-probe/v1",
        "method": "each title rendered alone on its own band; only the corpus stroke_width differs",
        "engines": {
            engine: {
                "stroke_exact_count": probe["stroke_exact_count"],
                "no_stroke_exact_count": probe["no_stroke_exact_count"],
                "recovered_only_without_stroke": probe["recovered_only_without_stroke"],
                "recovered_only_with_stroke": probe["recovered_only_with_stroke"],
            }
            for engine, probe in sorted(probes.items())
        },
        "case_count": len(case_ids),
        "union_recoverable_with_stroke": len(with_stroke),
        "union_recoverable_without_stroke": len(without_stroke),
        "instrument_ceiling_rate": ceiling,
        "final_gate_exact_title_minimum": FINAL_EXACT_TITLE_GATE,
        "instrument_supports_final_gate": ceiling is not None and ceiling >= FINAL_EXACT_TITLE_GATE,
        "unrecoverable_case_ids": [case_id for case_id in case_ids if case_id not in set(without_stroke)],
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
    validity = instrument_validity(probes)
    # A corpus that cannot itself reach the production gate cannot support a model-capability
    # verdict, so it is treated as insufficient evidence rather than as engine failure.
    conflicting = bool(conflicting or (validity.get("measured") and not validity["instrument_supports_final_gate"]))
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
        "instrument_validity": validity,
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

    validity = report["instrument_validity"]
    if validity.get("measured"):
        if validity["case_count"] <= 0:
            raise ValueError("instrument validity must cover at least one case")
        expected_ceiling = validity["union_recoverable_without_stroke"] / validity["case_count"]
        if abs(validity["instrument_ceiling_rate"] - expected_ceiling) > 1e-12:
            raise ValueError("stored instrument ceiling arithmetic is inconsistent")
        if validity["union_recoverable_without_stroke"] > validity["case_count"]:
            raise ValueError("instrument ceiling exceeds the case count")
        if len(validity["unrecoverable_case_ids"]) != validity["case_count"] - validity[
            "union_recoverable_without_stroke"
        ]:
            raise ValueError("stored unrecoverable case list is inconsistent with the instrument ceiling")
        if validity["final_gate_exact_title_minimum"] != FINAL_EXACT_TITLE_GATE:
            raise ValueError("instrument validity must compare against the unchanged final gate")
        supports = expected_ceiling >= FINAL_EXACT_TITLE_GATE
        if validity["instrument_supports_final_gate"] != supports:
            raise ValueError("stored instrument-validity verdict is inconsistent")
        if not supports and report["evidence_conflicting"] is not True:
            raise ValueError("a corpus below the final gate must be recorded as insufficient evidence")

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
