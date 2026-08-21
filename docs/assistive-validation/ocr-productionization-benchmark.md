# PP1 assistive OCR productionization decision benchmark

## Purpose and production boundary

This benchmark is the final evidence gate before any neural OCR provider integration. It decides whether a specifically provisioned local neural OCR candidate is ready for a later integration PR. It does not add a production provider, change the coordinator's `NONE` selection, change the worker task enum, alter the assistive pipeline version, add a migration, touch Supabase, change staff UI or workflow authority, or track model weights.

All corpus content is synthetic. OCR and model text are untrusted evidence. The existing deterministic title check and staff authority remain unchanged.

## Starting state

| Item | Value |
|---|---|
| `origin/main` | `284765d7ee820f68dbe6d8122c4b81dfb8e783b2` |
| Migration count | 33 |
| Production worker OCR task providers | `NONE`, `TESSERACT` |
| Coordinator OCR selection | `NONE` |
| Branch | `feat/assistive-ocr-productionization-benchmark` |

## Official candidate freshness

Official primary sources were checked on 2026-08-21. Phase 0's named releases remain current: [PaddleOCR 3.7.0](https://github.com/PaddlePaddle/PaddleOCR/releases/tag/v3.7.0), [PaddlePaddle 3.3.0 CPU](https://www.paddlepaddle.org.cn/documentation/docs/en/install/index_en.html), and [Tesseract 5.5.3](https://github.com/tesseract-ocr/tesseract/releases/tag/5.5.3). The [official PP-OCRv6 model table](https://www.paddleocr.ai/main/en/version3.x/pipeline_usage/OCR.html) still publishes tiny, small, and medium detection/recognition pairs and documents CPU operation. PaddleOCR, PaddlePaddle, and Tesseract are Apache-2.0; bundled dependencies retain their own notices.

The executed Paddle graph also pins PaddleX OCR core 3.7.2, the exact compatible runtime resolved during this benchmark. Phase 0 did not separately record its PaddleX transitive version, so the productionization evidence does not silently describe the two environments as identical.

## Artifact and provisioning contract

The versioned artifact manifest is [`artifact-manifest.json`](../../tools/assistive-validation-benchmark/ocr-productionization/artifact-manifest.json). It allowlists only Paddle's official model-ecology HTTPS host and identifies the six `paddle3.0.0` inference archives:

| Artifact | Archive bytes | SHA-256 |
|---|---:|---|
| `PP-OCRv6_tiny_det_infer` | 1,955,840 | `33a23c5e18d83208f9eeeccd00ed789af891786ac9255c83aeb2495b3db9ce63` |
| `PP-OCRv6_tiny_rec_infer` | 4,597,760 | `54403af57bc53981d3dce091c6c80dfc5ae30d58495541777126a54bac450604` |
| `PP-OCRv6_small_det_infer` | 10,055,680 | `bfb7c1e59f0faa6b540ebdca93aea3f4b1f2477805b389fbee117820d68fe9f5` |
| `PP-OCRv6_small_rec_infer` | 21,442,560 | `da460f968ce9f88325ac3a34fa302077d6e9b0dcefb16ba3137cd7796f879d06` |
| `PP-OCRv6_medium_det_infer` | 62,279,680 | `144d0621e059566e5086e228829171591c144c2deb07b2dad4962214fbabfcf7` |
| `PP-OCRv6_medium_rec_infer` | 76,851,200 | `4eecc1c6a4623765042e6fc15446da0da110b7d875b6b72b2d351d2b2dbd4da6` |

Provisioning verifies every archive size and SHA-256 before safe extraction, rejects traversal, links, devices, excessive members and excessive expanded bytes, then verifies a frozen hash over relative paths, file sizes, and file hashes in each extracted model tree. Archives, extracted models, caches, virtual environments, and binaries remain gitignored. Runtime inference receives explicit model directories and runs with a process-wide Python socket denial, so a missing model fails rather than downloading during a request.

## Frozen scientific protocol

The machine protocol is [`protocol.json`](../../tools/assistive-validation-benchmark/ocr-productionization/protocol.json). Calibration may select preprocessing/configuration; the fresh holdout may not. Commit A freezes the protocol, artifact manifest, calibration evidence, corpus generator, provider adapters, title extraction, normalisation, metrics, gates, and validators while the holdout path is absent. The final report records that exact commit and mechanically compares every frozen byte with Git history.

Frozen preprocessing and engine configuration after calibration:

- source poster assets retain clean high-resolution and low-resolution conditions;
- decode to RGB, preserve aspect ratio, never upscale, and deterministically downscale a long edge above 960 pixels with Lanczos;
- raster scanned PDFs at 150 DPI, within the production worker's 72–200 DPI bound;
- Tesseract 5.5.3, `eng`, page segmentation mode 3;
- PP-OCRv6 exact tiny/small/medium det+rec pairs, CPU, oneDNN disabled, document orientation/unwarping/text-line orientation disabled;
- metadata-blind port of production title-candidate ranking: document order, geometry prominence and adjacent groups of at most three OCR lines;
- exact-title metric uses the documented fixed normalisation; assistive title recovery is separate;
- CER/WER use NFKC and whitespace collapse only, preserving punctuation and case.

The complete quality gate is unchanged: holdout exact-title recovery at least 95% **and** mean WER at most 12%. Automatic deterministic agreement permits zero material false agreements.

Operational ceilings were frozen before holdout: cold start at most 30 seconds, p50 at most 10 seconds, p95 at most 20 seconds, peak working set at most 4 GiB, candidate model footprint at most 1 GiB, and every measured case within the existing 90-second provider ceiling. These are bounded evidence for a 16 GiB functional-minimum host, the existing single-worker queue and roughly 100+ annual projects; they are not a scalability claim.

For this benchmark, `cold_start_ms` runs from provider/model construction through the warm-up/first inference: it is startup-to-first-result, not model-loading-only time. Phase 0 documented cold-start figures as model loading only, so those figures are not directly comparable. This clarification does not change the frozen measurement or gate: Medium's 60.114-second value still fails the 30-second operational ceiling.

## Calibration evidence

The 16 scored calibration posters plus one unscored warm-up cover PNG, JPEG, scanned PDF, one/two/three-column layouts, clean/challenging conditions, high/low resolution, wrapped/decorative titles, mixed text sizes, contrast, compression, mild noise, Australian English, punctuation, numbers/acronyms, technical vocabulary, near-character confusions and material negatives.

The compact calibration result is [`calibration-summary.json`](../../tools/assistive-validation-benchmark/ocr-productionization/calibration-summary.json). It justified the 960-pixel bound without weakening any gate. Medium remained the calibration quality leader but measured only 56.3% exact title, 37.1% WER, about 56.8 seconds p50 and 1.05 GiB peak working set. Tiny measured 56.3% / 41.4% at 1.36 seconds p50; small measured 37.5% / 45.4% at 5.42 seconds; Tesseract measured 31.3% / 56.5% at 222 ms. Every candidate had zero material false agreements. These are calibration results, not the final decision.

## Fresh holdout and final result

The final protocol-freeze commit is `0485a8b7fda3f3e9f9873849104cd90917b4f395`. It retains the initial protocol commit and two normal pre-measurement portability corrections; it contains no holdout. Machine evidence verifies all 15 frozen files against their Git blob IDs and records the holdout's absence at that commit.

The fresh corpus contains 16 calibration and 32 holdout OCR-required cases. The holdout is evenly split between 16 clean and 16 challenging cases, with 11 PNG, 11 JPEG and 10 scanned-PDF posters and 11 one-column, 11 two-column and 10 three-column layouts. Eight cases are one-character material title negatives. Six native-PDF controls recovered 6/6 exact titles. A malformed PDF and truncated PNG were both rejected without reaching OCR. Content-hash comparison found zero reuse among the 21 historical Phase 0 holdout cases and 48 fresh scored cases.

Deterministic regeneration produced corpus asset hash `1cdfca0e65c084f018e3926d46929eaf00642c1252801ba645f9a9afd721e1ee` twice. The corpus manifest hash is `94bea0cc40dff2f448eb8ec203e8f72ef00d6994c7f208bbbb954d05e382b226`; holdout-part hash is `ea612ca065421031cdd5815be2902ace9d222b03fc92c46e1ac5cda1901939b8`.

### One-shot holdout measurements

All candidates executed all 32 holdout cases under the process-wide offline guard. Times are seconds and memory/footprint values are MiB.

| Candidate | Exact title | Assistive title | CER | WER | Clean WER | Challenging WER | Cold | p50 | p95 | Peak | Footprint | Decision |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Tesseract 5.5.3 | 12/32 (37.5%) | 18/32 (56.3%) | 24.7% | 43.1% | 29.4% | 56.9% | 0.275 | 0.202 | 0.227 | 65.5 | 5.7 | `DEFER` baseline |
| PP-OCRv6 Tiny | 14/32 (43.8%) | 18/32 (56.3%) | 17.9% | 28.7% | 7.7% | 49.8% | 5.701 | 1.123 | 1.912 | 511.5 | 6.2 | `DEFER` |
| PP-OCRv6 Small | 14/32 (43.8%) | 19/32 (59.4%) | 19.8% | 29.7% | 12.1% | 47.4% | 10.790 | 4.578 | 6.525 | 814.4 | 30.0 | `DEFER` |
| PP-OCRv6 Medium | 15/32 (46.9%) | 21/32 (65.6%) | 16.8% | 24.8% | 7.1% | 42.6% | 60.114 | 46.034 | 71.746 | 1,033.4 | 132.7 | `DEFER` |

Medium remains the fresh quality leader but misses the unchanged exact-title gate by 16 cases: a 32-case holdout requires at least 31 exact recoveries to reach 95%, while Medium recovers 15. Its WER exceeds the 12% ceiling by 12.85 percentage points. It also exceeds the 30-second cold-start, 10-second p50 and 20-second p95 ceilings. Tiny and Small meet every operational ceiling but fail exact-title and WER, so latency does not compensate for failed quality.

### Downstream title safety and Tesseract role

| Candidate | Equality precision | Equality recall | Review precision | Review recall | Material false agreements |
|---|---:|---:|---:|---:|---:|
| Tesseract | 100.0% | 45.8% | 100.0% | 75.0% | 0 |
| PP-OCRv6 Tiny | 100.0% | 58.3% | 88.9% | 66.7% | 0 |
| PP-OCRv6 Small | 100.0% | 58.3% | 89.5% | 70.8% | 0 |
| PP-OCRv6 Medium | 100.0% | 62.5% | 90.5% | 79.2% | 0 |

No material negative became automatic deterministic agreement. Review remains assistive and human-authoritative. Tesseract exactly rescued zero Medium title failures; any label-derived quality trigger would be truth-dependent, and no bounded provider failure occurred. A production fallback is therefore not justified.

The final evidence decision is **`NEEDS_MORE_OCR_BENCHMARKING`**. No production OCR provider is selected or activated. A later benchmark may evaluate a justified challenger or preprocessing improvement on a new frozen holdout; this result does not authorise lowering the gate.

## Security and CI boundary

Lightweight CI regenerates the corpus twice, compares generation hashes, validates split stability, proves no Phase 0 holdout title/body reuse across all 48 fresh scored cases, validates the closed artifact schema, recomputes metric arithmetic and decisions, proves protocol-freeze consistency, and validates the stored benchmark-time production boundary: `NONE`/`TESSERACT`, coordinator `NONE`, 33 migrations and zero production Paddle imports. Those are historical facts about the measurement, not permanent requirements for future `main`; later legitimate OCR integration therefore does not invalidate this evidence. On pull requests that change benchmark material, a PR-relative scope check confirms that particular benchmark PR has not changed production paths. CI does not install PaddlePaddle, download weights, run neural OCR, require a GPU, or use runtime internet.

The benchmark never uses document text as a command, URL, model instruction, credential lookup, database input, browser action, workflow decision or publication authority. Existing file, page, raster, pixel, text, block, warning and provider-time bounds are not weakened.
