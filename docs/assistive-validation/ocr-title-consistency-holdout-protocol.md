# PP1 OCR title-consistency sealed holdout protocol

## Frozen candidate

The prospective title-only PP-OCRv6 Small candidate is frozen at commit `61abb54bf70bb1ae7128bdda85c010c61e74e0a2` (tree `7324c6c6baa28a77a50ec408dcc68a5e3fccb7ee`). The frozen source manifest binds model identities and tree hashes, runtime versions, CPU configuration, renderer, title selector, normalization, classifier, metric arithmetic, quality gates, operational gates, and calibration evidence. The freeze checkpoint proves no title holdout path existed at calibration time.

The holdout runner lives outside the frozen candidate package and imports the frozen renderer, capture bounds, and scorer. It cannot modify their behavior.

## Fresh corpus and seal

The sealed corpus contains 45 scored synthetic cases plus one unscored warmup under a new deterministic seed. Exactly 15 cases are inconsistent. It contains new metadata titles, visible titles, body references, and meaningful case identities, and records zero reuse against 297 historical cases plus all 30 calibration cases.

Coverage includes PNG, JPEG, scanned PDF, one/two/three-column layouts, placement and typography variants, consistent punctuation/case variants, material substitutions, missing and materially illegible titles, degradation, competing headings, repeated body titles, and hostile prompt-like text. All content is synthetic.

The seal binds:

- the exact freeze commit and tree;
- the candidate freeze and prospective protocol hashes;
- the corpus, generated-asset manifest, aggregate asset hash, and per-asset byte/hash identities;
- the historical-plus-calibration non-reuse proof;
- the one-shot runner source hashes;
- the initial `SEALED_UNCONSUMED` state and zero run count;
- the frozen model/configuration, quality gates, and operational gates;
- absence of candidate output when sealed.

Rendered binaries stay in the ignored benchmark artifact area. Their canonical generation manifest and every byte/hash identity are tracked by the seal.

## One-shot boundary

Before model construction, the runner must revalidate the seal, physical rendered-asset bytes, frozen source hashes, exact local model trees, unconsumed state, and absence of prior candidate output. It atomically changes state to `CONSUMED_CLAIMED` before any inference. A failure still consumes the only authorised run.

The process-wide offline guard is enabled before model construction and self-tested. Candidate output is bounded to text blocks with page/box evidence; full raw provider dumps and reasoning traces are not retained.

After the single run, stored capture and report bytes are rescored through the frozen scorer. `READY_FOR_TITLE_OCR_INTEGRATION` requires every frozen quality, automatic-agreement, operational, provisioning, and offline-security gate to pass. There is no near-miss override and no post-result tuning or rerun.
