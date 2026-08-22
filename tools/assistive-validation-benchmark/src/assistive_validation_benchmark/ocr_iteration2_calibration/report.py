from __future__ import annotations

from pathlib import Path
from typing import Any

from . import SCHEMA_VERSION
from .corpus import evaluate_controls
from .schema import (
    ALLOWED_DECISIONS,
    assert_no_holdout_artifacts,
    check_inputs,
    corpus_novelty,
    data_root,
    load_json,
    repository_root,
    validate_corpus,
    validate_font_manifest,
    validate_protocol,
)
from .scoring import (
    OPERATIONAL_CHECK_KEYS,
    operational_checks,
    operational_measurements,
    score_capture,
    select_configuration,
)


LATENCY_COMPARABILITY_AUTHORITY = (
    "merged operational measurements remain authoritative; current calibration timing is machine-specific"
)
CURRENT_CONFIGURATION_CEILING_SEMANTICS = (
    "a current-configuration pass means only that this configuration does not violate the frozen ceilings on "
    "the calibration machine; it is a necessary condition and is not proof that the configuration meets the "
    "limits on every supported deployment machine"
)


def _merged_operational_gate(report: dict[str, Any]) -> dict[str, Any]:
    """Restate the merged benchmark's own operational gate under the Iteration 2 ceiling names."""
    gate = report["protocol"]["operational_gate"]
    return {
        "cold_start_ms_maximum": gate["cold_start_ms_maximum"],
        "p50_ms_maximum": gate["holdout_p50_ms_maximum"],
        "p95_ms_maximum": gate["holdout_p95_ms_maximum"],
        "peak_working_set_bytes_maximum": gate["peak_working_set_bytes_maximum"],
        "artifact_footprint_bytes_maximum": gate["artifact_footprint_bytes_maximum"],
        "per_case_timeout_seconds": gate["per_case_timeout_seconds"],
    }


def _merged_operational_evidence(operational_ceilings: dict[str, Any]) -> dict[str, Any]:
    """Recompute the historical operational prior from the merged benchmark's own raw measurements."""
    report = load_json(repository_root() / "docs" / "assistive-validation" / "evidence" / "ocr-productionization-report.json")
    if _merged_operational_gate(report) != operational_ceilings:
        raise ValueError("merged operational gate differs from the frozen Iteration 2 ceilings")
    result: dict[str, Any] = {}
    for engine, values in report["engines"].items():
        runtimes = [float(record["runtime_ms"]) for record in values["records"]]
        measurements = operational_measurements(
            cold_start_ms=values["cold_start_ms"],
            runtimes_ms=runtimes,
            peak_working_set_bytes=values["peak_working_set_bytes"],
            artifact_footprint_bytes=values["artifact_footprint_bytes"],
        )
        if (measurements["p50_ms"], measurements["p95_ms"]) != (values["latency"]["p50_ms"], values["latency"]["p95_ms"]):
            raise ValueError(f"merged latency summary does not follow its own per-case runtimes: {engine}")
        checks = operational_checks(measurements, operational_ceilings)
        if checks != {key: bool(values["gate_checks"][key]) for key in OPERATIONAL_CHECK_KEYS}:
            raise ValueError(f"merged operational verdict does not follow its own raw measurements: {engine}")
        result[engine] = {
            "source": "merged productionization benchmark; retained as cross-machine operational authority",
            "recomputed_from_merged_raw_measurements": True,
            **measurements,
            "checks": checks,
            "plausibly_inside_established_limits": all(checks.values()),
        }
    return result


def _capture_path(captures_dir: Path, engine: str, configuration_id: str) -> Path:
    return captures_dir / f"{engine}--{configuration_id}.json"


def _load_and_score(
    captures_dir: Path,
    engine: str,
    configuration_id: str,
    *,
    cases: list[dict[str, Any]],
    protocol: dict[str, Any],
) -> dict[str, Any]:
    capture = load_json(_capture_path(captures_dir, engine, configuration_id))
    if capture.get("engine") != engine or capture.get("configuration_id") != configuration_id:
        raise ValueError("capture filename and identity differ")
    return score_capture(
        capture,
        cases=cases,
        selector_contracts=protocol["selectors"],
        reading_orders=protocol["reading_orders"],
    )


def recommend_medium_configuration(captures_dir: Path) -> dict[str, Any]:
    protocol = validate_protocol(load_json(data_root() / "protocol.json"))
    corpus = validate_corpus(load_json(data_root() / "corpus" / "calibration.json"))
    cases = [case for case in corpus["ocr_cases"] if case["split"] == "calibration"]
    selector_priority = [item["id"] for item in protocol["selectors"]]
    order_priority = protocol["reading_orders"]
    ceilings = protocol["operational_ceilings"]
    merged_operational = _merged_operational_evidence(ceilings)
    candidates = []
    for engine in ("paddle-tiny", "paddle-small"):
        for configuration_id in protocol["staged_cost_policy"]["stage_1_configurations"]:
            scored = _load_and_score(captures_dir, engine, configuration_id, cases=cases, protocol=protocol)
            candidates.append(
                select_configuration(
                    scored,
                    selector_priority=selector_priority,
                    order_priority=order_priority,
                    development_gate=protocol["development_gate"],
                    historical_prior_checks=merged_operational[engine]["checks"],
                    operational_ceilings=ceilings,
                )
            )
    winner = max(
        candidates,
        key=lambda item: (
            item["selected_exact_title_rate"],
            -item["selected_primary_wer"],
            item["configuration_id"] == "dpi150-edge960",
        ),
    )
    return {
        "configuration_id": winner["configuration_id"],
        "basis_engine": winner["engine"],
        "basis_exact_title_rate": winner["selected_exact_title_rate"],
        "basis_primary_wer": winner["selected_primary_wer"],
        "rule": protocol["staged_cost_policy"]["stage_2_rule"],
    }


def recommend_medium_configuration_from_results(results: dict[str, dict[str, Any]]) -> str:
    candidates = [
        results[engine][configuration_id]
        for engine in ("paddle-tiny", "paddle-small")
        for configuration_id in ("dpi150-edge960", "dpi180-edge1920")
    ]
    return max(
        candidates,
        key=lambda item: (
            item["selected_exact_title_rate"],
            -item["selected_primary_wer"],
            item["configuration_id"] == "dpi150-edge960",
        ),
    )["configuration_id"]


def build_report(captures_dir: Path, generation: dict[str, Any]) -> dict[str, Any]:
    input_checks = check_inputs()
    protocol = validate_protocol(load_json(data_root() / "protocol.json"))
    corpus = validate_corpus(load_json(data_root() / "corpus" / "calibration.json"))
    font = validate_font_manifest(load_json(data_root() / "font" / "manifest.json"))
    cases = [case for case in corpus["ocr_cases"] if case["split"] == "calibration"]
    distribution = {
        key: {
            value: sum(case[key] == value for case in cases)
            for value in sorted({case[key] for case in cases})
        }
        for key in ("media", "layout", "difficulty", "title_style")
    }
    controls = evaluate_controls(corpus, captures_dir.parent / "corpus")
    selector_priority = [item["id"] for item in protocol["selectors"]]
    order_priority = protocol["reading_orders"]
    ceilings = protocol["operational_ceilings"]
    merged_operational = _merged_operational_evidence(ceilings)
    scored: dict[str, dict[str, Any]] = {}
    selected: dict[str, dict[str, Any]] = {}
    for engine in protocol["staged_cost_policy"]["stage_1_engines"]:
        scored[engine] = {}
        selected[engine] = {}
        for configuration_id in protocol["staged_cost_policy"]["stage_1_configurations"]:
            value = _load_and_score(captures_dir, engine, configuration_id, cases=cases, protocol=protocol)
            scored[engine][configuration_id] = value
            selected[engine][configuration_id] = select_configuration(
                value,
                selector_priority=selector_priority,
                order_priority=order_priority,
                development_gate=protocol["development_gate"],
                historical_prior_checks=merged_operational[engine]["checks"],
                operational_ceilings=ceilings,
            )

    raster_winner = recommend_medium_configuration(captures_dir)["configuration_id"]
    medium = _load_and_score(captures_dir, "paddle-medium", raster_winner, cases=cases, protocol=protocol)
    scored["paddle-medium"] = {raster_winner: medium}
    selected["paddle-medium"] = {
        raster_winner: select_configuration(
            medium,
            selector_priority=selector_priority,
            order_priority=order_priority,
            development_gate=protocol["development_gate"],
            historical_prior_checks=merged_operational["paddle-medium"]["checks"],
            operational_ceilings=ceilings,
        )
    }
    neural_candidates = [value for engine, configurations in selected.items() if engine.startswith("paddle-") for value in configurations.values()]
    chosen = max(
        neural_candidates,
        key=lambda item: (
            item["holdout_worthy"],
            item["selected_exact_title_rate"],
            -item["selected_primary_wer"],
            item["development_gate_checks"]["operational_plausibility"],
        ),
    )
    complete = all(
        not value["failures"] and len(value["records"]) == len(cases)
        for configurations in scored.values()
        for value in configurations.values()
    )
    scientific_integrity = {
        "measurement_role": "calibration_only",
        "independent_holdout": False,
        "production_selection_authorized": False,
        "unbiased_accuracy_claimed": False,
        "production_select_classification": False,
        "historical_evidence_mutated": False,
        "corpus_novelty_is_not_holdout_independence": True,
    }
    instrument_checks = {
        "validated_corrected_corpus_schema": True,
        "ordinary_titles_are_unstroked_majority": True,
        "outlined_title_is_labelled_minority": True,
        "tracking_is_visual_only": True,
        "unicode_font_and_glyphs_verified": True,
        "exact_historical_title_body_reuse_is_zero": input_checks["corpus_novelty"]["exact_title_body_reuse_count"] == 0,
        "historical_evidence_hashes_unchanged": True,
        "no_iteration2_holdout_artifact": input_checks["no_holdout_assertion"]["holdout_artifact_count"] == 0,
        "all_required_calibration_captures_complete": complete,
    }
    instrument_defensible = all(instrument_checks.values())
    if not instrument_defensible:
        decision = "NEEDS_MORE_OCR_CORPUS_CALIBRATION"
    elif any(candidate["holdout_worthy"] for candidate in neural_candidates):
        decision = "READY_TO_FREEZE_OCR_ITERATION_2_HOLDOUT_PROTOCOL"
    else:
        decision = "NEEDS_OCR_MODEL_CHALLENGER"
    if decision not in ALLOWED_DECISIONS:
        raise ValueError("calibration decision is outside the closed contract")
    return {
        "schema_version": SCHEMA_VERSION,
        "benchmark_version": protocol["benchmark_version"],
        "corpus": {
            "version": corpus["corpus_version"],
            "seed": corpus["seed"],
            "calibration_case_count": len(cases),
            "warmup_case_count": 1,
            "native_control_count": len(corpus["native_controls"]),
            "security_control_count": len(corpus["security_controls"]),
            "generation": generation,
            "novelty": corpus_novelty(corpus),
            "distribution": distribution,
            "controls": controls,
        },
        "renderer": {
            "identity": font,
            "title_stroke_policy": "normal titles use no stroke; one labelled outlined minority case uses a one-pixel outline",
            "letter_spacing_policy": "semantic title strings remain ordinary text; deterministic per-glyph pixel positioning applies visual tracking",
            "style_semantics": "tracking, wrapping, shadow and outline alter pixels only and never alter reference title text",
            "glyph_coverage": {
                "required_glyphs": font["required_glyphs"],
                "all_render_without_missing_glyph_substitution": True,
            },
        },
        "staged_cost_execution": {
            "stage_1_engines": protocol["staged_cost_policy"]["stage_1_engines"],
            "stage_1_configurations": protocol["staged_cost_policy"]["stage_1_configurations"],
            "medium_configuration_selected_from_stage_1": raster_winner,
        },
        "operational_ceilings": ceilings,
        "merged_operational_evidence": merged_operational,
        "latency_comparability": {
            "comparable_to_merged_machine": False,
            "authority": LATENCY_COMPARABILITY_AUTHORITY,
            "current_configuration_ceiling_semantics": CURRENT_CONFIGURATION_CEILING_SEMANTICS,
        },
        "captures": scored,
        "configuration_results": selected,
        "chosen_neural_configuration": {
            "engine": chosen["engine"],
            "configuration_id": chosen["configuration_id"],
            "selector": chosen["selected_selector"],
            "primary_reading_order": chosen["selected_reading_order"],
            "exact_title_rate": chosen["selected_exact_title_rate"],
            "primary_wer": chosen["selected_primary_wer"],
            "material_false_automatic_agreements": chosen["selected_material_false_automatic_agreements"],
            "holdout_worthy": chosen["holdout_worthy"],
        },
        "future_holdout_wer_contract": {
            "primary_order": chosen["selected_reading_order"],
            "applies_to_every_page": True,
            "provider_raw_order_reported_diagnostically": True,
            "per_case_best_of_oracle_forbidden": True,
        },
        "development_gate": protocol["development_gate"],
        "future_holdout_gate_unchanged": protocol["future_holdout_gate"],
        "instrument_checks": instrument_checks,
        "instrument_defensible": instrument_defensible,
        "scientific_integrity": scientific_integrity,
        "production_boundary": {
            "evidence_role": "historical starting-state evidence plus PR-relative scope guard; not a future-main invariant",
            "production_ocr_task_providers": ["NONE", "TESSERACT"],
            "coordinator_ocr_selection": "NONE",
            "migration_count": 33,
            "production_behavior_changed": False,
            "supabase_changed": False,
        },
        "decision": decision,
    }


def validate_report(report: dict[str, Any]) -> dict[str, Any]:
    if report.get("schema_version") != SCHEMA_VERSION:
        raise ValueError("unsupported stored Iteration 2 calibration evidence")
    protocol = validate_protocol(load_json(data_root() / "protocol.json"))
    input_checks = check_inputs()
    corpus = validate_corpus(load_json(data_root() / "corpus" / "calibration.json"))
    font = validate_font_manifest(load_json(data_root() / "font" / "manifest.json"))
    expected_corpus_identity = {
        "version": corpus["corpus_version"],
        "seed": corpus["seed"],
        "calibration_case_count": sum(case["split"] == "calibration" for case in corpus["ocr_cases"]),
        "warmup_case_count": 1,
        "native_control_count": len(corpus["native_controls"]),
        "security_control_count": len(corpus["security_controls"]),
        "novelty": corpus_novelty(corpus),
    }
    for key, expected in expected_corpus_identity.items():
        if report["corpus"].get(key) != expected:
            raise ValueError(f"stored corpus evidence changed: {key}")
    if report["renderer"].get("identity") != font:
        raise ValueError("stored renderer identity differs from the pinned font manifest")
    integrity = report.get("scientific_integrity", {})
    required_false = (
        "independent_holdout",
        "production_selection_authorized",
        "unbiased_accuracy_claimed",
        "production_select_classification",
        "historical_evidence_mutated",
    )
    if integrity.get("measurement_role") != "calibration_only" or any(integrity.get(key) is not False for key in required_false):
        raise ValueError("stored evidence violates the calibration-only integrity contract")
    if report.get("decision") not in ALLOWED_DECISIONS:
        raise ValueError("stored evidence decision is invalid")
    expected_engines = {
        "tesseract": {"dpi150-edge960", "dpi180-edge1920"},
        "paddle-tiny": {"dpi150-edge960", "dpi180-edge1920"},
        "paddle-small": {"dpi150-edge960", "dpi180-edge1920"},
        "paddle-medium": {report["staged_cost_execution"]["medium_configuration_selected_from_stage_1"]},
    }
    if set(report["captures"]) != set(expected_engines):
        raise ValueError("stored capture engine set differs from the staged protocol")
    selector_priority = [item["id"] for item in protocol["selectors"]]
    order_priority = protocol["reading_orders"]
    ceilings = protocol["operational_ceilings"]
    if report.get("operational_ceilings") != ceilings:
        raise ValueError("stored operational ceilings differ from the frozen protocol")
    merged_operational = _merged_operational_evidence(ceilings)
    if report.get("merged_operational_evidence") != merged_operational:
        raise ValueError("stored merged operational evidence differs from the immutable benchmark")
    if report.get("latency_comparability") != {
        "comparable_to_merged_machine": False,
        "authority": LATENCY_COMPARABILITY_AUTHORITY,
        "current_configuration_ceiling_semantics": CURRENT_CONFIGURATION_CEILING_SEMANTICS,
    }:
        raise ValueError("stored evidence hides or overstates cross-machine latency comparability")
    expected_stage1 = protocol["staged_cost_policy"]
    if (
        report["staged_cost_execution"].get("stage_1_engines") != expected_stage1["stage_1_engines"]
        or report["staged_cost_execution"].get("stage_1_configurations") != expected_stage1["stage_1_configurations"]
    ):
        raise ValueError("stored stage-1 execution differs from the staged-cost protocol")
    recomputed_selections: dict[str, dict[str, Any]] = {}
    for engine, configurations in report["captures"].items():
        if set(configurations) != expected_engines[engine]:
            raise ValueError(f"stored capture configurations differ from the staged protocol for {engine}")
        recomputed_selections[engine] = {}
        for configuration_id, scored in configurations.items():
            observed = select_configuration(
                scored,
                selector_priority=selector_priority,
                order_priority=order_priority,
                development_gate=protocol["development_gate"],
                historical_prior_checks=merged_operational[engine]["checks"],
                operational_ceilings=ceilings,
            )
            stored = report["configuration_results"][engine][configuration_id]
            if stored.get("operational_evidence") != observed["operational_evidence"]:
                raise ValueError(
                    "stored operational evidence does not follow the raw capture metrics for "
                    f"{engine}/{configuration_id}"
                )
            if stored != observed:
                raise ValueError(f"stored selection, arithmetic or gate changed for {engine}/{configuration_id}")
            recomputed_selections[engine][configuration_id] = observed
    medium_recommendation = recommend_medium_configuration_from_results(recomputed_selections)
    if report["staged_cost_execution"]["medium_configuration_selected_from_stage_1"] != medium_recommendation:
        raise ValueError("stored Medium raster configuration does not follow stage-1 evidence")
    candidates = [value for engine, configurations in recomputed_selections.items() if engine.startswith("paddle-") for value in configurations.values()]
    chosen = max(
        candidates,
        key=lambda item: (
            item["holdout_worthy"],
            item["selected_exact_title_rate"],
            -item["selected_primary_wer"],
            item["development_gate_checks"]["operational_plausibility"],
        ),
    )
    expected_chosen = {
        "engine": chosen["engine"],
        "configuration_id": chosen["configuration_id"],
        "selector": chosen["selected_selector"],
        "primary_reading_order": chosen["selected_reading_order"],
        "exact_title_rate": chosen["selected_exact_title_rate"],
        "primary_wer": chosen["selected_primary_wer"],
        "material_false_automatic_agreements": chosen["selected_material_false_automatic_agreements"],
        "holdout_worthy": chosen["holdout_worthy"],
    }
    if report["chosen_neural_configuration"] != expected_chosen:
        raise ValueError("stored chosen neural configuration does not follow calibration ranking")
    complete = all(
        not value["failures"] and len(value["records"]) == value["case_count"]
        for configurations in report["captures"].values()
        for value in configurations.values()
    )
    expected_instrument_checks = {
        "validated_corrected_corpus_schema": True,
        "ordinary_titles_are_unstroked_majority": True,
        "outlined_title_is_labelled_minority": True,
        "tracking_is_visual_only": True,
        "unicode_font_and_glyphs_verified": True,
        "exact_historical_title_body_reuse_is_zero": input_checks["corpus_novelty"]["exact_title_body_reuse_count"] == 0,
        "historical_evidence_hashes_unchanged": True,
        "no_iteration2_holdout_artifact": input_checks["no_holdout_assertion"]["holdout_artifact_count"] == 0,
        "all_required_calibration_captures_complete": complete,
    }
    if report["instrument_checks"] != expected_instrument_checks:
        raise ValueError("stored instrument checks do not follow current corpus validation")
    instrument_defensible = all(expected_instrument_checks.values())
    if report.get("instrument_defensible") is not instrument_defensible:
        raise ValueError("stored instrument-defensible classification changed")
    expected = (
        "NEEDS_MORE_OCR_CORPUS_CALIBRATION"
        if not instrument_defensible
        else "READY_TO_FREEZE_OCR_ITERATION_2_HOLDOUT_PROTOCOL"
        if any(candidate["holdout_worthy"] for candidate in candidates)
        else "NEEDS_OCR_MODEL_CHALLENGER"
    )
    if report["decision"] != expected:
        raise ValueError("stored calibration decision does not follow the development gate")
    if report["development_gate"] != protocol["development_gate"]:
        raise ValueError("stored development gate differs from the protocol")
    if report["future_holdout_gate_unchanged"] != protocol["future_holdout_gate"]:
        raise ValueError("stored future holdout gate differs from the unchanged protocol")
    expected_wer_contract = {
        "primary_order": chosen["selected_reading_order"],
        "applies_to_every_page": True,
        "provider_raw_order_reported_diagnostically": True,
        "per_case_best_of_oracle_forbidden": True,
    }
    if report["future_holdout_wer_contract"] != expected_wer_contract:
        raise ValueError("stored future WER contract does not follow the selected calibration order")
    expected_boundary = {
        "evidence_role": "historical starting-state evidence plus PR-relative scope guard; not a future-main invariant",
        "production_ocr_task_providers": ["NONE", "TESSERACT"],
        "coordinator_ocr_selection": "NONE",
        "migration_count": 33,
        "production_behavior_changed": False,
        "supabase_changed": False,
    }
    if report.get("production_boundary") != expected_boundary:
        raise ValueError("stored historical production boundary changed")
    return report
