"""Mechanical proof that this iteration reuses nothing from any exposed OCR corpus."""

from __future__ import annotations

import hashlib
import string
import unicodedata
from typing import Any, Callable

from ..ocr_iteration2_calibration.corpus import reference_text as iteration2_calibration_reference
from ..ocr_iteration2_holdout_protocol.renderer import reference_text as iteration2_holdout_reference
from ..ocr_iteration3.renderer import reference_text as iteration3_reference
from ..ocr_iteration4.renderer import reference_text as iteration4_reference
from ..ocr_title_consistency.renderer import reference_text as title_consistency_reference
from ..ocr_title_latency.renderer import reference_text as title_latency_reference
from .renderer import reference_text
from .schema import canonical_json_bytes, load_json, repository_root, value_sha256


# Every corpus whose text has already been exposed to a candidate, in tracked form.
HISTORICAL_CORPORA: tuple[tuple[str, Callable[[dict[str, Any]], str] | None], ...] = (
    ("tools/assistive-validation-benchmark/corpus/manifest.json", None),
    ("tools/assistive-validation-benchmark/ocr-productionization/corpus/calibration.json", None),
    ("tools/assistive-validation-benchmark/ocr-productionization/corpus/holdout.json", None),
    ("tools/assistive-validation-benchmark/ocr-iteration2-calibration/corpus/calibration.json", iteration2_calibration_reference),
    ("tools/assistive-validation-benchmark/ocr-iteration2-fresh-holdout/corpus/holdout.json", iteration2_holdout_reference),
    ("tools/assistive-validation-benchmark/ocr-iteration3-calibration/corpus/calibration.json", iteration3_reference),
    ("tools/assistive-validation-benchmark/ocr-iteration3-fresh-holdout/corpus/holdout.json", iteration3_reference),
    ("tools/assistive-validation-benchmark/ocr-iteration4-calibration/corpus/calibration.json", iteration4_reference),
    ("tools/assistive-validation-benchmark/ocr-title-consistency-calibration/corpus/calibration.json", title_consistency_reference),
    ("tools/assistive-validation-benchmark/ocr-title-consistency-holdout/corpus/holdout.json", title_consistency_reference),
    ("tools/assistive-validation-benchmark/ocr-title-latency-calibration/corpus/calibration.json", title_latency_reference),
    ("tools/assistive-validation-benchmark/ocr-title-latency-holdout/corpus/holdout.json", title_latency_reference),
)

_PUNCTUATION_TRANSLATION = {ord(character): " " for character in "‘’“”–—-:;,.()[]{}/\\!?\"'"}
EXPOSED_FINGERPRINTS_RELATIVE = (
    "docs/assistive-validation/evidence/ocr-title-fullpage-exposed-v1-fingerprints.json"
)
EXPOSED_FINGERPRINT_SCHEMA = "pp1-ocr-title-fullpage-exposed-fingerprints/v1"
EXPOSED_FINGERPRINT_ALGORITHM = "pp1-ocr-title-fullpage-irrevocable-fingerprint/v1"
_FINGERPRINT_RECORD_KEYS = {
    "ordinal",
    "case_id_sha256",
    "metadata_title_sha256",
    "visible_title_sha256",
    "full_reference_sha256",
    "case_signature_sha256",
}
_CASE_SIGNATURE_FIELDS = (
    "split",
    "media",
    "layout",
    "difficulty",
    "family",
    "expected_consistency",
    "title_style",
    "title_render_mode",
    "title_font_size",
    "title_top_ratio",
    "contrast",
    "noise",
    "blur_radius",
    "jpeg_quality",
    "width",
    "height",
)


def normalize_identity_text(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", str(value))
    return " ".join(normalized.translate(_PUNCTUATION_TRANSLATION).casefold().split())


def _text_sha256(value: str) -> str:
    return hashlib.sha256(normalize_identity_text(value).encode("utf-8")).hexdigest()


def irreversible_case_fingerprint(case: dict[str, Any], full_reference: str) -> dict[str, Any]:
    """Return only irreversible hashes of exposed content and its meaningful design."""
    metadata = str(case.get("metadata_title") or case.get("title") or case.get("poster_title") or "")
    visible = str(case.get("poster_title") or case.get("title") or "")
    metadata_hash = _text_sha256(metadata)
    visible_hash = _text_sha256(visible) if normalize_identity_text(visible) else None
    reference_hash = _text_sha256(full_reference)
    signature = {
        "metadata_title_sha256": metadata_hash,
        "visible_title_sha256": visible_hash,
        "full_reference_sha256": reference_hash,
        "design": {field: case.get(field) for field in _CASE_SIGNATURE_FIELDS},
    }
    return {
        "case_id_sha256": _text_sha256(str(case.get("id") or "")),
        "metadata_title_sha256": metadata_hash,
        "visible_title_sha256": visible_hash,
        "full_reference_sha256": reference_hash,
        "case_signature_sha256": hashlib.sha256(canonical_json_bytes(signature)).hexdigest(),
    }


def validate_exposed_fingerprint_manifest(value: dict[str, Any]) -> dict[str, Any]:
    """Validate that the quarantined evidence is complete, bounded and contains hashes only."""
    if value.get("schema_version") != EXPOSED_FINGERPRINT_SCHEMA:
        raise ValueError("unsupported exposed-holdout fingerprint manifest")
    algorithm = value.get("fingerprint_algorithm") or {}
    if algorithm.get("version") != EXPOSED_FINGERPRINT_ALGORITHM:
        raise ValueError("exposed-holdout fingerprint algorithm changed")
    corpus = value.get("corpus") or {}
    records = value.get("records")
    if (
        not isinstance(records, list)
        or corpus.get("scored_case_count") != 63
        or corpus.get("warmup_case_count") != 1
        or corpus.get("total_case_count") != len(records)
    ):
        raise ValueError("exposed-holdout fingerprint counts differ")
    hexadecimal = set(string.hexdigits.lower())
    for ordinal, record in enumerate(records):
        if not isinstance(record, dict) or set(record) != _FINGERPRINT_RECORD_KEYS:
            raise ValueError("exposed-holdout fingerprint record fields differ")
        if record.get("ordinal") != ordinal:
            raise ValueError("exposed-holdout fingerprint ordinal differs")
        for field in _FINGERPRINT_RECORD_KEYS - {"ordinal", "visible_title_sha256"}:
            digest = record.get(field)
            if not isinstance(digest, str) or len(digest) != 64 or not set(digest) <= hexadecimal:
                raise ValueError(f"invalid exposed-holdout digest: {field}")
        visible = record.get("visible_title_sha256")
        if visible is not None and (
            not isinstance(visible, str) or len(visible) != 64 or not set(visible) <= hexadecimal
        ):
            raise ValueError("invalid exposed-holdout visible-title digest")
    if value.get("records_sha256") != value_sha256(records):
        raise ValueError("exposed-holdout fingerprint aggregate differs")
    return value


def load_exposed_fingerprint_manifest() -> dict[str, Any]:
    return validate_exposed_fingerprint_manifest(load_json(repository_root() / EXPOSED_FINGERPRINTS_RELATIVE))


def exposed_fingerprint_reuse(
    current: list[dict[str, Any]],
    manifest: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Compare current hashed case records with the quarantined exposed design."""
    exposed = validate_exposed_fingerprint_manifest(manifest or load_exposed_fingerprint_manifest())
    records = exposed["records"]
    prior = {
        field: {record[field] for record in records if record[field] is not None}
        for field in (
            "metadata_title_sha256",
            "visible_title_sha256",
            "full_reference_sha256",
            "case_signature_sha256",
        )
    }
    reuse = {
        "metadata_titles": sorted(
            record["case_id"] for record in current if record["metadata_title_sha256"] in prior["metadata_title_sha256"]
        ),
        "visible_titles": sorted(
            record["case_id"]
            for record in current
            if record["visible_title_sha256"] is not None
            and record["visible_title_sha256"] in prior["visible_title_sha256"]
        ),
        "full_references": sorted(
            record["case_id"] for record in current if record["full_reference_sha256"] in prior["full_reference_sha256"]
        ),
        "case_signatures": sorted(
            record["case_id"] for record in current if record["case_signature_sha256"] in prior["case_signature_sha256"]
        ),
    }
    return {
        "manifest_path": EXPOSED_FINGERPRINTS_RELATIVE,
        "manifest_sha256": value_sha256(exposed),
        "fingerprint_case_count": len(records),
        "reuse_case_ids": reuse,
        "prohibited_reuse_count": sum(len(case_ids) for case_ids in reuse.values()),
    }


def _cases(value: dict[str, Any]) -> list[dict[str, Any]]:
    return list(value.get("ocr_cases") or value.get("cases") or [])


def _poster_title(case: dict[str, Any]) -> str:
    return str(case.get("poster_title") or case.get("title") or "")


def _metadata_title(case: dict[str, Any]) -> str:
    return str(case.get("metadata_title") or case.get("title") or case.get("poster_title") or "")


def _historical_reference(renderer: Callable[[dict[str, Any]], str] | None, case: dict[str, Any]) -> str:
    if renderer is not None:
        try:
            return renderer(case)
        except (KeyError, TypeError, ValueError):
            pass
    body = case.get("body")
    return "\n".join(part for part in (_poster_title(case), body if isinstance(body, str) else "") if part)


def _record(case_id: str, metadata_title: str, poster_title: str, full_reference: str) -> dict[str, str]:
    normalized_metadata = normalize_identity_text(metadata_title)
    normalized_poster = normalize_identity_text(poster_title)
    reference_hash = hashlib.sha256(normalize_identity_text(full_reference).encode("utf-8")).hexdigest()
    identity = "\0".join((normalized_metadata, normalized_poster, reference_hash))
    return {
        "case_id": case_id,
        "normalized_metadata_title": normalized_metadata,
        "normalized_poster_title": normalized_poster,
        "normalized_full_reference_sha256": reference_hash,
        "meaningful_case_identity_sha256": hashlib.sha256(identity.encode("utf-8")).hexdigest(),
    }


def non_reuse_evidence(corpus: dict[str, Any], *, split: str) -> dict[str, Any]:
    """Compare metadata title, poster title, full reference and case identity against history."""
    root = repository_root()
    prior_metadata: set[str] = set()
    prior_posters: set[str] = set()
    prior_references: set[str] = set()
    prior_identities: set[str] = set()
    sources = []
    historical_count = 0
    for relative, renderer in HISTORICAL_CORPORA:
        path = root / relative
        if not path.is_file():
            raise ValueError(f"historical OCR corpus is missing: {relative}")
        value = load_json(path)
        source_cases = _cases(value)
        historical_count += len(source_cases)
        sources.append({"path": relative, "case_count": len(source_cases), "sha256": value_sha256(value)})
        for case in source_cases:
            record = _record(
                str(case.get("id") or ""),
                _metadata_title(case),
                _poster_title(case),
                _historical_reference(renderer, case),
            )
            if record["normalized_metadata_title"]:
                prior_metadata.add(record["normalized_metadata_title"])
            if record["normalized_poster_title"]:
                prior_posters.add(record["normalized_poster_title"])
            prior_references.add(record["normalized_full_reference_sha256"])
            prior_identities.add(record["meaningful_case_identity_sha256"])
    selected_cases = [case for case in corpus["ocr_cases"] if case["split"] == split]
    records = [
        _record(case["id"], case["metadata_title"], case.get("poster_title") or "", reference_text(case))
        for case in selected_cases
    ]
    current_fingerprints = [
        {"case_id": case["id"], **irreversible_case_fingerprint(case, reference_text(case))}
        for case in selected_cases
    ]
    exposed_reuse = exposed_fingerprint_reuse(current_fingerprints)
    metadata_reuse = sorted(item["case_id"] for item in records if item["normalized_metadata_title"] in prior_metadata)
    poster_reuse = sorted(
        item["case_id"]
        for item in records
        if item["normalized_poster_title"] and item["normalized_poster_title"] in prior_posters
    )
    reference_reuse = sorted(item["case_id"] for item in records if item["normalized_full_reference_sha256"] in prior_references)
    identity_reuse = sorted(item["case_id"] for item in records if item["meaningful_case_identity_sha256"] in prior_identities)
    populated_posters = [item for item in records if item["normalized_poster_title"]]
    duplicates = {
        "metadata_titles": len({item["normalized_metadata_title"] for item in records}) != len(records),
        "poster_titles": len({item["normalized_poster_title"] for item in populated_posters}) != len(populated_posters),
        "full_references": len({item["normalized_full_reference_sha256"] for item in records}) != len(records),
        "meaningful_case_identities": len({item["meaningful_case_identity_sha256"] for item in records}) != len(records),
    }
    historical_prohibited_reuse_count = len(metadata_reuse) + len(poster_reuse) + len(reference_reuse) + len(identity_reuse)
    prohibited_reuse_count = historical_prohibited_reuse_count + exposed_reuse["prohibited_reuse_count"]
    return {
        "schema_version": "pp1-ocr-title-fullpage-non-reuse/v1",
        "role": split,
        "historical_corpus_count": len(sources),
        "historical_case_count": historical_count,
        "historical_sources": sources,
        "current_case_count": len(records),
        "normalized_metadata_title_reuse_case_ids": metadata_reuse,
        "normalized_poster_title_reuse_case_ids": poster_reuse,
        "normalized_full_reference_reuse_case_ids": reference_reuse,
        "meaningful_case_identity_reuse_case_ids": identity_reuse,
        "historical_prohibited_reuse_count": historical_prohibited_reuse_count,
        "exposed_invalid_holdout": exposed_reuse,
        "prohibited_reuse_count": prohibited_reuse_count,
        "duplicate_current": duplicates,
        "passed": not metadata_reuse
        and not poster_reuse
        and not reference_reuse
        and not identity_reuse
        and not any(duplicates.values())
        and exposed_reuse["prohibited_reuse_count"] == 0,
        "records": records,
    }


def calibration_non_reuse(corpus: dict[str, Any]) -> dict[str, Any]:
    return non_reuse_evidence(corpus, split="calibration")
