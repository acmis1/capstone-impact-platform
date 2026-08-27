# PP1 full-page OCR title provider: production integration

This integration was performed only after the fresh sealed Issue #214 holdout returned
`READY_FOR_TITLE_OCR_INTEGRATION`. The qualification evidence and exact measurements are in
[`ocr-title-fullpage-result.md`](./ocr-title-fullpage-result.md).

## Architecture and authority

The existing asynchronous path is unchanged:

```text
enqueue → claim → Python worker → deterministic checks → generic finding persistence → staff inspection
```

The worker validates media and attempts native PDF extraction first. A usable born-digital PDF
never invokes OCR. Images and PDFs without usable native title evidence may use the explicitly
selected local provider. OCR-derived title candidates are selected without metadata, then
compared deterministically and persisted as an existing `TITLE_CONSISTENCY` finding.

Every result remains `NON_BLOCKING`. OCR cannot modify authoritative metadata, approve,
publish, archive, unpublish, change lifecycle state, or satisfy accessibility authority. No OCR
runs in a synchronous Next.js request, and no database migration is required.

## Exact frozen provider

Production pins the qualified candidate without an operator tuning surface:

| Property | Frozen value |
|---|---|
| Architecture | one full-page pass; no crop, fast region, cascade, or second pass |
| Models | `PP-OCRv6_small_det` and `PP-OCRv6_small_rec` |
| Runtime | PaddleOCR 3.7.0, PaddlePaddle 3.3.0, PaddleX 3.7.2 |
| Device / threads | CPU, exactly 4 threads, worker concurrency 1 |
| Acceleration | MKL-DNN off, HPI off, MKL-DNN cache capacity 10 |
| Raster | 180 DPI for PDFs; longest edge bounded to 1920 pixels |
| Extra stages | orientation classification, unwarping, and text-line orientation off |
| Selector | `top-band-typography-consistent-group-prominence-v4@geometry` |

The provider verifies the frozen model-tree hashes and runtime versions before it becomes
available. It installs a process-wide socket denial before Paddle constructs the pipeline.
Model weights are not in Git, are never downloaded, and have no cloud fallback.

## Provisioning and degraded behavior

Set `CAPSTONE_ASSISTIVE_PADDLE_MODELS_DIR` for the local coordinator process. The directory must
contain `PP-OCRv6_small_det_infer/` and `PP-OCRv6_small_rec_infer/` with the qualified bytes, and
the worker Python environment must contain the pinned runtime.

If the directory, runtime, or exact model bytes are absent or invalid, the provider reports
`UNAVAILABLE` and the assistive run completes as partial. Inference failure, timeout, malformed
output, or an output-limit violation also fails safely inside the existing worker/job boundary.
There is no silent fallback to another provider.

## Persistence and testing

The generic finding stores bounded candidate evidence, page and geometry, normalized metadata
and candidate values, lexical score, and bounded provider/model/runtime provenance. It does not
store raw Paddle responses, reasoning traces, prompts, or a new OCR transcript table.

Generic CI uses fake runtime and engine probes; it does not require Paddle, model weights, a GPU,
or network. The scientific evidence replay remains independent of live inference.
