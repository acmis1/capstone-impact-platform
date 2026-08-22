from __future__ import annotations

import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from assistive_validation_benchmark.ocr_iteration2_holdout_protocol import (
    PROTOCOL_VERSION,
    holdout_contract,
    manifest as manifest_module,
    renderer as renderer_module,
    schema as schema_module,
)
from assistive_validation_benchmark.ocr_iteration2_holdout_protocol.fingerprint import (
    RendererFingerprintMismatch,
    compute_fingerprint,
    environment_path,
    require_canonical_renderer,
    validate_environment,
    verify_fingerprint,
)
from assistive_validation_benchmark.ocr_iteration2_holdout_protocol.holdout_contract import (
    holdout_non_reuse_evidence,
    validate_holdout_corpus,
)
from assistive_validation_benchmark.ocr_iteration2_holdout_protocol.manifest import (
    build_freeze_manifest,
    manifest_path,
    verify_freeze_commit,
    verify_freeze_manifest,
)
from assistive_validation_benchmark.ocr_iteration2_holdout_protocol.renderer import (
    REFERENCE_FIXTURE,
    draw_holdout_poster,
    generate_holdout_assets,
    reference_digests,
    reference_text,
    render_reference_fixture,
    render_tracking_pair,
)
from assistive_validation_benchmark.ocr_iteration2_holdout_protocol.report import validate_freeze_evidence
from assistive_validation_benchmark.ocr_iteration2_holdout_protocol.schema import (
    ALLOWED_DECISIONS,
    HOLDOUT_CASE_ID,
    assert_no_holdout_content,
    check_inputs,
    data_root,
    load_json,
    repository_root,
    tool_root,
    validate_protocol,
)


EVIDENCE = repository_root() / "docs" / "assistive-validation" / "evidence" / "ocr-productionization-iteration2-holdout-protocol.json"
DISTRACTOR_KINDS = (
    "school_or_faculty_masthead",
    "program_name",
    "discipline",
    "unit_or_course_code",
    "year_or_date",
    "supervisor_label",
    "category_or_tag",
    "event_or_showcase_heading",
    "team_label",
)
MEDIA_SEQUENCE = ["png"] * 14 + ["jpeg"] * 13 + ["scanned_pdf"] * 13
LAYOUT_SEQUENCE = ["one_column"] * 14 + ["two_column"] * 13 + ["three_column"] * 13
SUFFIX = {"png": ".png", "jpeg": ".jpg", "scanned_pdf": ".pdf"}
NEGATIVES = {
    30: "one_character_material",
    31: "one_character_material",
    32: "one_word_material",
    33: "one_word_material",
    34: "semantically_related_incorrect",
    35: "semantically_related_incorrect",
    36: "number_or_version",
    37: "number_or_version",
    38: "punctuation_only_non_material",
    39: "punctuation_only_non_material",
}


def scored_id(index: int) -> str:
    """Build a future-namespace identifier at runtime; no such literal exists in this branch."""
    return "ocr2h-" + f"{index + 1:03d}"


def synthetic_title(index: int) -> str:
    return f"Fixture {index:02d} — Multi-Modal CO₂ Café ‘Sensor’ Study (AI) – Draft"


def synthetic_sections(index: int) -> list[str]:
    return [
        f"Background section for synthetic fixture {index:02d} with sufficient descriptive length.",
        f"Method section for synthetic fixture {index:02d} describing the deterministic procedure.",
        f"Evidence section for synthetic fixture {index:02d} recording bounded synthetic outcomes.",
    ]


def synthetic_style(index: int) -> str:
    if index < 6:
        return "wrapped"
    if index < 9:
        return "tracked"
    if index < 12:
        return "shadow"
    if index < 14:
        return "outlined"
    return "plain"


def synthetic_distractors(index: int) -> list[dict[str, str]]:
    distractors: list[dict[str, str]] = []
    if index < 36:
        distractors.append(
            {"kind": DISTRACTOR_KINDS[index % 9], "text": f"School of Synthetic Studies {index:02d}", "position": "above"}
        )
    if index < 20:
        distractors.append(
            {"kind": DISTRACTOR_KINDS[(index + 4) % 9], "text": f"Supervisor: Dr Synthetic {index:02d}", "position": "near"}
        )
    return distractors


def synthetic_case(index: int) -> dict[str, object]:
    identifier = scored_id(index)
    media = MEDIA_SEQUENCE[index]
    negative = NEGATIVES.get(index)
    title = synthetic_title(index)
    if negative in {"one_character_material", "one_word_material", "semantically_related_incorrect", "number_or_version"}:
        metadata_title = title.replace("Sensor", "Censor") + f" {negative[:4]}"
        agreement = False
    elif negative == "punctuation_only_non_material":
        metadata_title = title.replace("‘", "'").replace("’", "'")
        agreement = True
    else:
        metadata_title = title
        agreement = True
    tags: list[str] = []
    if index < 8:
        tags.append("low_resolution")
    if 8 <= index < 16:
        tags.append("small_body_text")
    if index < 3:
        tags.append("australian_english")
    if 3 <= index < 6:
        tags.append("technical_vocabulary")
    style = synthetic_style(index)
    return {
        "id": identifier,
        "split": "holdout",
        "asset": f"{identifier}{SUFFIX[media]}",
        "media": media,
        "layout": LAYOUT_SEQUENCE[index],
        "difficulty": "clean" if index % 2 == 0 else "challenging",
        "width": 760 if "low_resolution" in tags else 1280,
        "height": 560 if "low_resolution" in tags else 960,
        "title": title,
        "metadata_title": metadata_title,
        "expected_agreement": agreement,
        "negative_kind": negative,
        "body_sections": synthetic_sections(index),
        "title_style": style,
        "tracking_px": 2 if style == "tracked" else 0,
        "contrast": "medium" if index < 20 else "high",
        "noise": "mild" if index < 10 else "none",
        "jpeg_quality": 72 if media == "jpeg" else 95,
        "distractors": synthetic_distractors(index),
        "tags": tags,
    }


def synthetic_corpus() -> dict[str, object]:
    warmup = synthetic_case(0)
    warmup.update(
        {
            "id": "ocr2h-warmup-" + "001",
            "split": "warmup",
            "asset": "ocr2h-warmup-" + "001.png",
            "media": "png",
            "negative_kind": None,
            "expected_agreement": True,
            "metadata_title": warmup["title"],
        }
    )
    return {
        "schema_version": holdout_contract.HOLDOUT_CORPUS_SCHEMA_VERSION,
        "corpus_version": holdout_contract.HOLDOUT_CORPUS_VERSION,
        "part": "holdout",
        "measurement_role": "independent_holdout",
        "independent_holdout": True,
        "seed": 2026082301,
        "ocr_cases": [synthetic_case(index) for index in range(40)] + [warmup],
        "native_controls": [
            {
                "id": "ocr2h-native-" + f"{index:03d}",
                "asset": "ocr2h-native-" + f"{index:03d}.pdf",
                "title": f"Native control {index}",
                "body": "Born-digital control body text.",
                "layout": "one_column",
            }
            for index in (1, 2, 3)
        ],
        "security_controls": [
            {"id": "ocr2h-security-" + "001", "asset": "ocr2h-security-" + "001.pdf", "kind": "malformed_pdf"},
            {"id": "ocr2h-security-" + "002", "asset": "ocr2h-security-" + "002.png", "kind": "truncated_image"},
        ],
    }


class ProtocolFreezeContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.protocol = validate_protocol(load_json(data_root() / "protocol.json"))

    def test_protocol_freezes_the_calibration_selected_candidate_and_configuration(self) -> None:
        self.assertEqual("paddle-small", self.protocol["candidate"]["engine"])
        self.assertEqual("PP-OCRv6_small_det_infer", self.protocol["candidate"]["detection_artifact"])
        self.assertEqual("PP-OCRv6_small_rec_infer", self.protocol["candidate"]["recognition_artifact"])
        self.assertEqual(180, self.protocol["raster_contract"]["raster_dpi"])
        self.assertEqual(1920, self.protocol["raster_contract"]["max_input_dimension"])
        self.assertEqual("first_bounded_group@geometry", self.protocol["title_contract"]["selector_id"])
        self.assertEqual("column", self.protocol["wer_contract"]["primary_order"])
        self.assertEqual(["paddle-small"], self.protocol["candidates"])
        self.assertEqual([], self.protocol["additional_candidates"])

    def test_freeze_branch_creates_no_holdout_and_authorizes_no_selection(self) -> None:
        for key in ("holdout_created", "holdout_measurement_exists", "ocr_executed", "production_selection_authorized"):
            self.assertIs(self.protocol[key], False)
        self.assertEqual([], self.protocol["instantiated_holdout_case_ids"])
        self.assertEqual(ALLOWED_DECISIONS, set(self.protocol["decision_contract"]["allowed_decisions"]))

    def test_quality_gate_cannot_be_weakened(self) -> None:
        for key, value in (("exact_title_rate_minimum", 0.9), ("primary_mean_wer_maximum", 0.15), ("minimum_exact_titles", 30)):
            weakened = copy.deepcopy(self.protocol)
            weakened["quality_gate"][key] = value
            with self.assertRaisesRegex(ValueError, "quality gate"):
                validate_protocol(weakened)

    def test_operational_ceilings_cannot_be_loosened(self) -> None:
        loosened = copy.deepcopy(self.protocol)
        loosened["operational_gate"]["ceilings"]["p50_ms_maximum"] = 30000
        with self.assertRaisesRegex(ValueError, "operational ceilings"):
            validate_protocol(loosened)

    def test_stored_booleans_may_not_override_raw_operational_measurements(self) -> None:
        overridden = copy.deepcopy(self.protocol)
        overridden["operational_gate"]["stored_boolean_override_permitted"] = True
        with self.assertRaisesRegex(ValueError, "stored booleans"):
            validate_protocol(overridden)

    def test_a_second_ocr_candidate_is_refused(self) -> None:
        reopened = copy.deepcopy(self.protocol)
        reopened["candidates"] = ["paddle-small", "paddleocr-vl"]
        with self.assertRaisesRegex(ValueError, "calibration-selected challenger"):
            validate_protocol(reopened)

    def test_per_page_and_oracle_wer_selection_are_refused(self) -> None:
        for key in ("per_page_order_selection_permitted", "ground_truth_order_selection_permitted", "best_of_oracle_primary_permitted"):
            reopened = copy.deepcopy(self.protocol)
            reopened["wer_contract"][key] = True
            with self.assertRaisesRegex(ValueError, "WER contract"):
                validate_protocol(reopened)

    def test_semantic_similarity_may_never_create_automatic_agreement(self) -> None:
        unsafe = copy.deepcopy(self.protocol)
        unsafe["title_contract"]["semantic_similarity_may_create_automatic_agreement"] = True
        with self.assertRaisesRegex(ValueError, "material mismatch"):
            validate_protocol(unsafe)

    def test_raster_contract_forbids_upscaling_cropping_and_per_case_switching(self) -> None:
        for key in ("upscaling_permitted", "crop_permitted", "per_case_switching_permitted", "label_guided_preprocessing_permitted"):
            relaxed = copy.deepcopy(self.protocol)
            relaxed["raster_contract"][key] = True
            with self.assertRaisesRegex(ValueError, "raster contract"):
                validate_protocol(relaxed)

    def test_one_shot_and_supersession_rules_are_frozen(self) -> None:
        future = self.protocol["future_run_contract"]
        self.assertEqual(1, future["holdout_runs"])
        self.assertIs(future["post_result_tuning_permitted"], False)
        self.assertEqual(12, len(future["ordered_steps"]))
        self.assertIs(future["protocol_bug_supersession"]["retune_and_rerun_same_holdout_permitted"], False)
        retuned = copy.deepcopy(self.protocol)
        retuned["future_run_contract"]["protocol_bug_supersession"]["retune_and_rerun_same_holdout_permitted"] = True
        with self.assertRaisesRegex(ValueError, "rerun as though independent"):
            validate_protocol(retuned)

    def test_near_miss_may_not_select(self) -> None:
        lenient = copy.deepcopy(self.protocol)
        lenient["decision_contract"]["near_miss_may_select"] = True
        with self.assertRaisesRegex(ValueError, "near miss"):
            validate_protocol(lenient)


class NoHoldoutGuardTests(unittest.TestCase):
    def test_freeze_branch_contains_no_holdout_material(self) -> None:
        assertion = assert_no_holdout_content()
        self.assertIs(assertion["holdout_created"], False)
        self.assertIs(assertion["ocr_executed"], False)
        self.assertEqual(0, assertion["holdout_artifact_count"])
        self.assertEqual(0, assertion["instantiated_holdout_case_id_count"])
        self.assertFalse((data_root() / "corpus").exists())
        self.assertFalse((data_root() / "holdout.json").exists())

    def test_future_case_id_namespace_has_no_instance(self) -> None:
        self.assertTrue(HOLDOUT_CASE_ID.fullmatch(scored_id(0)))
        for path in schema_module.scanned_paths():
            if path.suffix.casefold() in {".py", ".json", ".md"}:
                self.assertIsNone(
                    schema_module.FORBIDDEN_TEXT_PATTERNS["instantiated future holdout case ID"].search(
                        path.read_text(encoding="utf-8")
                    ),
                    f"{path} instantiates a future holdout case ID",
                )

    def test_guard_rejects_an_accidental_holdout_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "holdout.json").write_text("{}", encoding="utf-8")
            with mock.patch.object(schema_module, "data_root", return_value=root):
                with self.assertRaisesRegex(ValueError, "holdout artifacts"):
                    assert_no_holdout_content()

    def test_guard_rejects_an_instantiated_case_id(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "cases.json").write_text(json.dumps({"id": scored_id(6)}), encoding="utf-8")
            with mock.patch.object(schema_module, "data_root", return_value=root):
                with self.assertRaisesRegex(ValueError, "holdout case ID"):
                    assert_no_holdout_content()

    def test_guard_rejects_a_generated_holdout_asset(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "poster.png").write_bytes(b"\x89PNG\r\n\x1a\n")
            with mock.patch.object(schema_module, "data_root", return_value=root):
                with self.assertRaisesRegex(ValueError, "holdout artifacts"):
                    assert_no_holdout_content()

    def test_guard_rejects_a_holdout_result_or_production_selection(self) -> None:
        # Keys are assembled at runtime so this test file never contains a literal that its own
        # guard would (correctly) reject.
        payloads = (
            {"final_holdout" + "_metrics": {"exact_title_rate": 1.0}},
            {"holdout" + "_capture": {"records": []}},
            {"production_select" + "_classification": True},
            {"production_selection" + "_authorized": True},
        )
        for payload in payloads:
            with tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                (root / "result.json").write_text(json.dumps(payload), encoding="utf-8")
                with mock.patch.object(schema_module, "data_root", return_value=root):
                    with self.assertRaisesRegex(ValueError, "forbidden"):
                        assert_no_holdout_content()


class FreezeManifestTests(unittest.TestCase):
    def setUp(self) -> None:
        self.stored = load_json(manifest_path())

    def test_stored_manifest_matches_the_frozen_tree(self) -> None:
        result = verify_freeze_manifest(self.stored)
        self.assertEqual(self.stored["component_count"], result["component_count"])
        self.assertEqual(build_freeze_manifest()["freeze_tree_sha256"], result["freeze_tree_sha256"])

    def test_manifest_binds_no_production_code(self) -> None:
        self.assertIs(self.stored["binds_production_code"], False)
        for relative in self.stored["components"]:
            self.assertFalse(relative.startswith("apps/"), relative)
            self.assertFalse(relative.startswith("infra/"), relative)
            self.assertTrue(relative.startswith("tools/assistive-validation-benchmark/"), relative)

    def test_manifest_binds_every_result_moving_component(self) -> None:
        roles = {entry["role"] for entry in self.stored["components"].values()}
        for role in (
            "protocol_file",
            "holdout_schema_and_generator_contract",
            "ocr_candidate_artifact_manifest",
            "title_candidate_selector",
            "deterministic_reading_order",
            "title_normalization_and_safety",
            "metrics_and_operational_gate",
            "canonical_renderer_definition",
            "renderer_and_reference_fixture",
            "renderer_fingerprint",
            "pinned_font_blob",
            "offline_network_guard",
            "offline_provisioning_and_artifact_verification",
        ):
            self.assertIn(role, roles)

    def test_a_changed_component_is_named(self) -> None:
        tampered = copy.deepcopy(self.stored)
        target = "tools/assistive-validation-benchmark/ocr-iteration2-holdout-protocol/protocol.json"
        tampered["components"][target]["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "protocol.json"):
            verify_freeze_manifest(tampered)

    def test_a_removed_component_is_detected(self) -> None:
        tampered = copy.deepcopy(self.stored)
        tampered["components"].pop(next(iter(tampered["components"])))
        with self.assertRaisesRegex(ValueError, "component set changed"):
            verify_freeze_manifest(tampered)

    def test_unreachable_freeze_commit_falls_back_to_the_content_addressed_tree(self) -> None:
        absent = "0" * 40
        result = verify_freeze_commit(absent)
        self.assertIs(result["commit_object_reachable"], False)
        self.assertEqual("content_addressed_freeze_tree_only", result["verification_basis"])
        self.assertEqual(build_freeze_manifest()["freeze_tree_sha256"], result["freeze_tree_sha256"])
        with self.assertRaisesRegex(ValueError, "reachable full commit SHA"):
            verify_freeze_commit(absent, require_commit_object=True)


class FreezeCommitRecordTests(unittest.TestCase):
    """The chronology record is verification metadata only; it adds no freeze material."""

    def setUp(self) -> None:
        self.path = data_root() / "freeze-commit.json"
        if not self.path.is_file():
            self.skipTest("the freeze chronology record is added by the second freeze commit")
        self.record = load_json(self.path)

    def test_record_matches_the_content_addressed_freeze(self) -> None:
        result = manifest_module.validate_freeze_commit_record(self.record)
        self.assertEqual(build_freeze_manifest()["freeze_tree_sha256"], result["freeze_tree_sha256"])
        self.assertIs(result["content_addressed_match"], True)
        self.assertIs(self.record["holdout_absent_at_freeze"], True)
        self.assertEqual(29, self.record["component_count"])

    def test_record_is_rejected_when_the_frozen_tree_moves(self) -> None:
        tampered = copy.deepcopy(self.record)
        tampered["freeze_tree_sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "freeze tree digest"):
            manifest_module.validate_freeze_commit_record(tampered)

    def test_record_is_rejected_when_it_admits_holdout_content(self) -> None:
        tampered = copy.deepcopy(self.record)
        tampered["holdout_absent_at_freeze"] = False
        with self.assertRaisesRegex(ValueError, "existed at the freeze"):
            manifest_module.validate_freeze_commit_record(tampered)


class CanonicalRendererTests(unittest.TestCase):
    def setUp(self) -> None:
        self.environment = validate_environment(load_json(environment_path()))

    def test_running_environment_is_the_canonical_renderer(self) -> None:
        result = verify_fingerprint(self.environment)
        self.assertEqual([], result["divergent_binding_components"])
        self.assertIs(result["matches_canonical_renderer"], True)
        self.assertEqual(result["expected_fingerprint_sha256"], result["observed_fingerprint_sha256"])

    def test_environment_pins_the_toolchain_and_forbids_a_host_font_stack(self) -> None:
        self.assertEqual("3.11", self.environment["pinned_toolchain"]["python_major_minor"])
        self.assertEqual("12.3.0", self.environment["pinned_toolchain"]["pillow"])
        self.assertEqual("2.14.3", self.environment["pinned_toolchain"]["freetype"])
        self.assertEqual("5.13.0", self.environment["pinned_toolchain"]["pypdfium2"])
        self.assertIs(self.environment["system_font_fallback"], False)
        self.assertIs(self.environment["runtime_font_download"], False)
        self.assertIs(self.environment["network_during_generation"], False)
        self.assertIs(self.environment["floating_version_tags_permitted"], False)
        self.assertTrue(self.environment["attested_platforms"])

    def test_unpinned_or_host_font_environment_is_refused(self) -> None:
        for mutation in (
            {"floating_version_tags_permitted": True},
            {"system_font_fallback": True},
            {"runtime_font_download": True},
            {"pinned_toolchain": {"python_major_minor": "3.11", "pillow": "latest", "freetype": "2.14.3", "pypdfium2": "5.13.0"}},
            {"attested_platforms": []},
        ):
            broken = copy.deepcopy(self.environment)
            broken.update(mutation)
            with self.assertRaises(ValueError):
                validate_environment(broken)

    def test_stored_fingerprint_digest_must_follow_its_own_binding(self) -> None:
        broken = copy.deepcopy(self.environment)
        broken["fingerprint"]["binding"]["pillow"] = "11.0.0"
        with self.assertRaisesRegex(ValueError, "does not follow its own binding"):
            validate_environment(broken)

    def test_a_divergent_toolchain_refuses_holdout_generation(self) -> None:
        from assistive_validation_benchmark.ocr_iteration2_holdout_protocol.schema import value_sha256

        tampered = copy.deepcopy(self.environment)
        tampered["fingerprint"]["binding"]["pillow"] = "11.0.0"
        tampered["fingerprint"]["fingerprint_sha256"] = value_sha256(tampered["fingerprint"]["binding"])
        result = verify_fingerprint(tampered)
        self.assertIs(result["matches_canonical_renderer"], False)
        self.assertIn("pillow", result["divergent_binding_components"])
        with self.assertRaisesRegex(RendererFingerprintMismatch, "pillow"):
            require_canonical_renderer(tampered)

    def test_reference_fixture_is_deterministic_and_explicitly_unscored(self) -> None:
        self.assertIs(REFERENCE_FIXTURE["scored"], False)
        self.assertIs(REFERENCE_FIXTURE["holdout_content"], False)
        self.assertIs(REFERENCE_FIXTURE["reaches_ocr"], False)
        first, second = render_reference_fixture(), render_reference_fixture()
        try:
            self.assertEqual(first.tobytes(), second.tobytes())
        finally:
            first.close()
            second.close()
        self.assertEqual(reference_digests()["binding"], reference_digests()["binding"])

    def test_measured_fingerprint_binds_every_declared_component(self) -> None:
        binding = compute_fingerprint()["binding"]
        for key in (
            "environment_id",
            "python_major_minor",
            "pillow",
            "freetype",
            "pypdfium2",
            "font_sha256",
            "renderer_source_sha256",
            "reference_fixture_spec_sha256",
            "reference_fixture_binding_digests",
        ):
            self.assertIn(key, binding)


class HoldoutDistributionContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.protocol = validate_protocol(load_json(data_root() / "protocol.json"))
        self.corpus = synthetic_corpus()

    def test_a_conforming_future_corpus_validates(self) -> None:
        summary = validate_holdout_corpus(self.corpus, self.protocol)
        self.assertEqual(40, summary["scored_case_count"])
        self.assertEqual({"png": 14, "jpeg": 13, "scanned_pdf": 13}, summary["media"])
        self.assertEqual({"clean": 20, "challenging": 20}, summary["difficulty"])
        self.assertGreaterEqual(summary["distractors"]["cases_with_distractor_above_title"], 32)
        self.assertLessEqual(summary["distractors"]["cases_with_title_as_topmost_region"], 8)
        self.assertGreaterEqual(summary["material_negative_count"], 8)
        self.assertIs(summary["controls_counted_toward_quality_rates"], False)
        self.assertTrue(all(summary["title_text_coverage"].values()))

    def test_a_corpus_of_the_wrong_size_is_refused(self) -> None:
        short = copy.deepcopy(self.corpus)
        short["ocr_cases"] = [case for case in short["ocr_cases"] if case["id"] != scored_id(39)]
        with self.assertRaisesRegex(ValueError, "scored holdout case count"):
            validate_holdout_corpus(short, self.protocol)

    def test_a_corpus_without_upper_page_distractors_is_refused(self) -> None:
        flat = copy.deepcopy(self.corpus)
        for case in flat["ocr_cases"]:
            case["distractors"] = []
        with self.assertRaisesRegex(ValueError, "upper-page distractor"):
            validate_holdout_corpus(flat, self.protocol)

    def test_a_corpus_where_the_title_is_always_topmost_is_refused(self) -> None:
        topmost = copy.deepcopy(self.corpus)
        for case in topmost["ocr_cases"]:
            case["distractors"] = [item for item in case["distractors"] if item["position"] != "above"]
        with self.assertRaises(ValueError):
            validate_holdout_corpus(topmost, self.protocol)

    def test_too_few_material_negatives_are_refused(self) -> None:
        weak = copy.deepcopy(self.corpus)
        for case in weak["ocr_cases"]:
            if case["negative_kind"] in {"one_word_material", "semantically_related_incorrect", "number_or_version"}:
                case["negative_kind"] = None
                case["expected_agreement"] = True
        with self.assertRaisesRegex(ValueError, "material title negatives"):
            validate_holdout_corpus(weak, self.protocol)

    def test_a_material_negative_may_not_be_labelled_as_agreement(self) -> None:
        mislabelled = copy.deepcopy(self.corpus)
        for case in mislabelled["ocr_cases"]:
            if case["negative_kind"] == "one_character_material":
                case["expected_agreement"] = True
        with self.assertRaisesRegex(ValueError, "material title negative may not be labelled"):
            validate_holdout_corpus(mislabelled, self.protocol)

    def test_stroked_titles_may_not_exceed_the_minority_allowance(self) -> None:
        stroked = copy.deepcopy(self.corpus)
        for case in stroked["ocr_cases"]:
            if case["id"] in {scored_id(14), scored_id(15), scored_id(16)}:
                case["title_style"] = "outlined"
        with self.assertRaisesRegex(ValueError, "outlined titles exceed"):
            validate_holdout_corpus(stroked, self.protocol)

    def test_unstroked_titles_must_remain_the_majority(self) -> None:
        stroked = copy.deepcopy(self.corpus)
        for case in stroked["ocr_cases"]:
            if case["split"] == "holdout" and case["title_style"] == "plain":
                case["title_style"] = "shadow"
        with self.assertRaisesRegex(ValueError, "under-represented: plain"):
            validate_holdout_corpus(stroked, self.protocol)

    def test_visual_tracking_may_not_be_encoded_in_the_semantic_title(self) -> None:
        mutated = copy.deepcopy(self.corpus)
        for case in mutated["ocr_cases"]:
            if case["title_style"] == "tracked":
                case["title"] = "S p a c e d  Title Fixture"
        with self.assertRaisesRegex(ValueError, "repeated spaces"):
            validate_holdout_corpus(mutated, self.protocol)

    def test_non_reuse_evidence_detects_calibration_content(self) -> None:
        clean = holdout_non_reuse_evidence(self.corpus)
        self.assertEqual(0, clean["exact_title_body_reuse_count"])
        self.assertGreater(clean["historical_case_count"], 80)
        self.assertIs(clean["real_participant_or_project_data"], False)

        calibration = load_json(tool_root() / "ocr-iteration2-calibration" / "corpus" / "calibration.json")
        borrowed = next(case for case in calibration["ocr_cases"] if case["split"] == "calibration")
        reused = copy.deepcopy(self.corpus)
        reused["ocr_cases"][0]["title"] = borrowed["title"]
        reused["ocr_cases"][0]["body_sections"] = borrowed["body_sections"]
        self.assertEqual(1, holdout_non_reuse_evidence(reused)["exact_title_body_reuse_count"])


class FrozenRendererTests(unittest.TestCase):
    def setUp(self) -> None:
        self.case = synthetic_case(20)

    @staticmethod
    def first_ink_row(image, background: tuple[int, int, int]) -> int:
        pixels = image.load()
        start = max(8, image.height // 55) + 2
        for y in range(start, image.height):
            for x in range(0, image.width, 3):
                if pixels[x, y] != background:
                    return y
        return image.height

    def test_upper_page_distractors_stop_the_title_being_the_topmost_region(self) -> None:
        background = renderer_module.CONTRAST_PALETTES[self.case["contrast"]][0]
        without = copy.deepcopy(self.case)
        without["distractors"] = []
        with_distractor = copy.deepcopy(self.case)
        with_distractor["distractors"] = [
            {"kind": "school_or_faculty_masthead", "text": "School of Synthetic Studies", "position": "above"}
        ]
        plain_image = draw_holdout_poster(without, 2026082301)
        distracted_image = draw_holdout_poster(with_distractor, 2026082301)
        try:
            self.assertLess(
                self.first_ink_row(distracted_image, background),
                self.first_ink_row(plain_image, background),
            )
            self.assertNotEqual(plain_image.tobytes(), distracted_image.tobytes())
        finally:
            plain_image.close()
            distracted_image.close()

    def test_distractor_text_never_enters_the_reference_text(self) -> None:
        text = reference_text(self.case)
        for distractor in synthetic_distractors(20):
            self.assertNotIn(distractor["text"], text)
        self.assertIn(self.case["title"], text)

    def test_visual_tracking_changes_pixels_but_not_the_semantic_title(self) -> None:
        tracked = synthetic_case(6)
        self.assertEqual("tracked", tracked["title_style"])
        before = tracked["title"]
        visual, untracked = render_tracking_pair(tracked, 2026082301)
        try:
            self.assertEqual(before, tracked["title"])
            self.assertNotIn("  ", tracked["title"])
            self.assertNotEqual(visual.tobytes(), untracked.tobytes())
        finally:
            visual.close()
            untracked.close()

    def test_rendering_is_deterministic_for_the_same_case_and_seed(self) -> None:
        first = draw_holdout_poster(self.case, 2026082301)
        second = draw_holdout_poster(self.case, 2026082301)
        try:
            self.assertEqual(first.tobytes(), second.tobytes())
        finally:
            first.close()
            second.close()

    def test_generation_refuses_outside_the_canonical_renderer(self) -> None:
        from assistive_validation_benchmark.ocr_iteration2_holdout_protocol import fingerprint as fingerprint_module

        def refuse(_environment: object | None = None) -> dict[str, object]:
            raise RendererFingerprintMismatch("renderer environment does not match the frozen canonical renderer")

        with tempfile.TemporaryDirectory() as temporary:
            with mock.patch.object(fingerprint_module, "require_canonical_renderer", refuse):
                with self.assertRaises(RendererFingerprintMismatch):
                    generate_holdout_assets(synthetic_corpus(), Path(temporary))
            self.assertEqual([], sorted(Path(temporary).iterdir()))


class FreezeEvidenceTests(unittest.TestCase):
    def test_stored_freeze_evidence_recomputes(self) -> None:
        result = validate_freeze_evidence(load_json(EVIDENCE))
        self.assertEqual(PROTOCOL_VERSION, result["protocol_version"])
        self.assertIs(result["holdout_created"], False)
        self.assertIs(result["ocr_executed"], False)
        self.assertIs(result["production_selection_authorized"], False)

    def test_evidence_separates_what_is_and_is_not_implemented(self) -> None:
        stored = load_json(EVIDENCE)
        self.assertIn("holdout_protocol_freeze", stored["implemented"])
        self.assertIn("canonical_renderer_environment", stored["implemented"])
        for item in ("fresh_holdout", "holdout_measurement", "production_ocr_provider", "production_select_classification"):
            self.assertIn(item, stored["not_implemented"])

    def test_production_boundary_is_historical_not_a_future_main_invariant(self) -> None:
        boundary = load_json(EVIDENCE)["production_boundary"]
        self.assertIn("not a permanent requirement", boundary["evidence_role"])
        self.assertEqual(["NONE", "TESSERACT"], boundary["production_ocr_task_providers"])
        self.assertEqual(33, boundary["migration_count"])
        self.assertIs(boundary["production_behavior_changed"], False)

    def test_altered_evidence_is_rejected(self) -> None:
        tampered = load_json(EVIDENCE)
        tampered["frozen_quality_gate"]["primary_mean_wer_maximum"] = 0.2
        with self.assertRaisesRegex(ValueError, "does not follow the frozen tree"):
            validate_freeze_evidence(tampered)

    def test_check_inputs_reports_the_frozen_protocol_and_no_holdout(self) -> None:
        checks = check_inputs()
        self.assertEqual(PROTOCOL_VERSION, checks["protocol_version"])
        self.assertEqual(40, checks["scored_case_count"])
        self.assertEqual(0, checks["no_holdout_assertion"]["holdout_artifact_count"])
        self.assertGreaterEqual(len(checks["historical_evidence"]), 6)


class FrozenAlgorithmIdentityTests(unittest.TestCase):
    def test_frozen_selector_and_ordering_are_the_reviewed_implementations(self) -> None:
        from assistive_validation_benchmark.ocr_failure_analysis.ordering import ORDERINGS
        from assistive_validation_benchmark.ocr_failure_analysis.selectors import SELECTORS

        protocol = validate_protocol(load_json(data_root() / "protocol.json"))
        self.assertIn(protocol["title_contract"]["selector"], SELECTORS)
        self.assertIn(protocol["title_contract"]["order"], ORDERINGS)
        self.assertIn(protocol["wer_contract"]["primary_order"], ORDERINGS)
        for order in protocol["wer_contract"]["required_diagnostic_orders"]:
            self.assertIn(order, ORDERINGS)

    def test_frozen_sources_are_bound_by_the_manifest(self) -> None:
        protocol = validate_protocol(load_json(data_root() / "protocol.json"))
        components = set(load_json(manifest_path())["components"])
        prefix = "tools/assistive-validation-benchmark/"
        for source in (
            protocol["title_contract"]["selector_source"],
            protocol["title_contract"]["order_source"],
            protocol["title_contract"]["normalization_source"],
            protocol["title_contract"]["safety_source"],
            protocol["wer_contract"]["ordering_source"],
            protocol["wer_contract"]["metric_source"],
            protocol["operational_gate"]["implementation_source"],
            protocol["raster_contract"]["implementation_source"],
            protocol["corpus_freshness_rule"]["implementation_source"],
        ):
            self.assertIn(prefix + source, components, source)

    def test_operational_ceilings_match_the_merged_calibration_protocol(self) -> None:
        protocol = validate_protocol(load_json(data_root() / "protocol.json"))
        calibration = load_json(tool_root() / "ocr-iteration2-calibration" / "protocol.json")
        self.assertEqual(calibration["operational_ceilings"], protocol["operational_gate"]["ceilings"])
        self.assertEqual(
            calibration["future_holdout_gate"]["exact_title_rate_minimum"],
            protocol["quality_gate"]["exact_title_rate_minimum"],
        )
        self.assertEqual(
            calibration["future_holdout_gate"]["primary_mean_wer_maximum"],
            protocol["quality_gate"]["primary_mean_wer_maximum"],
        )


if __name__ == "__main__":
    unittest.main()
