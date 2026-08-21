# Phase 6A grammar and near-duplicate decision benchmark

## Purpose and boundary

Phase 6A produces decision evidence for a later Phase 6B production change. It does not add grammar or duplicate findings to the Admin/CMS, change the coordinator, alter the staff UI, or change persistence. All outputs remain suggestions for staff review; no language or similarity result is authoritative project validation.

The compact machine-readable audit is [phase-6a-report.json](evidence/phase-6a-report.json). The runnable implementation remains isolated under [`tools/assistive-validation-benchmark/`](../../tools/assistive-validation-benchmark/README.md).

## Starting state

| Item | Value |
|---|---|
| Authoritative `origin/main` | `0512d21da930c4e9f0bddd1a2d417e3bd6bdd69d` |
| Migration count | 32 |
| Branch | `feat/assistive-language-duplicate-benchmark` |
| Phase 0 harness | Python package, deterministic manifest/generator, local engine adapters, reports, tests, and lightweight CI |
| Phase 6A corpus | `pp1-assistive-phase6a-v2`, seed `61062026` |
| Frozen manifest SHA-256 | `62f1111c7578875b00990f003c54b579af07a6251e5f162648009f758d8ade06` |

The production schema on this baseline exposes the prose fields `title`, `summary`, `background`, and `solution`. Duplicate ranking uses only those four fields. Grammar cases also model bounded extracted text, but no benchmark module is imported by production.

## Scientific-integrity protocol

The corpus is deterministic, synthetic, and new for Phase 6A. It contains no real participant, staff, or production project content. Case text, labels, seed, spans, accepted corrections, relationship labels, and split assignments were committed to the generated manifest before the final engine run.

The first final run used corpus v1 (`08a397dd74d4154c7ade2f12cd56c8e1f67bd0a1d24c570e7b2ad1471cd96fb8`). A repository terminology contract then exposed a wording-only design flaw in synthetic text and safety metadata. Its complete holdout metrics and decisions are preserved in the v2 machine report's `benchmark_history`. Corpus v2 changes only that terminology-safe wording; it does not change labels, quality thresholds, vocabulary, weights, filters, engine settings, splits, or case counts. V2 therefore receives its own frozen hash and one new final measurement rather than silently reusing v1 evidence.

Calibration was used to confirm the exact-token technical vocabulary policy and to identify a masking artefact: replacing excluded code/URL spans with spaces caused both engines to report repeated whitespace. The input policy now excludes findings overlapping those non-prose spans. Calibration ended with Harper at 100.0% precision / 45.0% recall and LanguageTool at 90.9% / 50.0% after policy application.

The vocabulary policy, input normalisation, scorer, lexical configuration, manifest, and manifest hash were then frozen. The final holdout was measured once. No threshold, vocabulary entry, weight, rule filter, corpus label, or engine setting was changed in response to the holdout result.

## Corpus

### Grammar

The 80 cases are split evenly:

| Split | Clean | Erroneous | Total |
|---|---:|---:|---:|
| Calibration | 20 | 20 | 40 |
| Holdout | 20 | 20 | 40 |
| Total | 40 | 40 | 80 |

Every labelled issue stores its source span, category, accepted correction or corrections, field, legitimate technical terms, and split. Coverage includes ordinary, repeated-character, dropped-character, real-word, and technical near-miss spelling errors; agreement, number, article, pronoun, and verb-form grammar errors; fragments; comma splices; introductory punctuation; duplicated words; possessives; and capitalisation.

Clean adversarial cases cover Australian spelling, legitimate passive voice, technical noun phrases, concise headings, acronyms, product/framework names, engineering and security terms, and inert snippets resembling code, commands, URLs, email addresses, UUIDs, database identifiers, and filenames. Dangerous near-misses such as misspelled approved tool names remain labelled errors and are not removed by the vocabulary policy.

### Grammar input policy

- Check `summary`, `background`, and `solution` for grammar, spelling, punctuation, and capitalisation.
- Treat `title` as spelling-only because concise headings are legitimate.
- Preserve source offsets while masking code spans, URLs, email addresses, UUIDs, filenames, and database identifiers.
- Exclude findings overlapping those deliberately masked non-prose spans.
- Never interpret text as a command, argument, URL to fetch, model instruction, or credential lookup.

### Domain vocabulary policy

The versioned policy contains a bounded list of approved repository/tool and controlled engineering terminology. A finding is removed only when:

1. the engine classifies it as spelling/typo-related; and
2. its source span is an exact, case-sensitive match for an approved term.

Unknown words are not automatically accepted. Flagged words are not automatically added. A one-character near-miss therefore remains visible. The policy file SHA-256 in the evidence is `f598a2069317170cac74bab850283f67c27f79b62fa536fd1f19d2e83e9b3964`.

### Grammar truth matching

An engine finding matches one human-authored issue when at least half of the shorter non-empty span overlaps and, when the engine supplies replacements, at least one normalised replacement is an accepted correction. Zero-width punctuation findings must fall within one character of the truth span. Multiple findings that describe the same already-matched issue are counted once. Unmatched findings are false positives and unmatched truth issues are false negatives. No LLM is a judge.

### Duplicates

The duplicate corpus has 120 synthetic candidate projects and 40 queries:

| Split | Exact/normalised | Near duplicate | Total |
|---|---:|---:|---:|
| Calibration | 10 | 10 | 20 |
| Holdout | 10 | 10 | 20 |
| Total | 20 | 20 | 40 |

Every query labels every candidate as `EXACT_DUPLICATE`, `NEAR_DUPLICATE`, `RELATED_NOT_DUPLICATE`, or `UNRELATED`. Each query has one duplicate and five related hard negatives. Cases cover identical content, punctuation/case normalisation, light rewriting, sentence reordering, title abbreviation, shared boilerplate, the same stack with a different problem, the same domain with a different solution, and a near-identical title for a materially different archive or policy project.

## Engine versions and execution

No benchmark candidate was silently upgraded. The pinned versions measured in Phase 0 were retained so Phase 6A isolates corpus and policy effects.

| Candidate | Source and licence | Configuration |
|---|---|---|
| Harper 2.7.0 | pinned `harper.js` npm artifact; Apache-2.0 | local inlined WASM, Australian dialect, plaintext |
| LanguageTool 6.6 | official numbered self-hosted distribution; LGPL-2.1-or-later plus distribution notices | local Java 21 loopback server, `en-AU`, 25,000-character limit, 10-second per-check bound, one check thread |

The LanguageTool 6.6 archive was the same reviewed Phase 0 artifact (`LanguageTool-stable.zip`, SHA-256 `53600506b399bb5ffe1e4c8dec794fd378212f14aaf38ccef9b6f89314d11631`). Java was invoked with an argument array and `shell=False`; stdout/stderr were discarded to bounded null sinks, startup and requests had timeouts, and the process was deterministically terminated. Benchmark text never entered process arguments.

## Grammar results

### Harper 2.7.0

| Split/configuration | Precision | Recall | F1 | False positives | Vocabulary FP | Non-vocabulary FP | Clean silence |
|---|---:|---:|---:|---:|---:|---:|---:|
| Calibration raw | 60.0% | 45.0% | 51.4% | 6 | 6 | 0 | 15/20 |
| Calibration + vocabulary policy | 100.0% | 45.0% | 62.1% | 0 | 0 | 0 | 20/20 |
| Holdout raw | 50.0% | 30.0% | 37.5% | 6 | 3 | 3 | 17/20 |
| Holdout + vocabulary policy | **66.7%** | **30.0%** | **41.4%** | **3** | 0 | 3 | 20/20 |

Cold start was 856 ms. Per-case latency was 1.8 ms p50 / 5.2 ms p95. Peak measured child-process working set was 467 MiB. Nine findings overlapping deliberately excluded non-prose spans were removed before scoring.

Harper fails the required 90% holdout precision gate after the frozen policy. Its low 30% holdout recall is also not useful enough to offset the false-positive burden.

### LanguageTool 6.6

| Split/configuration | Precision | Recall | F1 | False positives | Vocabulary FP | Non-vocabulary FP | Clean silence |
|---|---:|---:|---:|---:|---:|---:|---:|
| Calibration raw | 62.5% | 50.0% | 55.6% | 6 | 5 | 1 | 16/20 |
| Calibration + vocabulary policy | 90.9% | 50.0% | 64.5% | 1 | 0 | 1 | 20/20 |
| Holdout raw | 78.6% | 55.0% | 64.7% | 3 | 2 | 1 | 18/20 |
| Holdout + vocabulary policy | **91.7%** | **55.0%** | **68.7%** | **1** | 0 | 1 | 20/20 |

Cold start was 12.8 seconds. Per-case request latency was 22.5 ms p50 / 67.6 ms p95. Peak measured Java working set was 781 MiB. Nine findings overlapping deliberately excluded non-prose spans were removed before scoring.

LanguageTool clears the 90% precision gate, though it remains below the preferred 95% target. Its 55% holdout recall is materially higher than Harper's 30%, and the single holdout false positive occurred in an already erroneous case rather than a clean case.

## Grammar decision

**LanguageTool: SELECT** for a bounded Phase 6B production candidate that produces non-authoritative grammar/spelling suggestions for staff review. Exact holdout basis: 91.7% precision, 55.0% recall, 68.7% F1, one false positive, and 20/20 clean cases silent after the frozen vocabulary policy.

**Harper: DEFER.** Exact holdout basis: 66.7% precision, 30.0% recall, and three false positives after policy. Easier or cheaper integration does not override the failed precision gate.

## Lexical duplicate results

Phase 6A reproduces the selected Phase 0 lexical approach before any rewrite: canonical SHA-256 equality, normalised title equality, token Jaccard overlap, and character-trigram cosine similarity. `summary`, `background`, and `solution` are concatenated in their schema order; no Phase 6 weight search or score threshold is used.

| Metric | Calibration | Holdout | All |
|---|---:|---:|---:|
| Exact duplicate detection | 100.0% | 100.0% | 100.0% |
| Recall@1 | 100.0% | 100.0% | 100.0% |
| Recall@3 | 100.0% | 100.0% | 100.0% |
| Recall@5 | 100.0% | 100.0% | 100.0% |
| Candidate precision@3 | 33.3% | 33.3% | 33.3% |
| Candidate precision@5 | 20.0% | 20.0% | 20.0% |
| Average irrelevant candidates at 3 / 5 | 2 / 4 | 2 / 4 | 2 / 4 |
| Related-not-duplicate candidates in top 5 | 20 | 20 | 40 |
| Related-not-duplicate outranked the true duplicate | 0 | 0 | 0 |

The average top-five shortlist contains one hard related-not-duplicate candidate, making human review necessary even though the true duplicate ranks first in every query. Query latency was 12.3 ms p50 / 13.3 ms p95 across the 120-project pool.

**Lexical ranking: SELECT** for bounded ranked candidate generation and human review. It is not selected as a score threshold or automatic duplicate decision.

## Embedding trigger

**TRIGGERED: NO.** No labelled near duplicate misses the top five, Recall@5 is 100%, useful recall does not require a shortlist longer than five, and related lexical decoys do not systematically outrank the duplicate.

No embedding runtime executed. No model, weight, cache, vector database, daemon, cloud API, GPU runtime, or browser-accessible service was downloaded or used.

**Embeddings: DEFER / NOT_RUN.** The expanded lexical evidence supplies no incremental-value case for an embedding challenger.

## Decisions

`SELECT` below means suitable only for the bounded assistive role, never authoritative validation.

| Candidate | Decision | Bounded role | Numerical evidence | Operational cost and reason |
|---|---|---|---|---|
| Harper 2.7.0 | **DEFER** | grammar/spelling candidate | 66.7% / 30.0% holdout precision/recall after policy; 3 FP | 0.9 s cold start, 1.8/5.2 ms p50/p95, 467 MiB; precision gate failed |
| LanguageTool 6.6 | **SELECT** | staff-reviewed grammar/spelling suggestions | 91.7% / 55.0% holdout precision/recall after policy; 1 FP | 12.8 s cold start, 22.5/67.6 ms p50/p95, 781 MiB; only engine clearing the precision gate |
| Lexical duplicate ranking | **SELECT** | top-five candidate shortlist for human review | 100% exact detection and Recall@1/@3/@5; 4 irrelevant candidates in average top five | 12.3/13.3 ms p50/p95 over 120 candidates; no service/model dependency |
| Embeddings | **DEFER / NOT_RUN** | possible semantic challenger | trigger false; lexical Recall@5 100%, zero top-five misses | no model cost incurred because incremental value was not demonstrated |

## Production and safety boundary

- Production runtime changed: **NO**
- Migration 33 added: **NO**
- Supabase schema changed: **NO**
- Coordinator changed: **NO**
- Phase 5 UI changed: **NO**
- Model weights or Java archive tracked: **NO**
- Cloud AI used: **NO**
- LLM or VLM used: **NO**
- Real participant data used: **NO**
- Hosted Supabase touched: **NO**
- Duda or publication code touched: **NO**

Because embeddings remain deferred and OCR still has no selected production default, **genuine AI productionization remains an unresolved final-delivery requirement.** The next roadmap must close that requirement with separate evidence-backed OCR/model productionisation rather than force an unjustified embedding dependency.

## Verification contract

Lightweight CI validates the Phase 0 manifest and regression suite, deterministically regenerates the Phase 6A manifest, checks its locked SHA-256, validates both corpus schemas and split stability, exercises grammar scoring and lexical label-independence, recomputes deterministic duplicate metrics, and parses the stored decisions. It does not install Harper, download LanguageTool, run Java, download model weights, require a GPU, or access the network.

The exact final repository verification and exact-head CI outcomes are recorded in the PR and final task report after the implementation diff is complete.
