# Phase 2 deterministic assistive checks

## Purpose

Phase 2 adds a pure, in-memory Admin/CMS domain boundary for consuming Phase 1 document-extraction evidence and producing non-blocking deterministic observations. It is local-first, deterministic-first, human-authoritative, and provider-independent.

## Implemented

- Strict Zod consumption of `assistive-document-extraction/v1`. The parser rejects unknown fields and versions, invalid enums, non-finite or inverted geometry/confidence, bad page references, oversized text/block/warning output, malformed provider data, and impossible status/source/OCR combinations.
- A shared JSON fixture is accepted by both the Phase 1 Python contract and the TypeScript consumer. TypeScript malformed-output cases fail closed.
- Bounded, plain-text, non-persistent check results. They contain only a check type, non-blocking outcome, reason, field, origin, short evidence, optional geometry/page, normalised values, lexical evidence, and explanation.
- Metadata-independent title candidates from completed `TextBlock` evidence. The algorithm considers page order, actual top-left bounding boxes, relative block prominence, adjacent line grouping, block order, and bounded text. It returns at most eight candidates; it never receives the metadata title.
- Identity-oriented title normalisation: Unicode NFKC, case folding, whitespace collapse, curly/straight quote and dash/hyphen normalisation, and inconsequential punctuation removal. It never removes words or meaningful digits.
- Conservative outcomes: `AGREES`, `REVIEW`, `MISMATCH`, and `NOT_EVALUATED`, all non-blocking. `AGREES` is only normalized exact equality or an explicitly supplied policy value.
- Deterministic formatting helpers for line breaks, whitespace, suspicious replacement/control characters, and informational formatting hints.
- Informational unevaluable conditions: failed extraction, OCR not run, unavailable OCR provider, no credible candidate, and missing geometry.

## Title decision semantics

Scores are lexical/edit evidence only; they are neither confidence nor a calibrated probability. Phase 0 showed material mismatches and OCR noise overlap in fuzzy scores, so no scalar threshold can produce `AGREES`.

Near OCR glyph, spelling, and morphological variants go to `REVIEW`. Strong token differences can be `MISMATCH`; close real-word substitutions are still never automatic agreements. In particular, both `Flood` / `Fire` and `Island` / `Inland` regression cases cannot result in `AGREES`.

There is no default subtitle stripping or alias list. Callers may supply `allowedCandidateTitles` as an explicit policy input; without it, a subtitle or alias is reviewed rather than accepted.

## Benchmark evidence

The Vitest regression corpus has 12 labelled cases: exact, case, punctuation/hyphen, wrapped title, OCR glyph, spelling, morphology, one-token mismatch, high-similarity mismatch, missing candidate, OCR pending, and multiple-candidate layout.

| Metric | Result |
|---|---:|
| Automatic `AGREES` precision | 100% (4/4) |
| Automatic `AGREES` recall | 100% (4/4 identity-path positives) |
| Review rate | 33.3% (4/12) |
| False automatic agreements | 0 |
| Mismatch/review coverage of actionable non-agreements | 100% (6/6) |

This small deterministic regression corpus is production-test evidence only. Production code does not import Phase 0 benchmark tooling.

## Boundaries and Phase 3 handoff

Phase 2 does not mutate project metadata or workflow state, approve, archive, publish, prepare publication, call Duda, persist results, create migrations, enqueue work, invoke a worker, render UI, or activate Gemini/cloud AI. It does not add grammar, duplicate, embedding, LLM, or VLM behaviour.

Phase 3 may decide whether and how to persist these bounded non-authoritative observations and expose them to staff. It must preserve the same human-authoritative mutation boundary.

## Deferred

- Worker HTTP/client integration and queueing.
- Persisted runs, jobs, findings, reviewer dispositions, and database schema.
- Staff Assistive Checks UI or Apply-to-draft action.
- Grammar, duplicate detection, embeddings, local/cloud models, VLMs, and Gemini activation.
