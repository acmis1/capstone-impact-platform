# PP1 assistive OCR Iteration 2 fresh-holdout protocol freeze v3

## Purpose and boundary

This iteration freezes the protocol for a genuinely independent Iteration 2 OCR holdout. It
freezes; it does not measure.

**IMPLEMENTED here:** the exposed development-only distractor correction evidence, the corrected
holdout protocol freeze, the deterministic hard-negative relationship contract, the canonical
renderer environment, the deterministic renderer fingerprint, the holdout schema and generator
contract, the freeze manifest, and the freeze chronology.

**NOT IMPLEMENTED here:** the fresh holdout, any holdout case, any holdout asset, any holdout
OCR capture, any holdout accuracy number, any production OCR provider and any production
`SELECT`.

The machine-readable freeze evidence is
[`evidence/ocr-productionization-iteration2-holdout-protocol.json`](evidence/ocr-productionization-iteration2-holdout-protocol.json).
The selector/WER correction is independently recomputable from the stored PP-OCRv6 Small
development captures in
[`evidence/ocr-productionization-iteration2-distractor-calibration.json`](evidence/ocr-productionization-iteration2-distractor-calibration.json).
It is explicitly `development_only`, not an independent holdout, and consumed no fresh holdout.
[Phase 0](phase-0-results.md), the
[v1 productionization benchmark](ocr-productionization-benchmark.md), the
[Iteration 2A failure analysis](ocr-productionization-failure-analysis.md) and the
[Iteration 2B1 calibration](ocr-productionization-iteration2-calibration.md) remain immutable
historical evidence; their hashes are bound by this freeze and re-verified in CI.

## Starting state

| Item | Value |
|---|---|
| `origin/main` | `2858ad60c4c8c69a49c4a82518017d1e8dc07582` |
| Migration count | 33 |
| Worker OCR task providers | `NONE`, `TESSERACT` |
| Coordinator OCR selection | `NONE` |
| Production neural OCR | none |
| Merged Iteration 2B1 decision | `READY_TO_FREEZE_OCR_ITERATION_2_HOLDOUT_PROTOCOL` |

Those production values are recorded as historical facts about the freeze, not as a permanent
requirement on future `main`. A later legitimate OCR integration must not retroactively
invalidate this evidence. Benchmark-PR scope is enforced instead by the PR-relative
production-path diff already present in the lightweight benchmark CI job.

## Why a freeze is needed before a holdout exists

The Iteration 2B1 calibration reached 28/28 exact titles and 9.96 % column-aware WER, but those
are calibration numbers on an exposed corpus. Two named prerequisites remained:

1. the corrected corpus is byte-deterministic *within* one renderer environment, which is not
   the same as being reproducible across operating systems and FreeType builds;
2. the calibration generator always placed the semantic title as the first textual region, so
   the evidence cannot separate a genuine prominence-and-geometry selector from a first-region
   heuristic.

The renderer portability issue was corrected by commits C/D. Independent review then found two
further pre-holdout contradictions: `first_bounded_group@geometry` selected a correctly
recognised above-title masthead instead of the title, and whole-page WER treated correctly
recognised distractor text as insertions because the reference excluded it. Commit E records a
bounded offline PP-OCRv6 Small run on deterministic `ocr2-dev-*` variants derived from the
already-exposed 28-case calibration corpus. No future holdout title, body, asset, capture or
metric was created.

## Frozen OCR candidate

Exactly one production-selection candidate is frozen: the calibration-selected challenger.
Model selection is closed; the holdout is a fair test of that one candidate, not a new search.

| Item | Frozen value |
|---|---|
| Engine | PP-OCRv6 Small (`paddle-small`) |
| Detection artifact | `PP-OCRv6_small_det_infer`, archive 10,055,680 B |
| Recognition artifact | `PP-OCRv6_small_rec_infer`, archive 21,442,560 B |
| Detection tree SHA-256 | `8af984562965b7be9bd5d1c8acb52f6d0bf37de475947b520d876ed8640eb29a` |
| Recognition tree SHA-256 | `0ee2c443863549fabdb1120d7a58df5e8afa0d67bce0827b75529f105c993eae` |
| Artifact footprint | 31,481,281 B (30.0 MiB) |
| Runtime | PaddleOCR 3.7.0, PaddlePaddle CPU 3.3.0, PaddleX OCR core 3.7.2 |
| Device / acceleration | `cpu`; MKL-DNN/oneDNN disabled, exactly as benchmarked |
| Document pre-processing | orientation classification, unwarping and text-line orientation all disabled |
| License | Apache-2.0 |

Provisioning is offline: archives and extracted trees are verified against the frozen SHA-256
values, the only permitted source host is `paddle-model-ecology.bj.bcebos.com`, and no download
may happen during the holdout run.

### Freshness check

Current official sources were checked on 2026-08-22 to confirm the reviewed artifacts are still
unambiguously identifiable. PaddleOCR v3.7.0 exists and ships PP-OCRv6 tiny/small/medium; the
official model page lists `PP-OCRv6_small_det` at 9.6 MB and `PP-OCRv6_small_rec` at 20.4 MB,
matching the frozen archive sizes; PaddleX 3.7.2 is current. PaddlePaddle 3.3.1 now exists and
**was deliberately not adopted** — the freeze locks the reviewed candidate, and chasing a newer
release would invalidate the calibration that justified it. Both Small archives and both
extracted trees were re-verified offline against the repository artifact manifest before the
freeze, with no download.

No `Tiny`, `Medium`, RapidOCR, docTR, Surya, PaddleOCR-VL, Qwen, Gemini, LLM, VLM or cloud OCR
candidate is added. Optional model work must first earn measurable incremental value over this
simpler baseline.

## Frozen raster contract

Scanned PDFs raster at **180 DPI**; every input is bounded to a **1920-pixel maximum long
edge**. Resizing is aspect preserving and downscale-only, using deterministic Lanczos
resampling. Cropping, upscaling of genuinely lower-resolution inputs, label-guided
pre-processing and per-case resolution switching are all forbidden, and the same configuration
applies to every scored case. The existing worker safety ceilings remain authoritative: 200 DPI,
40,000,000 raster pixels per page, 80,000,000 total, 100,000 extracted characters and 5,000 text
blocks.

## Frozen title contract

The selector is `top_band_prominence@geometry` — an existing reviewed deterministic selector,
bound by source hash rather than copied. On the original exposed calibration corpus and the
exposed distractor challenge it recovered 27/28 exact titles (96.4 %) with zero material false
automatic agreements on each dataset. `first_bounded_group@geometry` fell from 28/28 on the
original corpus to 6/28 (21.4 %) with distractors. The centred top-band alternative also reached
27/28 on both datasets, so the deterministic tie-break chose the simpler top-band selector
without its extra centring assumption.

The selected implementation is metadata blind and ground-truth blind; ground truth is used only
after inference to score exposed development evidence. Title normalization, exact equality, the
deterministic assistive comparison and the material-mismatch behaviour remain frozen to the
merged title-safety implementation.

Semantic similarity may never convert a material mismatch into automatic agreement. The future
holdout must include material metadata-title negatives specifically to test that, and the
protocol validator rejects a protocol that relaxes it.

## Frozen WER contract

The primary metric is **column-aware deterministic reading order**, applied to every scored
page. Provider/raw order is a required diagnostic and geometry order is reported alongside it.

Four things are explicitly forbidden and are refused by the protocol validator: choosing the
lowest-WER order per page, using ground truth to choose an order, switching order based on the
resulting WER, and reporting a best-of-oracle figure as the primary metric.

The reference is now every intentionally rendered semantic string in visual/logical order:
above-title distractors, the project title, near-title distractors, then section headings and
body in the frozen column order. Distractors remain noise for title selection but valid visible
text for OCR transcription. Perfect recognition therefore produces WER 0; dropping or
mistranscribing a distractor produces an OCR error. The exposed distractor challenge measured
8.62 % primary column-order WER after this correction (raw and geometry diagnostics: 31.2 %),
below the 15 % development direction. The future fresh-holdout gate remains 12 %.

## Frozen gates

| Gate | Frozen value |
|---|---|
| Exact-title recovery | at least 95 % — at least 38 of 40 scored cases |
| Primary column-order mean WER | at most 12 % |
| Material false automatic agreements | exactly 0 |
| Cold start | at most 30,000 ms |
| p50 | at most 10,000 ms |
| p95 | at most 20,000 ms |
| Peak working set | at most 4 GiB |
| Artifact footprint | at most 1 GiB |
| Per-case timeout | at most 90 seconds |

No threshold is weakened. The run must additionally report the title exact count, the assistive
title result, equality precision/recall, assistive precision/recall, provider/raw WER,
clean versus challenging WER, and media and layout breakdowns.

The two-part operational model from Iteration 2B1 is preserved: the result must satisfy **both**
the historical operational prior recomputed from the merged benchmark's own raw measurements
**and** the current-configuration measurements taken during the holdout run. Every value is
recomputed from raw stored measurements; a stored boolean may never override them; and a faster
holdout machine cannot rehabilitate an engine whose merged evidence already failed.

## Canonical renderer environment

PR #167 established that the corrected corpus is reproducible inside one fixed renderer
environment but does not prove byte-identical rendering across different operating systems or
CPU-dispatched codec paths. The corrected freeze makes that limitation an explicit boundary.

The repository has no container infrastructure, and adding one would not have been the stronger
answer: an image digest pins an operating system, not pixels, and it does not remove CPU-dispatch
variation inside an image compressor. The chosen mechanism is repository-native and is *measured*
rather than asserted.

| Component | Pinned value |
|---|---|
| Environment identity | `pp1-ocr-canonical-renderer-v1` |
| Python | 3.11 |
| Pillow | 12.3.0 (vendors its own FreeType, so the host font stack is never consulted) |
| FreeType | 2.14.3 |
| pypdfium2 | 5.13.0 (vendors its own pdfium) |
| Font | repository-pinned Noto Sans Regular 2.003, SHA-256 `114a6bf229142e7aac8ee83e70ca77563b46b16e80e2e50ad3a053b442f969b6` |
| System font fallback | none |
| Runtime font download | none |
| Network during generation | disabled |
| Floating or `latest` version tags | forbidden |

### Renderer fingerprint

The platform-independent fingerprint binds the environment identity, the four toolchain
versions, the font SHA-256, the renderer source hashes and the reference-fixture specification
hash. Its corrected value is
`33a4fc7dfcbcc8b9d7b78385abc34340a76eb7ee70ce40b6208ccd12aba53367`.

The single canonical generation profile is `windows-amd64-cpython3.11`. Its **decoded-pixel**
digests — glyph raster, PNG round-trip, JPEG round-trip and pdfium raster at 180 DPI — are binding
because decoded pixels are what OCR consumes. Encoded byte digests remain attestation only. A
noncanonical platform reports its measured pixels but is not compared with the Windows profile
and can never generate holdout assets.

`generate_holdout_assets` calls the guard before drawing a single pixel and refuses unless both
the platform-independent binding and the exact canonical Windows decoded-pixel profile match. A
holdout therefore cannot be generated on a noncanonical or divergent toolchain.

The reference fixture is a tiny synthetic probe carrying no project meaning. It is explicitly
unscored, is not corpus content and never reaches an OCR engine.

### Cross-platform attestation

The first exact-head `ubuntu-latest` run disproved the original assumption that reference-render
pixels could be required to match across platforms. The corrected job verifies the identical
platform-independent binding and repeats the Ubuntu measurement byte-for-byte within the run. It
does **not** claim Ubuntu pixels equal Windows pixels, and Ubuntu cannot generate the holdout. A
binding divergence anywhere, or a decoded-pixel divergence on canonical Windows, remains fatal.

## Frozen holdout distribution

The holdout contract exists, with zero cases in it. The future ID namespace is frozen as the
pattern `^ocr2h-[0-9]{3}$`, and this branch instantiates no matching identifier.

| Dimension | Frozen target |
|---|---|
| Scored OCR-required cases | 40 |
| Difficulty | 20 clean, 20 challenging |
| Media | 14 PNG, 13 JPEG, 13 scanned PDF |
| Layout | 14 one-column, 13 two-column, 13 three-column |
| Cross-balance | at least 6 cases in every media/difficulty and layout/difficulty cell |

Forty is chosen because a 95 % exact-title gate on 40 cases requires at least 38 exact
recoveries: one avoidable failure is survivable and two are not, which is a meaningful test
rather than an unreachable one.

### Upper-page generalisation challenge

This is mandatory, because the calibration corpus always placed the semantic title first.

| Requirement | Frozen minimum |
|---|---|
| Cases carrying any upper-page distractor | 32 of 40 |
| Cases with a distractor **above** the project title | 32 of 40 |
| Cases with a distractor **near** the project title | 16 of 40 |
| Cases with both | 8 of 40 |
| Cases where the project title is the topmost region | at most 8 of 40 |

Nine distractor kinds must each appear on at least three scored cases: school or faculty
masthead, program name, discipline, unit or course code, year or date, supervisor label,
category or tag, event or showcase heading, and team label. The project title is therefore not
always the first OCR line or block.

The selector was selected using only exposed `ocr2-dev-*` calibration derivatives, never these
future cases. No future distractor text is authored here. This remains a genuine generalisation
test.

### Title and style coverage

At least 20 plain unstroked titles (the majority), at least 6 wrapped, at least 3 visually
tracked, at least 3 shadowed, and at most 2 outlined as an explicit minority. The v1 artifact
where every title carried an artificial stroke may not return. Visual tracking uses true
per-glyph pixel positioning within a bounded 0–4 pixel range and never mutates the semantic
title string.

Title text must cover single-line and wrapped titles, punctuation, hyphen and dash variants,
numbers and acronyms, Australian English, technical vocabulary, accented Latin, curly
punctuation and subscripts where the pinned font supports them. Degradation coverage requires at
least 6 low-resolution, 6 moderately compressed, 6 mildly noisy and 6 small-body-text cases, and
at least 8 at medium or low contrast.

### Material title negatives

At least 8 of the 40 scored cases must carry a metadata title that materially differs from the
poster ground truth, with at least two each of: a one-character material difference, a one-word
material difference, a semantically related but incorrect title, and a number or version
difference. At least two further cases are punctuation-only **non-material** controls that
remain expected agreements. No conceptual example here is authored as future holdout text.

The v3 corpus validator verifies each claimed relation before any OCR:

* an unlabelled expected agreement is equal after both frozen normalizations;
* every material negative differs after both frozen metric and production normalization;
* a one-character material negative has exactly one content-character edit after metric
  normalization, one changed token and no number/version change;
* a one-word material negative has exactly one metric-token edit, is more than a one-character
  change and carries no number/version change;
* a number/version negative changes an actual digit-bearing token while every non-number token
  remains identical; and
* a punctuation-only control differs at the raw-string level but is equal after both frozen
  normalizations. Curly/straight apostrophes and dash variants can therefore pass, while a word
  substitution cannot hide under this label.

Arbitrary semantic relatedness is not mechanically provable. A `semantically_related_incorrect`
case therefore requires a bounded `negative_relation_evidence` object whose authority is
`human_ground_truth`, whose classification is explicitly recorded before OCR and whose
single-line rationale is plain, non-executable text without URLs or command syntax. The
validator proves the titles are materially different and the evidence is structurally present;
a human remains authoritative for the semantic judgment. The evidence object is ground truth
only: it is excluded from rendered pixels, OCR reference text, title selection, title safety,
WER ordering and production code, and is available later only to aggregate the already-fixed
ground-truth result.

The invariant under test remains simple: semantic relatedness can never turn a material mismatch
into automatic agreement.

### Controls

Controls sit outside the 40 scored cases and are excluded from every OCR quality percentage: at
least 3 born-digital PDF controls, at least 2 malformed or truncated security controls, and
exactly one unscored warm-up.

### Corpus freshness

The future generator must produce "fresh holdout non-reuse / independence evidence" proving zero
exact normalized title-plus-body reuse against Phase 0, the v1 productionization corpus and the
Iteration 2 calibration corpus, and no real participant or project data. No new case content is
revealed in this branch.

## No-holdout hard guard

A guard fails the build if any of the following appears anywhere in the frozen tree: a
`holdout.json`; an instantiated identifier matching the frozen pattern; a generated image or PDF
asset in the protocol directory; a stored holdout capture; a final holdout metric record; or a
production selection authorization or `SELECT` classification. It runs in the unit suite and in
CI, and it is tested against each of those forms of accidental contamination.

## Freeze manifest

The manifest binds 30 components by SHA-256 over git-normalised content and by Git blob id:
the protocol file, the holdout schema and generator contract, the renderer and reference
fixture, the development-correction evidence builder, the fingerprint, the OCR candidate
artifact manifest and its validator, the offline
guard and provisioning, the engine runtime configuration, the selector, the reading order, the
title normalization and safety implementation, the WER/metric and operational-gate
implementation, the raster and capture pipeline, the canonical renderer definition, the pinned
font manifest, blob and licence, and the benchmark dependency pins.

It binds **no production code**. The corrected durable content-addressed identity is
`freeze_tree_sha256 = 088d2a43da5c2595ff9098b6cabbc3af19582930ae741fc64dc0878768aef282`,
with manifest SHA-256
`3a7e4d926bd377e7d7192327c5f41e936b8c430b7ee4c6416ff83b9d9fe535dc`.

## Freeze chronology

The relationship-corrected freeze is eleven ordinary commits, and no commit is amended or
rewritten:

* **Commit A — freeze.** Every protocol, environment, contract, source, test, document and CI
  step. It contains no holdout content and no commit-identity record.
* **Commit B — record freeze commit identity.** Adds only `freeze-commit.json`, which records
  Commit A's SHA together with the freeze tree and manifest digests, and proves against Commit A
  that every bound file's Git blob matches the working tree and that no holdout path existed.
* **Commit C — renderer-corrected freeze.**
  `a30af31a4eb7f2a473c3e30e30aded0843a1ecd8` preserves A/B and corrects the
  platform-specific renderer attestation defect exposed by exact-head CI before any holdout
  existed.
* **Commit D — renderer-corrected chronology record.** Records Commit C and marks A/B as
  preserved but superseded. It adds no corrected freeze material of its own.
* **Commit E — development-only correction evidence.** Records the exposed `ocr2-dev-*`
  distractor challenge, stored PP-OCRv6 Small captures, selector comparison and corrected WER
  measurement. It is not an authoritative freeze and consumed no fresh holdout.
* **Commit F — final corrected authoritative freeze.** Freezes the accepted renderer correction,
  PP-OCRv6 Small, `top_band_prominence@geometry`, full-visible-text WER, all gates and the
  no-holdout contract.
* **Commit G — final chronology record.** Records Commit F and marks C/D as preserved but
  superseded because independent review found the selector and WER contradictions before any
  fresh holdout existed. It adds no freeze material of its own.
* **Commit H — post-freeze terminology scope.** Preserves the accepted benchmark terminology
  guard correction as an ordinary post-F commit.
* **Commit I — hard-negative relationship regressions.**
  `ebbd24664ced5c2d8a86781e182073f84c5f52f3` records focused tests proving that the v2
  validator accepted five invalid claimed relationships. It is not a freeze.
* **Commit J — relationship-corrected authoritative freeze.** Freezes protocol v3, the v2 future
  corpus schema, the deterministic relationship validator, bounded human semantic evidence,
  updated tests/evidence/document and the rebuilt complete manifest.
* **Commit K — relationship-corrected chronology record.** Records Commit J as authoritative and
  marks F/G preserved but superseded because their category and expected-agreement checks did not
  verify the claimed title relationships before any fresh holdout existed. It adds no freeze
  material of its own.

The original protocol-freeze commit is `ab9ee241c6ea70f00c8e4fe063ef28c73b37802a`, with chronology
commit `b08c8fa3723a9c16157944de8f3d4a362fa03bc6`. Both remain in history and both predate any
holdout, but the first exact-head CI result superseded their renderer cross-platform assertion.
Commit C remains preserved and is recorded by Commit D, but it is no longer authoritative after
the selector/WER correction. Commits F/G and the ordinary post-freeze Commit H remain preserved,
but Commit K records Commit J as the new authority after all 30 blobs are verified.

`main` squash-merges, so a branch commit SHA does not survive as an ancestor of `main` — the v1
protocol-freeze commit `0485a8b7fda3f3e9f9873849104cd90917b4f395` is not one today. The
content-addressed `freeze_tree_sha256` is therefore the primary identity and the commit SHA is
supporting evidence; verification reports the commit check as unavailable, rather than inventing
a result, once the object is unreachable.

## What the next branch must do

The future Iteration 2B3 branch starts from the merged `main` commit that contains this freeze,
and follows the twelve frozen steps:

1. verify every freeze manifest hash against the working tree;
2. verify the canonical renderer fingerprint and refuse to continue on any divergence;
3. verify the frozen PP-OCRv6 Small artifacts offline against their frozen tree hashes;
4. verify that no fresh holdout already exists;
5. create the fresh 40-case holdout according to the frozen distribution, distractor, style and
   negative contracts;
6. generate every asset only through the frozen canonical renderer;
7. produce the fresh holdout non-reuse and independence evidence;
8. provision the reviewed artifacts without downloading;
9. disable the network with the process-wide offline guard;
10. run the holdout exactly once;
11. store the raw capture and the recomputed evidence;
12. change no frozen algorithm, threshold, selector, ordering or renderer afterwards.

If a genuine frozen-protocol bug is discovered *after* holdout exposure, the exposed result is
preserved, marked superseded with its reason, the protocol is fixed in a later version, and a
**new** fresh holdout is generated. Tuning against an exposed holdout and rerunning it as though
independent is forbidden.

## Frozen decision contract

The future run may return exactly one of:

* **`READY_FOR_OCR_PROVIDER_INTEGRATION`** — requires every frozen quality, title-safety,
  operational, provisioning and offline/security gate. A near miss may not become a selection.
* **`OCR_PROVIDER_DEFERRED`** — the role the merged v1 evidence filled with
  `NEEDS_MORE_OCR_BENCHMARKING`.
* **`HOLDOUT_INVALID_PROTOCOL_BUG`** — the holdout exposed a genuine frozen-protocol defect; the
  result is preserved and superseded rather than retuned.

## Scientific integrity and production boundary

- Fresh holdout created: **NO**.
- Fresh holdout case IDs instantiated: **NO**.
- Holdout measurement or accuracy: **NO**.
- Development-only PP-OCRv6 Small OCR executed: **YES**, on exposed `ocr2-dev-*` variants only.
- Fresh holdout OCR executed: **NO**.
- Production `SELECT` classification: **NO**.
- Production OCR provider, coordinator, enum or pipeline changed: **NO**.
- Migration, Supabase, staff UI, publication, Duda or workflow authority changed: **NO**.
- New OCR model, weights, LLM, VLM, embeddings or cloud AI added: **NO**.
- Historical Phase 0, v1, Iteration 2A or Iteration 2B1 evidence mutated: **NO**.
- Real participant or project data: **NO**.

## CI boundary

The lightweight benchmark CI job validates the freeze manifest schema and hashes, the canonical
renderer definition, the platform-independent renderer binding, within-run reference-fixture
determinism, the selected
candidate identity, the fixed selector, reading order, title-safety and metric identities, the
exact quality gates and operational ceilings, the 40-case distribution contract, the upper-page
distractor and per-case material-negative relationship requirements, the bounded human semantic
evidence boundary, the no-holdout guard, the recomputable
development correction evidence, and that the historical evidence is unchanged and the
Iteration 2 calibration still validates.

It does not install PaddlePaddle, download weights, run neural OCR, require a GPU or create a
holdout. Permanent CI does not require future `main` to keep `NONE`/`TESSERACT`, coordinator
`NONE` and 33 migrations forever, and it does not compare future `HEAD` against one fixed base
SHA; benchmark-PR scope is enforced by a PR-relative production-path diff instead.
