from __future__ import annotations

from dataclasses import dataclass

from ..contract import NativeQuality, NativeQualityEvidence, QualityReason


# The zero-text rule is measured Phase 0 evidence. The remaining thresholds are
# conservative operational heuristics, not measured extraction-accuracy claims.
MIN_MEANINGFUL_CHARACTERS = 20
MIN_PRINTABLE_RATIO = 0.90
MAX_REPLACEMENT_RATIO = 0.02


@dataclass(frozen=True, slots=True)
class QualityAssessment:
    classification: NativeQuality
    evidence: NativeQualityEvidence


def classify_native_text(
    text: str,
    *,
    text_object_count: int,
    parser_succeeded: bool = True,
) -> QualityAssessment:
    if not parser_succeeded:
        return QualityAssessment(
            NativeQuality.INVALID,
            NativeQualityEvidence(
                native_character_count=0,
                meaningful_character_count=0,
                printable_ratio=0.0,
                replacement_character_count=0,
                text_object_count=0,
                reasons=(QualityReason.PARSER_FAILURE,),
            ),
        )

    native_count = len(text)
    meaningful_count = sum(character.isalnum() for character in text)
    printable_count = sum(character.isprintable() or character.isspace() for character in text)
    printable_ratio = printable_count / native_count if native_count else 0.0
    replacement_count = text.count("\ufffd")

    if not text.strip():
        reasons = [QualityReason.NO_NATIVE_TEXT]
        if text_object_count == 0:
            reasons.append(QualityReason.NO_TEXT_OBJECTS)
        return QualityAssessment(
            NativeQuality.OCR_REQUIRED,
            NativeQualityEvidence(
                native_character_count=native_count,
                meaningful_character_count=meaningful_count,
                printable_ratio=printable_ratio,
                replacement_character_count=replacement_count,
                text_object_count=text_object_count,
                reasons=tuple(reasons),
            ),
        )

    reasons: list[QualityReason] = []
    if meaningful_count < MIN_MEANINGFUL_CHARACTERS:
        reasons.append(QualityReason.SPARSE_NATIVE_TEXT)
    if printable_ratio < MIN_PRINTABLE_RATIO:
        reasons.append(QualityReason.LOW_PRINTABLE_RATIO)
    if replacement_count / native_count > MAX_REPLACEMENT_RATIO:
        reasons.append(QualityReason.EXCESSIVE_REPLACEMENT_CHARACTERS)
    if text_object_count == 0:
        reasons.append(QualityReason.NO_TEXT_OBJECTS)

    if reasons:
        classification = NativeQuality.AMBIGUOUS
    else:
        classification = NativeQuality.NATIVE_USABLE
        reasons.append(QualityReason.NATIVE_TEXT_PRESENT)
    return QualityAssessment(
        classification,
        NativeQualityEvidence(
            native_character_count=native_count,
            meaningful_character_count=meaningful_count,
            printable_ratio=printable_ratio,
            replacement_character_count=replacement_count,
            text_object_count=text_object_count,
            reasons=tuple(reasons),
        ),
    )
