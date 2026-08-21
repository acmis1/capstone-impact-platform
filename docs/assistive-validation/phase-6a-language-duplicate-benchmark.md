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
| Phase 6A corpus | `pp1-assistive-phase6a-v4`, seed `61062026` |
| Frozen manifest SHA-256 | `b2a29bcea0aa59bc4ae534705a47baadb4423f5dcf876b774a7dccef13da6dad` |
| Frozen vocabulary policy SHA-256 | `d4336e182a8e0b9c0c78bb8829fddd13e65bc8e28f3a0e9234a7ad980ba946a3` |
| Policy freeze commit | `001cde3fda6aa6120c3fb08d8c06d73003555581` |

The production schema on this baseline exposes the prose fields `title`, `summary`, `background`, and `solution`. Duplicate ranking uses only those four fields. Grammar cases also model bounded extracted text, but no benchmark module is imported by production.

## Scientific-integrity protocol

The corpus is deterministic, synthetic, and contains no real participant, staff, or production project content. Case text, labels, seed, spans, accepted corrections, relationship labels, and split assignments were committed to the generated manifest before the final engine run.

### Why v4 exists

Three earlier iterations are preserved as audit history in [`phase6/history/benchmark-history.json`](../../tools/assistive-validation-benchmark/phase6/history/benchmark-history.json) and, for v3, in [phase-6a-report-v3-superseded.json](evidence/phase-6a-report-v3-superseded.json). None of them is the authoritative grammar decision.

- **v1** was superseded because a repository terminology contract required a wording-only corpus revision after the first holdout.
- **v2** reported `LanguageTool: SELECT` at 91.7% holdout precision. That result is **not defensible**. The approved vocabulary term `OAuth` declared repository provenance, but the term occurs in no repository file; its only real occurrence was holdout case `g6-070`. The policy was therefore partly derived from the holdout it was scored against, and the term suppressed a false positive in that same holdout.
- **v3** attempted to correct v2 but introduced three further defects: only the clean holdout cases `g6-061`–`g6-070` were replaced, so the already-exposed `g6-041`–`g6-060` and `g6-071`–`g6-080` were reused; the run executed **LanguageTool 6.4** instead of the reviewed 6.6 candidate, silently changing the measured engine; and Harper never executed at all, leaving no comparison. Its summary also reported an F1 of 68.7% for TP=11 / FP=2 / FN=9, which is arithmetically 66.7% — a value carried over from v2.

v4 replaces the **entire** grammar holdout, restores the reviewed LanguageTool 6.6 candidate, and executes both engines.

### Freeze ordering

Git history is the evidence of ordering, not a self-declared flag.

1. Commit `001cde3fda6aa6120c3fb08d8c06d73003555581` froze the vocabulary policy, its provenance validator, the masking rules, the issue matcher, the scorer, and the selection threshold. **The fresh holdout did not exist in the repository at that commit.**
2. The next commit added the fresh v4 holdout and the single final measurement.

Every stored report records `policy_freeze_commit_sha`, and validation rejects evidence whose policy bytes differ from those committed at that commit. No vocabulary term, rule filter, threshold, mask, label, or case wording was changed in response to the v4 result.

### Vocabulary provenance

The policy holds **14 approved terms: 3 repository-sourced, 11 calibration-sourced, 0 holdout-sourced.** Every term is proven mechanically:

- A **repository** term must resolve to an existing in-tree file that literally contains the term, and that file may not be generated Phase 6 corpus or evidence material.
- A **calibration** term must resolve to a corpus case whose declared split is `calibration`, and which both contains the term and declares it in its legitimate technical terms.
- Provenance pointing at any case whose declared split is `holdout` is rejected structurally, from the manifest's own split field rather than from identifier-prefix guessing.

Calibration was used to confirm the exact-token vocabulary policy and to identify a masking artefact: replacing excluded code/URL spans with spaces caused both engines to report repeated whitespace, so findings overlapping those non-prose spans are excluded. Calibration ended with Harper at 100.0% precision / 45.0% recall and LanguageTool at 90.9% / 50.0% after policy application.

### Metric arithmetic

Every stored `precision`, `recall`, and `F1` is recomputed from its own `TP`/`FP`/`FN` counts during evidence validation and rejected on disagreement beyond floating-point tolerance. The stale v3-style inconsistency cannot recur.

## Corpus

### Grammar

The 80 cases are split evenly:

| Split | Clean | Erroneous | Total |
|---|---:|---:|---:|
| Calibration (`g6-001`–`g6-040`) | 20 | 20 | 40 |
| Holdout (`g6v4-h001`–`g6v4-h040`) | 20 | 20 | 40 |
| Total | 40 | 40 | 80 |

The holdout uses a distinct identifier scheme so that any accidental reuse of the retired `g6-041`–`g6-080` range is obvious. CI hashes every retired holdout text (whitespace- and case-normalised) and fails if any v4 holdout text matches one: **50 exposed texts checked, 0 reused.**

Every labelled issue stores its source span, category, accepted corrections, field, legitimate technical terms, and split. The holdout covers all 16 error categories with the same distribution as the retired holdout: ordinary, repeated-character, dropped-character, real-word, and technical near-miss spelling; subject-verb agreement, number, article, pronoun, and verb-form grammar; fragments; comma splices; introductory punctuation; duplicated words; possessives; and capitalisation.

Clean holdout cases deliberately test generalisation. They include Australian spelling, passive voice, concise headings, security/network/database vocabulary, inert code spans, URLs, email addresses, UUIDs, and dotted filenames — and **legitimate technical names that are deliberately absent from the frozen vocabulary** (`Nginx`, `Kafka`, `Keycloak`, `MinIO`, `Vitest`, `Zigbee`, `SQLAlchemy`, `LoRaWAN`). Approving those terms after seeing the result would be exactly the tuning this protocol forbids, so they remain unapproved.

### Grammar input policy

- Check `summary`, `background`, and `solution` for grammar, spelling, punctuation, and capitalisation.
- Treat `title` as spelling-only because concise headings are legitimate.
- Preserve source offsets while masking code spans, URLs, email addresses, UUIDs, filenames, and database identifiers.
- Exclude findings overlapping those deliberately masked non-prose spans. Ten such findings were removed for each engine before scoring.
- Never interpret text as a command, argument, URL to fetch, model instruction, or credential lookup.

### Grammar truth matching

An engine finding matches one human-authored issue when at least half of the shorter non-empty span overlaps and, when the engine supplies replacements, at least one normalised replacement is an accepted correction. Zero-width punctuation findings must fall within one character of the truth span. Multiple findings describing the same already-matched issue are counted once. Unmatched findings are false positives and unmatched truth issues are false negatives. No LLM is a judge.

This matcher is strict about correction granularity: where a truth span covers `a hourly` and an engine returns the narrower span `a` with replacement `an`, the finding is scored as both a false positive and a miss. The retired v3 holdout case `g6-060` behaved identically, so the comparison across iterations is consistent. The convention was frozen before v4 and was not revisited afterwards.

### Duplicates

The duplicate corpus is unchanged from v2/v3 — 120 synthetic candidate projects and 40 queries — because no defect was found in it:

| Split | Exact/normalised | Near duplicate | Total |
|---|---:|---:|---:|
| Calibration | 10 | 10 | 20 |
| Holdout | 10 | 10 | 20 |
| Total | 20 | 20 | 40 |

Every query labels every candidate as `EXACT_DUPLICATE`, `NEAR_DUPLICATE`, `RELATED_NOT_DUPLICATE`, or `UNRELATED`. Each query has one duplicate and five related hard negatives. Cases cover identical content, punctuation/case normalisation, light rewriting, sentence reordering, title abbreviation, shared boilerplate, the same stack with a different problem, the same domain with a different solution, and a near-identical title for a materially different archive or policy project.

## Engine versions and execution

No benchmark candidate was silently upgraded or downgraded. Both reviewed Phase 0 candidates were executed once, in one run.

| Candidate | Source and licence | Configuration |
|---|---|---|
| Harper 2.7.0 | pinned `harper.js` npm artifact; Apache-2.0 | local inlined WASM, Australian dialect, plaintext |
| LanguageTool 6.6 | official numbered self-hosted distribution; LGPL-2.1-or-later plus distribution notices | local Java 21 loopback server, `en-AU`, 25,000-character limit, 10-second per-check bound, one check thread |

The LanguageTool 6.6 archive was verified to be the same reviewed Phase 0 artifact: `LanguageTool-stable.zip`, SHA-256 `53600506b399bb5ffe1e4c8dec794fd378212f14aaf38ccef9b6f89314d11631`. The running server reported version `6.6`, build `2025-03-27`. Evidence validation fails if either engine reports a version other than the contracted Harper 2.7.0 / LanguageTool 6.6, or if either engine did not execute.

Recorded runtime, queried rather than assumed: OpenJDK `21.0.12.1` (Temurin), Node `v24.14.1`, Python `3.13.2`, `macOS-15.5-arm64-arm-64bit-Mach-O`, CPU only. Java was invoked with an argument array and `shell=False`; stdout/stderr were discarded to bounded null sinks, startup and requests had timeouts, and the process was deterministically terminated. Benchmark text never entered process arguments.

## Grammar results

### Harper 2.7.0

| Split/configuration | Precision | Recall | F1 | TP | FP | FN | Vocab FP | Non-vocab FP | Clean silence |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Calibration raw | 60.0% | 45.0% | 51.4% | 9 | 6 | 11 | 6 | 0 | 15/20 |
| Calibration + vocabulary policy | 100.0% | 45.0% | 62.1% | 9 | 0 | 11 | 0 | 0 | 20/20 |
| Holdout raw | 42.9% | 30.0% | 35.3% | 6 | 8 | 14 | 6 | 2 | 14/20 |
| Holdout + vocabulary policy | **46.2%** | **30.0%** | **36.4%** | **6** | **7** | **14** | 5 | 2 | 15/20 |

Cold start was 1.5 s. Per-case latency was 4.4 ms p50 / 11.7 ms p95.

Harper fails the required 90% holdout precision gate by a wide margin. Five of its seven holdout false positives are unknown-vocabulary flags on legitimate technical names; the remaining two are a wrong-correction typo suggestion (`reprot` → `rep rot`) and the article-granularity case. Its 30% holdout recall does not offset that burden.

### LanguageTool 6.6

| Split/configuration | Precision | Recall | F1 | TP | FP | FN | Vocab FP | Non-vocab FP | Clean silence |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Calibration raw | 62.5% | 50.0% | 55.6% | 10 | 6 | 10 | 5 | 1 | 16/20 |
| Calibration + vocabulary policy | 90.9% | 50.0% | 64.5% | 10 | 1 | 10 | 0 | 1 | 20/20 |
| Holdout raw | 60.0% | 60.0% | 60.0% | 12 | 8 | 8 | 5 | 3 | 13/20 |
| Holdout + vocabulary policy | **63.2%** | **60.0%** | **61.5%** | **12** | **7** | **8** | 4 | 3 | 14/20 |

Cold start was 6.8 s. Per-case request latency was 27.4 ms p50 / 113.8 ms p95.

LanguageTool has the better recall of the two candidates and reaches 90.9% precision on **calibration**, but only **63.2% on the fresh holdout**. The gap is the whole point of a holdout: calibration precision was achieved with a vocabulary curated against calibration text, and that curation does not generalise. Six of its seven holdout false positives are dictionary flags on legitimate but unapproved technical vocabulary (`loopback` twice, `Keycloak`, `MinIO`, `Vitest`, `SQLAlchemy`); the seventh is the article-granularity case. Only 14 of 20 clean holdout cases were fully silent.

## Grammar decision

**LanguageTool 6.6: DEFER.** Exact holdout basis: 63.2% precision, 60.0% recall, 61.5% F1, TP=12 / FP=7 / FN=8, and 14/20 clean cases silent after the frozen vocabulary policy. This fails the required 90% precision gate.

**Harper 2.7.0: DEFER.** Exact holdout basis: 46.2% precision, 30.0% recall, 36.4% F1, TP=6 / FP=7 / FN=14, and 15/20 clean cases silent after the frozen vocabulary policy.

The v2 `SELECT` at 91.7% is withdrawn. It was produced against a holdout the vocabulary had partly been derived from, and it did not survive an independent holdout.

Neither engine is production-ready as a bounded suggestion source under a precision-first gate. The gate was not weakened to accommodate the result. The realistic route to a future `SELECT` is a defensible domain vocabulary with genuine repository or controlled-PP1 provenance, plus a rule-category policy — both of which must be built and frozen against calibration material, then measured once against a further fresh holdout.

## Lexical duplicate results

Phase 6A reproduces the selected Phase 0 lexical approach before any rewrite: canonical SHA-256 equality, normalised title equality, token Jaccard overlap, and character-trigram cosine similarity. `summary`, `background`, and `solution` are concatenated in their schema order; no Phase 6 weight search or score threshold is used. This configuration was not modified during the grammar recovery.

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

The average top-five shortlist contains one hard related-not-duplicate candidate, making human review necessary even though the true duplicate ranks first in every query. Query latency was 20.5 ms p50 / 21.1 ms p95 across the 120-project pool.

**Lexical ranking: SELECT** for bounded ranked candidate generation and human review. It is not selected as a score threshold or automatic duplicate decision.

## Embedding trigger

**TRIGGERED: NO.** No labelled near duplicate misses the top five, Recall@5 is 100%, useful recall does not require a shortlist longer than five, and related lexical decoys do not systematically outrank the duplicate.

No embedding runtime executed. No model, weight, cache, vector database, daemon, cloud API, GPU runtime, or browser-accessible service was downloaded or used. The grammar deferral is not a reason to run embeddings: the trigger is defined on duplicate evidence alone, and that evidence is unchanged.

**Embeddings: DEFER / NOT_RUN.**

## Decisions

`SELECT` below means suitable only for the bounded assistive role, never authoritative validation.

| Candidate | Decision | Bounded role | Numerical evidence | Operational cost and reason |
|---|---|---|---|---|
| Harper 2.7.0 | **DEFER** | grammar/spelling candidate | 46.2% / 30.0% holdout precision/recall after policy; 7 FP | 1.5 s cold start, 4.4/11.7 ms p50/p95; precision gate failed |
| LanguageTool 6.6 | **DEFER** | grammar/spelling candidate | 63.2% / 60.0% holdout precision/recall after policy; 7 FP | 6.8 s cold start, 27.4/113.8 ms p50/p95; precision gate failed |
| Lexical duplicate ranking | **SELECT** | top-five candidate shortlist for human review | 100% exact detection and Recall@1/@3/@5; 4 irrelevant candidates in average top five | 20.5/21.1 ms p50/p95 over 120 candidates; no service/model dependency |
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

Because both grammar candidates are deferred, embeddings remain deferred, and OCR still has no selected production default, **genuine AI productionization remains an unresolved final-delivery requirement.** The next roadmap must close that requirement with separate evidence-backed OCR/model productionisation rather than force an unjustified dependency.

## Verification contract

Lightweight CI validates the Phase 0 manifest and regression suite, deterministically regenerates the Phase 6A manifest, checks its locked SHA-256, proves the 20 clean / 20 erroneous fresh holdout reuses none of the retired holdout texts, proves every vocabulary term's provenance and that none is holdout-derived, recompiles every stored precision/recall/F1 from its counts, checks the engine version contract and decision contract, recomputes deterministic duplicate metrics, and confirms the preserved historical version metadata. It does not install Harper, download LanguageTool, run Java, download model weights, require a GPU, or access the network.

The exact final repository verification and exact-head CI outcomes are recorded in the PR and final task report.
