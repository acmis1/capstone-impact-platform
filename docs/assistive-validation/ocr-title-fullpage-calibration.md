# PP1 full-page OCR title-consistency calibration (Issue #214, corrected selection policy)

This iteration answers one question: **does the simplest full-page PP-OCRv6 Small title
provider already satisfy the frozen PP1 title-consistency requirement?**

It exists because an independent coordinator audit of PR #215 found a methodological defect in
that iteration's candidate-selection policy. All PR #213 and PR #215 modules, corpora, evidence
and consumed holdouts remain byte-immutable; nothing here reruns, reinterprets or tunes against
them.

---

## 1. The audit finding and the correction

PR #215's comparison contained a candidate, `baseline-full-mkldnn-off`, that satisfied every
prospective quality, safety, operational and margin requirement at architectural complexity
rank 0 (exact title 100%, inconsistency precision/recall 100%, automatic-agreement precision
100%, zero material false automatic agreements, zero false fast-path accepts, p50 5.021 s,
p95 6.746 s, cold start ~10.22 s, peak RSS ~1.08 GB). It was nonetheless excluded from
selection by the historical rule:

```python
def _selection_eligible(configuration: dict) -> bool:
    return bool(
        configuration["cpu_threads"] is not None
        and (configuration["enable_mkldnn"] or configuration["fast_region_ratio"] is not None)
    )
```

That rule required a candidate to *contain an optimization feature* before it could be
selected. The experiment was therefore forced onto the more complex cropped fast-region
candidate, which subsequently failed its fresh holdout on exact-title recovery (92%) and
inconsistency precision (87.5%).

**Correction.** In this iteration, eligibility depends only on whether a candidate satisfies
the prospectively frozen requirements. Every bounded candidate is the same full-page,
single-pass architecture, and the preference order is fixed before final repeats:

```text
1. discard any candidate failing any quality, safety, operational, security, provisioning
   or repeated-stability requirement, on any required repeat;
2. among the remaining candidates, prefer lowest worst-repeat p95;
3. break ties by lowest worst-repeat p50, then fewer explicit CPU threads, then candidate
   identifier. The provider-default diagnostic sorts after explicit thread counts on an exact
   latency tie but remains fully eligible and can win on either latency metric.
```

The historical module `assistive_validation_benchmark.ocr_title_latency` is **not** edited.
This is a new versioned module, `assistive_validation_benchmark.ocr_title_fullpage`, with its
own protocol, corpus, evidence root and freeze.

---

## 2. Candidate family

Full page only. No crop of any ratio, no second OCR pass, no MKL-DNN, no HPI, no document VLM.

| Candidate | Page scope | CPU threads | MKL-DNN | HPI | DPI | Max dimension |
|---|---|---|---|---|---|---|
| `fullpage-cpu-default` | full page | provider default | off | off | 180 | 1920 |
| `fullpage-cpu-t4` | full page | 4 | off | off | 180 | 1920 |
| `fullpage-cpu-t8` | full page | 8 | off | off | 180 | 1920 |
| `fullpage-cpu-t10` | full page | 10 | off | off | 180 | 1920 |

Every candidate shares the same model artifacts, runtime, corpus, selector, scorer and worker
concurrency of 1. The unpinned provider-default candidate is a full member of the comparison —
excluding it would repeat the audited defect in the opposite direction.

Model and runtime identity is reverified against frozen tree hashes before every capture:
`PP-OCRv6_small_det` / `PP-OCRv6_small_rec`, PaddleOCR 3.7.0, PaddlePaddle 3.3.0,
PaddleX 3.7.2, artifact footprint 31,481,281 bytes. No version was upgraded for this task.

MKL-DNN and HPI were not retried: PR #215 already recorded MKL-DNN as not deployable on the
supported native Windows runtime, and HPI as inapplicable to it. Neither is part of the
candidate family and neither becomes a new deployment dependency.

---

## 3. New calibration corpus

Deterministic, synthetic and deidentified. Seed `2026082761`, corpus version
`pp1-ocr-title-fullpage-calibration-v1`, 45 scored cases plus one unscored warmup.

* Media × layout is exactly balanced: every one of the nine `{png, jpeg, scanned_pdf} ×
  {one, two, three column}` cells holds 5 scored cases.
* 17 of the 45 scored cases are genuinely inconsistent.
* Every recurring difficulty family is crossed against different media *and* different column
  layouts, so no family is confounded with one rendering path.

Difficulty families present: administrative/control heading above the title; an administrative
control line immediately adjacent to the title; a status/control line immediately below the
title; a subtitle below the title; two similarly prominent headings; branding/logo text above
the title; multi-line titles; a title whose second line is much shorter; the project title
repeated in body text; one-token semantic mismatch; number/version mismatch; acronym mismatch;
punctuation, case and hyphen variants; low contrast; JPEG compression; mild noise and blur;
small-but-readable titles; an absent title. Two cases carry hostile instruction-shaped poster
text, which the pipeline treats as inert evidence.

**Historical non-reuse.** Normalized metadata title, normalized poster title, normalized full
rendered reference and meaningful case identity are compared mechanically against every
exposed OCR corpus: the Phase 0 manifest, the productionization calibration and holdout,
Iteration 2 calibration and fresh holdout, Iteration 3 calibration and fresh holdout,
Iteration 4 calibration, the PR #213 title calibration and consumed holdout, and the PR #215
optimization calibration and consumed holdout — 12 corpora, 466 historical cases.
Result: **0 prohibited reuse**, and no duplicate within the new corpus.

The invalid pre-freeze v1 holdout is not a historical raw corpus in the current tree. Its 64
irreversible metadata-title, visible-title, full-reference and case-signature fingerprints are
checked separately. Calibration also reports **0 prohibited reuse** against those fingerprints.

---

## 4. Title selector decision (pre-registered)

The protocol keeps the merged baseline selector unless the *new* calibration corpus
demonstrates a generalizable defect; only then may the smallest permitted alternative be
adopted. The decision is made by a single diagnostic OCR pass whose identical blocks are
replayed through every permitted selector, **before** any candidate repeat is measured.

| Selector | Exact visible-title recovery | Material false automatic agreements |
|---|---|---|
| `top-band-group-prominence-v3@geometry` (merged baseline) | 42/44 = 95.45% | 0 |
| `top-band-typography-consistent-group-prominence-v4@geometry` | 44/44 = 100% | 0 |

The baseline failed two families, for two distinct and generalizable reasons:

1. **`administrative_line_adjacent`** — an all-uppercase control stamp set immediately above a
   mixed-case title was concatenated into the title, yielding
   `COHORT CONTROL COPY Rowan Silo Moisture Chronicle`.
2. **`short_second_line`** — a title's short final line was not joined to its first line,
   yielding `Bracken Signal Box Timing` instead of `Bracken Signal Box Timing Sheet`. The
   measured OCR box heights were 83 px and 58 px for lines of *identical* type size, because
   the first line carries descenders and the second does not; the ratio 0.699 fell just under
   the baseline's 0.70 height-consistency tolerance.

The adopted selector changes exactly two things, both properties of rendered typography:

* **Extent-aware line height.** A line's measured ink box is divided by the vertical extent
  its own characters can paint (ascender-and-descender 0.98, ascender or capitals only 0.75,
  descender only 0.78, x-height only 0.55) before any height is compared or ranked. This is
  ordinary Latin typographic proportion, not a value fitted to any case.
* **Case-style consistency when joining.** An all-uppercase line is never joined to a
  mixed-case line, because a control, status or administrative stamp is conventionally set in
  full capitals and is typographically distinct from a project title.

Both rules are deterministic, explainable, metadata-blind during candidate extraction and
ranking, and free of case identifiers, consumed-holdout wording, project titles and learned
coordinates. No numeric grouping threshold from the baseline was changed.

**Recorded limitation.** A superseded first diagnostic rendered the adjacent control stamps at
near-title type size (52 px against a 58 px title). At that proportion *neither* selector ranks
reliably: PaddleOCR's detection box height is a ±15% proxy for type size, so a 52 px
all-capitals stamp and a 58 px mixed-case title without descenders produce box heights of 54 px
and 52 px respectively. That is an inherently ambiguous poster rather than a title-recovery
case, and the corpus family was re-rendered at realistic control-stamp proportions (44 px
adjacent lines, 42 px status lines) before the recorded diagnostic. Both diagnostics ran before
any freeze and before any holdout existed. Where two headings genuinely are similarly
prominent, the frozen contract's safe answer is `REVIEW`, and the corpus exercises that
separately through the `ambiguous_headings` family.

---

## 5. Repeated calibration stability

Earlier iterations showed substantial runtime variation between separate experiments, so no
candidate may be selected from a single timing run. Every candidate is measured over **three
independent repeats**. Each repeat starts a fresh worker process, initializes the model
normally, runs the same warmup policy, processes the complete 45-case corpus, regenerates and
re-rasterizes its own assets, and records the exact environment and runtime identity.

### Measurement control

One independent control makes a latency measurement environmentally valid. It is frozen before
the final repeats, applies identically to all four candidates, and is a **rejection rule only**:
it never inspects quality, p50, p95 or any other candidate result and is not consulted by the
preference order. A rejected measurement is an *attempt*, not a repeat — it is preserved in
`rejected-measurement-attempts.json` and the repeat is measured again, up to three attempts.
Excluding a candidate because the workstation misbehaved would be the same error class the
coordinator's audit found, so only a measurement control may trigger a re-measurement; a repeat
that failed on any candidate metric stands as recorded, and `check-evidence` refuses evidence
in which a repeat was re-measured for any other reason.

### Host-load control

This benchmark runs on a shared developer workstation (an i5-12600K, 10 cores / 16 threads)
that also hosts unrelated development work. An uncontrolled first attempt made that visible:
after roughly forty minutes, every candidate — 4, 8, 10 and provider-default threads alike —
converged on a p50 near 12.5 s, while a concurrently running Next.js dev server and its MCP
tooling held roughly two cores. A measurement in that state characterises the host, not the
candidate.

External CPU load is therefore the controlled variable, declared before the final repeats and
applied identically to all four:

* before a repeat starts, external utilisation is sampled and the runner waits, up to fifteen
  minutes, until it is at or below **25%**;
* throughout the repeat, external utilisation is sampled once a second and summarised into the
  capture;
* a repeat whose mean external utilisation exceeds the ceiling is rejected.

External load is `system-wide CPU utilisation − this benchmark process's own share`.

Candidates are also interleaved by repeat cycle, and the order rotates each cycle, so no
candidate's three repeats are blocked together and none keeps the same position in the cycle.

### Environmental-variability audit

The exploratory evidence contains 21 reports: 14 in the fast regime (p50 5,076–6,740 ms) and
7 at or above 10 seconds (p50 10,052–13,190 ms). Crucially, the eight-thread candidate produced
a p50 of 12,665 ms while the independent external-load signal passed at 17.7%. That attempt is
therefore genuine runtime variability, not an environmentally rejected measurement.

A fixed in-process integer-loop reference was explored after this slowdown was observed, but it
was present in only one later fast capture. There is no prospective evidence that it separates
the quiet-host slow regime from ordinary runs. The process-speed rejection mechanism is
therefore removed rather than engineered into the final protocol. Unexplained slow repeats
stand as candidate failures and may not be retried.

The compact exploratory audit is tracked as
`environment-variability-audit.json` (SHA-256
`8ebcd3458d2423c17bb12db84339baebe410a4d7103da46bbbbcc7d1ff7c085a`).
Every underlying report is identified by path and hash and is explicitly ineligible as a final
repeat.

### Requirements

The corpus never changes between repeats, and a candidate is eligible only if **every** repeat
satisfies the full calibration margin:

* exact visible-title recovery = 100%
* inconsistency precision = 100%
* inconsistency recall = 100%
* automatic-agreement precision = 100%
* material false automatic agreements = 0
* p50 ≤ 7,500 ms, p95 ≤ 15,000 ms, cold start ≤ 30,000 ms
* memory, artifact-footprint, per-case timeout, offline and provisioning gates pass
* the repeat was measured on a quiet host

Final gates are unchanged from PR #213/#215 and are not weakened here: exact title ≥ 95%,
inconsistency precision ≥ 98%, inconsistency recall ≥ 95%, automatic-agreement precision 100%,
zero material false automatic agreements, p50 ≤ 10 s, p95 ≤ 20 s, cold start ≤ 30 s, peak RSS
≤ 4 GiB, artifact footprint ≤ 1 GiB, worker concurrency 1.

---

## 6. Results

All twelve prospectively scheduled measurements were accepted on their first attempt. No
environmental attempt was rejected, and no quality or latency result was re-measured. Every
repeat recovered all 44 visible titles exactly, classified all 17 inconsistent cases with
precision and recall 1.0, kept automatic-agreement precision at 1.0, and produced zero
material false automatic agreements.

| Candidate | Repeat | p50 (ms) | p95 (ms) | Cold start (ms) | Peak RSS (bytes) | Mean external CPU | Margin |
|---|---:|---:|---:|---:|---:|---:|---|
| `fullpage-cpu-t4` | 1 | 4,573.8 | 5,638.7 | 9,124.0 | 1,080,131,584 | 17.88% | pass |
| `fullpage-cpu-t8` | 1 | 4,669.8 | 5,871.8 | 9,157.7 | 1,078,521,856 | 16.70% | pass |
| `fullpage-cpu-t10` | 1 | 4,900.6 | 6,048.0 | 9,040.1 | 1,082,175,488 | 15.00% | pass |
| `fullpage-cpu-default` | 1 | 4,852.6 | 6,109.2 | 9,074.6 | 1,086,410,752 | 14.88% | pass |
| `fullpage-cpu-t8` | 2 | 4,736.4 | 5,896.3 | 8,823.5 | 1,078,820,864 | 17.55% | pass |
| `fullpage-cpu-t10` | 2 | 4,878.4 | 6,048.3 | 9,130.1 | 1,078,636,544 | 13.87% | pass |
| `fullpage-cpu-default` | 2 | 4,905.4 | 6,104.5 | 9,039.3 | 1,080,508,416 | 14.45% | pass |
| `fullpage-cpu-t4` | 2 | 4,362.0 | 5,429.0 | 8,623.3 | 1,075,339,264 | 15.00% | pass |
| `fullpage-cpu-t10` | 3 | 4,925.9 | 6,130.6 | 9,032.9 | 1,079,357,440 | 14.48% | pass |
| `fullpage-cpu-default` | 3 | 4,841.0 | 6,071.5 | 8,973.2 | 1,084,821,504 | 14.92% | pass |
| `fullpage-cpu-t4` | 3 | 4,429.7 | 5,406.7 | 8,603.4 | 1,077,133,312 | 15.09% | pass |
| `fullpage-cpu-t8` | 3 | 4,601.2 | 5,732.1 | 8,757.5 | 1,084,194,816 | 14.50% | pass |

The provider-default candidate resolved to 10 effective CPU threads in every repeat. All four
candidates are selection-eligible. Applying the frozen preference rule gives:

| Rank | Candidate | Worst-repeat p95 (ms) | Worst-repeat p50 (ms) |
|---:|---|---:|---:|
| 1 | `fullpage-cpu-t4` | 5,638.7 | 4,573.8 |
| 2 | `fullpage-cpu-t8` | 5,896.3 | 4,736.4 |
| 3 | `fullpage-cpu-default` | 6,109.2 | 4,905.4 |
| 4 | `fullpage-cpu-t10` | 6,130.6 | 4,925.9 |

**Calibration decision: `fullpage-cpu-t4` qualifies and is selected.** The result permits a
dedicated candidate-freeze commit and, only after that commit exists, creation of a new
independent holdout. It does not itself permit production integration.

The canonical comparison SHA-256 is
`d3137f428680a7e0bb1fb1b2dd3f3599d36601c157eb3f75adf6352fde9dc40e`; the selection
SHA-256 is `784b8f1cee58f4a0774c31acc24a8bb9689b50c85723dd1109211b9548064d4e`.

---

## 7. Evidence and replay

Tracked under `docs/assistive-validation/evidence/ocr-title-fullpage-calibration/`:

* `selector-decision.json` — the pre-registered selector diagnostic and its decision;
* `environment-variability-audit.json` — the compact audit of all exploratory timing regimes;
* `rejected-measurement-attempts.json`, when present — attempts rejected only by external
  host load (none were rejected in the final experiment);
* `<candidate>-repeat-NN-capture.json` / `-report.json` — every preserved repeat;
* `<candidate>-aggregate.json` — the per-candidate repeat aggregation;
* `candidate-comparison.json` — the bounded comparison across all candidates;
* `candidate-selection.json` — the prospective rule applied to the comparison.

Every one of these is recomputed from tracked bytes, with no Paddle runtime, no model weights,
no inference and no network:

```bash
python -m assistive_validation_benchmark.ocr_title_fullpage check-calibration
python -m assistive_validation_benchmark.ocr_title_fullpage check-selector-decision
python -m assistive_validation_benchmark.ocr_title_fullpage check-evidence
python -m assistive_validation_benchmark.ocr_title_fullpage check-freeze
```
