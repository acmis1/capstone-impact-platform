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

## Calibration evidence

The 16 scored calibration posters plus one unscored warm-up cover PNG, JPEG, scanned PDF, one/two/three-column layouts, clean/challenging conditions, high/low resolution, wrapped/decorative titles, mixed text sizes, contrast, compression, mild noise, Australian English, punctuation, numbers/acronyms, technical vocabulary, near-character confusions and material negatives.

The compact calibration result is [`calibration-summary.json`](../../tools/assistive-validation-benchmark/ocr-productionization/calibration-summary.json). It justified the 960-pixel bound without weakening any gate. Medium remained the calibration quality leader but measured only 56.3% exact title, 37.1% WER, about 56.8 seconds p50 and 1.05 GiB peak working set. Tiny measured 56.3% / 41.4% at 1.36 seconds p50; small measured 37.5% / 45.4% at 5.42 seconds; Tesseract measured 31.3% / 56.5% at 222 ms. Every candidate had zero material false agreements. These are calibration results, not the final decision.

## Fresh holdout and final result

The fresh holdout and one-shot final result are intentionally absent from the protocol-freeze commit. The next normal commit adds them and this section's reviewed machine evidence without changing any frozen configuration.

## Security and CI boundary

Lightweight CI regenerates the corpus twice, compares generation hashes, validates split stability, proves no Phase 0 holdout title/body reuse, validates the closed artifact schema, recomputes metric arithmetic and decisions, proves protocol-freeze consistency, and checks the production boundary. CI does not install PaddlePaddle, download weights, run neural OCR, require a GPU, or use runtime internet.

The benchmark never uses document text as a command, URL, model instruction, credential lookup, database input, browser action, workflow decision or publication authority. Existing file, page, raster, pixel, text, block, warning and provider-time bounds are not weakened.
