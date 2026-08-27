# Full-page OCR title holdout pre-freeze exposure

Status: **invalid development-only corpus; permanently prohibited from qualification**

Issue #214 recovery found a complete prospective full-page OCR title holdout design in the
working tree before the candidate and protocol had been frozen. The design fixed its content,
labels, case allocation, rendering parameters and identifiers in advance. It is development
material only and must never be sealed, executed, scored or represented as a fresh holdout.

## Exposed source identity

- Original seed: `2026082783`
- Scored cases: 63, plus one warmup
- Source path:
  `tools/assistive-validation-benchmark/src/assistive_validation_benchmark/ocr_title_fullpage_holdout/corpus.py`
- Corpus source SHA-256: `aa4e13ae7c23f3446421a961c21a63a3c9c767b0eac4a19750564834a45a773e`
- Deterministic corpus-value SHA-256:
  `e6a07d63b4ae4f1b12a6c5c85872afb958a8457c47d0d4060741264ec35c74ae`

The other exposed draft-module SHA-256 values were:

| Module | SHA-256 |
| --- | --- |
| `__init__.py` | `424c9ed5b4d899036ee438dca4e786f9be3a5ef32d0743592649e24ea8738bcc` |
| `__main__.py` | `65c3af979a37145d43aa60c7add26514d68920ea45ab82bb883cfb59315acd0f` |
| `capture.py` | `4fe60989a2c82dc061ca2ec4ff3d9b94960b2b55fc1dcb47a6b5ede2571a4f57` |
| `corpus.py` | `aa4e13ae7c23f3446421a961c21a63a3c9c767b0eac4a19750564834a45a773e` |
| `one_shot.py` | `7b92b0955d495419349722310b393c815a49599c566db099ccd4233e44d91b10` |
| `seal.py` | `12965ae14903f541d7056ae8a773512ae3b5ee721d5bacccbb74d62a43f48d8d` |

The raw source was copied to an external, hash-verified local quarantine before removal from
the working tree because recovery proved that it was untracked and therefore had no forensic
copy in Git. The local quarantine manifest SHA-256 is
`8ed1a73e396e2286ceabb82dc10c86976abaaaec07ba77d924acdb78dbdaa1a6`;
the machine-local path is intentionally not a repository contract.

## Git chronology

The exposure was observed while branch `feat/assistive-ocr-title-fullpage-production` was at
`81df74f6fef596e076cc7cb5d958543de35d798f`. Recovery verified the intact forward lineage:

1. `194bbf729158416202dc865b32672a6e2421d441`
2. `ba57531270889d9ada047531887d1a744c8a80f5`
3. `5b120c831370e1e56824ced64ed364ab25183457`
4. `ee4c6d98c3a9062e6c815cb331d57b4b11983b85`
5. `cc7516bb2599865000bed4f100d7b86728963dee`
6. `81df74f6fef596e076cc7cb5d958543de35d798f`

An exact `git grep` and history search found no occurrence of the seed or exposed package in
any of those commit trees. The scientific incident was an untracked working-tree exposure at
the recovered HEAD, not a committed corpus. The commits remain unchanged; this forward record
corrects the initial handoff assumption without rewriting history.

## Qualification state at discovery

Recovery found no generated holdout data directory, rendered holdout assets, candidate-freeze
manifest, seal, state file, OCR capture or result report. No holdout one-shot claim occurred and
the one-shot run count was never advanced. The invalid corpus was never executed.

## Permanent non-reuse control

The tracked manifest at
`docs/assistive-validation/evidence/ocr-title-fullpage-exposed-v1-fingerprints.json` contains
only SHA-256 fingerprints of normalized metadata titles, normalized visible titles, full
rendered reference text, case identifiers and meaningful case signatures. It contains no raw
title or reference strings. Its SHA-256 is
`e36dab88c2d560daeb382655d850207263010e446a567e8525bd7fb4810fc049`.

Every later fresh full-page title holdout must compare against those fingerprints as well as
all ordinary historical corpora and this iteration's calibration corpus, with zero prohibited
reuse. Seed `2026082783`, the exposed v1 design and its exact cases are permanently disallowed.
