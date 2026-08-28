# Phase 7 final language qualification result

## Frozen chronology

- Policy freeze: `77c9c4a199af3e097f0419532f052530af3958ea`
- Freeze tree SHA-256: `f0edef98899f84a617d0dac1bbe90b5722a3f445910ea3aa664223f7eec8e265`
- Fresh post-freeze seed: `37b4e32e9903161232e972c88a62f8e4`
- Holdout SHA-256: `4c36f37ff3658b9a37836582ed7ceed75aee87c434229c2d8dcef2198ddf666e`
- Seal commit: `c767e36e87fb21cc7c0dcdb4c775084109003d49`
- One-shot state: `COMPLETED`, `run_count = 1`
- Machine evidence SHA-256: `fc8c9de04258b668cac11c7e31bd5173a3b02deec343e7696503228f93b17472`

The freeze verifier proved that the holdout, freeze record, one-shot state, machine result, and this result document were absent at the policy-freeze commit. The 96-case holdout was then generated from a new 128-bit seed and committed in `SEALED_UNCONSUMED` state before inference.

Normalized-text SHA-256 comparison found zero matches against 242 unique prior exposed language texts, zero matches against the 120-case final calibration, and zero duplicates within the final holdout.

## One-shot result

| Candidate | TP | FP | FN | Precision | Recall | F1 | Clean silence | Decision |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Harper 2.7.0 | 22 | 1 | 27 | 95.7% | 44.9% | 61.1% | 100.0% | `LANGUAGE_PROVIDER_DEFERRED` |
| LanguageTool 6.6 | 25 | 2 | 24 | 92.6% | 51.0% | 65.8% | 100.0% | `READY_FOR_LANGUAGE_INTEGRATION` |

Only LanguageTool was final-eligible because Harper did not clear the frozen pre-holdout calibration recall margin. LanguageTool clears the unchanged final gates of precision at least 90% and recall at least 40%. No rounding is needed for either gate.

LanguageTool median per-field request latency was 41.9 ms and p95 was 115.6 ms after a bounded local cold start. The measured runtime was OpenJDK 21.0.12, Node.js 24.14.1, and Python 3.12.13 on CPU.

### LanguageTool by field

| Field | TP | FP | FN | Precision | Recall |
| --- | ---: | ---: | ---: | ---: | ---: |
| Background | 10 | 0 | 5 | 100.0% | 66.7% |
| Solution | 6 | 1 | 10 | 85.7% | 37.5% |
| Summary | 6 | 1 | 7 | 85.7% | 46.2% |
| Title | 3 | 0 | 2 | 100.0% | 60.0% |

### LanguageTool by holdout partition

| Partition | TP | FP | FN | Precision | Recall |
| --- | ---: | ---: | ---: | ---: | ---: |
| A | 10 | 0 | 6 | 100.0% | 62.5% |
| B | 6 | 1 | 10 | 85.7% | 37.5% |
| C | 9 | 1 | 8 | 90.0% | 52.9% |

The final decision is based on the predeclared aggregate gate, not on a post-hoc partition gate. Per-partition calibration gates were met before freeze.

### Error-family coverage

LanguageTool recovered every labelled article, capitalisation, repeated-word, verb-form, dropped-character, repeated-character, simple spelling, technical near-miss, and transposition issue. It recovered one of three singular/plural issues. It did not recover the frozen possessive, pronoun, fragment, subject/verb, comma-splice, introductory-comma, terminal-punctuation, or real-word labels.

The two counted false positives were `UNDER_COMPOUNDS` on a clean staff-authority sentence and `MANY_NN` whose phrase-level replacement did not satisfy the frozen exact accepted-correction matcher. Neither output was used to change a label, matcher, rule policy, vocabulary, threshold, or candidate.

## Decision

LanguageTool 6.6 is qualified only for bounded, non-blocking, human-reviewed suggestions in the existing asynchronous assistive-validation subsystem. It has no approval, publication, workflow, accessibility-authority, or automatic metadata mutation role. Production integration must reproduce the exact frozen vocabulary, technical-token, masking, field, correction-plausibility, provider-version, and offset policies.
