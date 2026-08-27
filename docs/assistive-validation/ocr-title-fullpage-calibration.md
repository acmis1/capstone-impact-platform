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
the prospectively frozen requirements, and preference is lowest architectural complexity first:

```text
1. discard any candidate failing any quality, safety, operational, security, provisioning
   or repeated-stability requirement, on any required repeat;
2. among the remaining candidates, prefer the lowest architectural complexity rank;
3. break ties by lowest worst-repeat p95, then lowest worst-repeat p50, then fewest
   effective CPU threads, then candidate identifier.
```

Complexity ranks are frozen in the protocol: `full_page_single_pass` 0,
`cropped_region_fast_path` 1, `multi_pass_ocr` 2, `backend_specific_acceleration` 3,
`high_performance_inference_or_document_vlm` 4.

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

### Measurement controls

Two controls make a latency measurement valid. Both are declared before the measurements they
govern, apply identically to all four candidates, and are **rejection rules only**: a repeat
that fails either can never satisfy the calibration margin, and neither is consulted by the
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

External CPU load is therefore a controlled variable, declared before any candidate was
measured and applied identically to all four:

* before a repeat starts, external utilisation is sampled and the runner waits, up to fifteen
  minutes, until it is at or below **25%**;
* throughout the repeat, external utilisation is sampled once a second and summarised into the
  capture;
* a repeat whose mean external utilisation exceeds the ceiling is rejected.

External load is `system-wide CPU utilisation − this benchmark process's own share`.

Candidates are also interleaved by repeat cycle, and the order rotates each cycle, so no
candidate's three repeats are blocked together and none keeps the same position in the cycle.

### Process-speed control

External CPU utilisation does not capture every way a measurement can be invalid. A second
controlled sweep produced a repeat of the eight-thread candidate in which **every** stage was
about 2.4× slower than the same candidate's other two repeats — p50 12,665 ms against 5,076 and
5,189 ms, and `model_initialization_ms` 11,938 ms against 4,926 and 5,387 ms, i.e. before any
OCR ran — while its mean external CPU (17.7%) was marginally *lower* than the fast repeat's
(18.0%). The whole process ran at a fraction of the machine's normal speed, and no external-load
metric could see it.

Each repeat therefore also times a fixed in-process integer loop, before and after the run:

* the reference is 6,000,000 iterations, best of three timings;
* the machine's idle nominal is ~325 ms, measured independently of any OCR result;
* the bound is **650 ms**, twice that nominal, so ordinary variation passes and a process
  running at half speed does not.

This detects the condition directly rather than inferring a cause, so it holds whatever slows a
process down — scheduling, power state, memory pressure or contention that CPU utilisation
misses.

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

<!-- RESULTS -->

---

## 7. Evidence and replay

Tracked under `docs/assistive-validation/evidence/ocr-title-fullpage-calibration/`:

* `selector-decision.json` — the pre-registered selector diagnostic and its decision;
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
