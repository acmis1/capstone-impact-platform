# PP1 Phase 6B: production lexical duplicate shortlist

## Purpose and decision basis

Phase 6B productionises only the Phase 6A-selected lexical duplicate ranker. Each assistive run may
persist one bounded shortlist containing the five most lexically similar other project records for
staff review. It is candidate generation, not automatic duplicate classification, and it cannot
block, approve, merge, delete, archive, publish, or otherwise mutate a project.

The authoritative Phase 6A decisions remain:

- Harper 2.7.0: **DEFER**.
- LanguageTool 6.6: **DEFER** (fresh holdout precision 63.2%, recall 60.0%, F1 61.5%).
- Lexical duplicate ranking: **SELECT** for a top-five human-review shortlist.
- Embeddings: **DEFER / NOT_RUN**.

Grammar is not implemented because neither measured grammar candidate met the frozen 90% holdout
precision gate. Embeddings are not implemented because lexical Recall@1, Recall@3, and Recall@5
were all 100% over the frozen Phase 6A corpus. No model, vector database, external search service,
LLM, VLM, or cloud AI is involved.

## Candidate pool and lexical algorithm

The trusted Node coordinator loads all non-deleted project records except the current project. It
does not filter workflow state, so historical draft, submitted, approved, published, and archived
records remain comparable. The database read returns only `public_id`, `title`, `summary`,
`background`, and `solution`; no internal project UUID, team identity, status, timestamp, or media
data enters the ranker or browser evidence.

The in-memory pool is capped at 1,000 candidates. The repository requests an exact server-side
count and fails the assistive input read if the full eligible corpus exceeds the cap; it never
silently truncates a larger corpus. This bound reflects the measured PP1 scale and is not a claim
of hyperscale support.

The TypeScript ranker reproduces the frozen Phase 6A configuration:

1. NFKC, case, punctuation, dash, quote, and whitespace normalisation;
2. canonical equality over title plus `summary`, `background`, and `solution` in schema order;
3. normalized title equality;
4. token Jaccard overlap;
5. character-trigram cosine similarity;
6. the unchanged Phase 0 weighting: 0.25 normalized-title equality, 0.40 token overlap, and 0.35
   trigram similarity, with exact canonical equality scoring 1 and other scores capped at 0.999;
7. descending score followed by ascending public ID for deterministic ties.

IDs are identifiers and tie breakers only; they never contribute semantic score evidence.

## Composite input identity and stale behaviour

The pipeline version is `assistive-deterministic-checks/v2`. Historical v1 runs remain immutable.

For each run, candidates are serialized with fixed keys (`publicId`, `title`, `summary`,
`background`, `solution`), sorted by public ID independently of database return order, and hashed
with SHA-256. The current project's v2 identity hashes fixed fields in this order:

```text
title
summary
background
solution
documentType
documentSha256
duplicateCorpusSha256
```

The coordinator reloads the current project, selected private poster, and complete comparison
corpus before finalization. A change to current prose, poster bytes/type, candidate prose, candidate
creation, or candidate deletion produces a different input hash and uses the existing
`SUPERSEDED` path. No stale shortlist is persisted, and normal corpus evolution does not require an
`IDENTITY_CONFLICT`. The staff warning therefore refers to project content or comparison data,
not only the current project.

## Finding and persistence contract

No candidate pool produces no duplicate finding. A non-empty pool produces exactly one
`DUPLICATE_SHORTLIST` finding with at most five ordered candidates.

- `REVIEW` / `EXACT_OR_NORMALIZED_DUPLICATE_PRESENT` means at least one candidate has exact
  canonical content equality or normalized-title equality.
- `INFORMATION` / `LEXICAL_DUPLICATE_SHORTLIST` means the list is lexical review context only.
- Classification remains `NON_BLOCKING`.
- The finding-level score kind/value pair remains null because one shortlist has multiple scores.
- Candidate `lexicalScore` values are diagnostics in `[0, 1]`, not confidence probabilities and
  not duplicate thresholds.

Migration 0033 (`20260821140000_assistive_duplicate_shortlist.sql`) preserves the closed
`assistive-finding-evidence/v1` contract and adds closed `assistive-finding-evidence/v2`. V2 retains
the nine common v1 keys and adds only `duplicateCandidates`. Each candidate contains exactly:
`rank`, `publicId`, `title`, `summaryExcerpt`, `lexicalScore`, `exactContentMatch`, and
`normalizedTitleMatch`. Database constraints and RPC validation independently enforce one to five
contiguous ordered ranks, unique route-safe public IDs, text bounds, score bounds, boolean flags,
strict key sets, prohibited-control rejection, the existing total JSON ceiling, and v2/check-type
coherence. No database UUID, full background/solution, team identity, arbitrary URL, or hashing
internal is persisted.

The legacy terminal persistence RPC is replaced because it explicitly enumerated v1. Phase 4
finalization already delegates to the replaced strict validator, and the Phase 5 inspection RPC
already returns the bounded evidence object without reviewer/job/storage internals, so neither
generic RPC requires semantic widening. All table privileges remain revoked; RPC execution remains
service-role only with `SECURITY DEFINER`, an empty search path, fully qualified objects, and no
dynamic SQL.

## Staff interface and authority

The Phase 5 Assistive Checks surface renders the shortlist as **Similar projects**. Each entry shows
rank, literal title, public ID, bounded summary excerpt, exact/normalized-match badges where
applicable, `Lexical similarity: 0.xx`, and an internal `/admin/projects/<publicId>` link. The page
states that similarity is assistive evidence and not a confidence probability. Candidate text is
rendered as text, never HTML.

Staff may mark or ignore the shortlist as a whole. A duplicate shortlist never exposes Apply to
draft and has no action that can mutate project content or workflow state.

## Frozen parity and measured performance

Parity tests load frozen Phase 6A manifest/report evidence only from tests; production code imports
no Python benchmark runtime. Representative exact, normalized-title, light-paraphrase,
sentence-reorder, title-abbreviation, hard-related, and unrelated cases reproduce the frozen top-five
candidate ordering. Score comparison permits only a `1e-12` binary floating-point tolerance.

Pure-ranker measurements below used 20 repeated synthetic runs after one warm-up on the local
Windows development machine. Database/network setup time is excluded.

| Candidate count | p50 | p95 |
|---:|---:|---:|
| 100 | 3.867 ms | 5.396 ms |
| 500 | 18.838 ms | 20.717 ms |
| 1,000 | 35.701 ms | 37.046 ms |

These figures support the 1,000-candidate defensive maximum only; they do not establish production
latency or scalability beyond the measured in-memory workload.

## Local runtime and browser verification

A clean disposable Local Supabase reset applied migrations 1 through 33 from zero. The Phase 3
persistence verifier passed 39 scenarios, the 30-to-33 upgrade verifier passed seven, Phase 4 job
coordination passed 23, Phase 5 staff inspection passed 26, and the Migration 33 verifier passed 22.
The last set exercised v1/v2 round trips, zero/one/five/over-five candidates, bounds and hostile
payload rejection, current/corpus identity changes, add/remove corpus drift, exclusion of workflow
status, a real queued run superseded before finalization, dispositions, permissions, and unchanged
project/approval/publication state.

Real Local Admin browser checks used only reserved `phase6b-browser-*` synthetic fixtures:

| Viewport | Fixture | Verified result |
|---:|---:|---|
| 390 px | five candidates | Five bounded cards, no horizontal card overflow, literal hostile text, internal links, and no Apply action on the shortlist. |
| 768 px | one candidate | One bounded card with the expected badges, lexical label, internal link, and shortlist-level dispositions. |
| 1,440 px | zero and five candidates | No shortlist surface for zero candidates; the full five-card surface remained bounded at desktop width. |

The first candidate link opened its internal project detail route. Mark reviewed and Ignore both
persisted on the shortlist as a whole. The hostile-looking `<img>` title and `<script>` summary
created no image/script nodes, JavaScript dialog, or browser console error. All eight verifier-owned
project fixtures and the disposable browser reviewer were removed afterward; no hosted service was
contacted.

## Remaining boundary

Genuine AI productionization remains unresolved after Phase 6B. A later evidence-backed OCR
productionization stage must close that requirement before final delivery; lexical ranking is not
misrepresented as AI and no unjustified model is activated here.
