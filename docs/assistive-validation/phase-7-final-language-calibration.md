# Phase 7 final language calibration

## Scope

This is the pre-holdout qualification record for Issue #220. It preserves Phase 6A and Phase 6C as exposed development evidence and introduces a separate final protocol. No production runtime or database migration is part of this calibration stage.

The two frozen candidates remain:

- LanguageTool 6.6 from the official numbered local archive, SHA-256 `53600506b399bb5ffe1e4c8dec794fd378212f14aaf38ccef9b6f89314d11631`, under `LGPL-2.1-or-later` with distribution notices;
- Harper 2.7.0 from the lockfile-pinned `harper.js` package, under Apache-2.0.

Both run locally and offline. LanguageTool uses a bounded Java process whose HTTP listener is restricted to `127.0.0.1`; it is never configured as a cloud endpoint.

## Corpus and non-reuse

The deterministic corpus contains 120 synthetic/deidentified cases: three predeclared 40-case partitions, each with 20 erroneous and 20 clean cases. It covers title, summary, background, and solution; all 18 declared error categories; multiple-issue passages; ordinary and technical clean prose; hostile literal text; and masked URL, email, code, UUID, filename, database identifier, hash, version, and machine-identifier families.

Normalized-text SHA-256 comparison checked all 120 calibration texts against 242 unique exposed texts drawn from all Phase 0 language cases, the Phase 6 superseded lock, all Phase 6A v4 language cases, and both Phase 6C calibration and holdout corpora. Matches and within-calibration duplicates were both zero.

## Prospective policy

The policy uses only repository-backed or explicitly declared calibration terms. Exact approved technical terms suppress spelling findings. A misspelled term is recovered only when case-folded Damerau-Levenshtein distance yields one unique approved term at distance one. Other engine spelling suggestions must preserve whitespace and punctuation structure and remain within the frozen edit-distance and size bounds. Common technical shapes are suppressed only when there is no unique trusted near-match.

All non-prose masking preserves both the engine-facing UTF-16 length and the canonical Unicode-code-point offsets. Harper and LanguageTool UTF-16 offsets are validated at code-point boundaries and converted before scoring. The same conversion contract is required for persistence and Apply to draft.

Titles receive spelling/obvious-typo findings only. Summary, background, and solution may receive spelling, grammar, repeated-word, agreement, possessive/article, punctuation, or capitalisation findings. Harper's `Agreement` kind is excluded because it produced two calibration false positives and zero calibration true positives. LanguageTool has no rule or category exclusions.

## Calibration result

| Candidate | TP | FP | FN | Precision | Recall | F1 | Clean silence |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Harper 2.7.0 | 31 | 0 | 32 | 100.0% | 49.2% | 66.0% | 100.0% |
| LanguageTool 6.6 | 36 | 0 | 27 | 100.0% | 57.1% | 72.7% | 100.0% |

LanguageTool achieved 100.0% precision and 57.1% recall in each independent partition (12 TP, 0 FP, 9 FN per partition). It therefore clears the predeclared overall 95%/50% and per-partition 90%/40% margins. Harper remains the comparator and does not clear the overall 50% recall margin.

LanguageTool 6.6 is the sole candidate eligible for the post-freeze decision. The final gate remains unchanged at precision at least 90% and recall at least 40%. The final holdout is not created until after the dedicated freeze commit.
