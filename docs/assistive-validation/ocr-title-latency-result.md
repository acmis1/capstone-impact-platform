# PP1 OCR title-latency holdout result

## Final decision

The one authorised fresh holdout run produced `OCR_TITLE_PROVIDER_DEFERRED`. Production integration is not permitted. The candidate, gates, corpus, and scorer remain frozen; the holdout will not be rerun and no post-result tuning is permitted.

The selected `default-cpu-fast-r36-t4` candidate passed every provisioning, offline-security, and operational gate, but it did not pass every final quality gate:

| Final gate | Required | Observed | Result |
|---|---:|---:|---|
| All scored cases executed | 54/54 | 54/54, 0 failures | pass |
| Exact visible-title recovery | at least 95% | 46/50 (92%) | **fail** |
| Inconsistency precision | at least 98% | 21/24 (87.5%) | **fail** |
| Inconsistency recall | at least 95% | 21/21 (100%) | pass |
| Automatic-agreement precision | 100% | 100% | pass |
| Material false automatic agreements | 0 | 0 | pass |
| p50 latency | at most 10,000 ms | 1,509.62 ms | pass |
| p95 latency | at most 20,000 ms | 7,143.31 ms | pass |
| Cold start | at most 30,000 ms | 4,885.39 ms | pass |
| Peak working set | at most 4 GiB | 1,065,648,128 bytes | pass |
| Model artifact footprint | at most 1 GiB | 31,481,281 bytes | pass |

The title-recovery misses were cases 012, 020, 025, and 036. Cases 012, 020, and 025 were the three consistency false positives. Cases 025 and 036 were accepted by the fast path with an inexact selected title, producing two false fast-path acceptances. There were no material false automatic agreements.

## Frozen chronology and fresh holdout identity

- Starting `main`: `fd4d4041f2314e4b4af65b2edc2bfc91313db682`
- Calibration commit: `da779d2ab517e52621a5c1aaafd56067ae86418e`
- Freeze commit: `4a917362b13a5f53928b9b478e371aa694d1d174`
- Freeze tree: `d69733fa6edf3c3a2e3fa210618b8a3961322a29`
- Holdout seal commit: `d849f981f8629a5cd75abacf8ff298bb10651209`
- Protocol SHA-256: `a996e693778bb36dc101fe28695c1dda111abe0dfbb4bb2f1b80b68b08da0ddc`
- Holdout seed: `2026082757`
- Holdout corpus SHA-256: `7c3aa7641c66a3dfffe13624b313a9dd18d31c27d82177da13d9063783086cef`
- Holdout asset aggregate SHA-256: `995f1eb1cbc6414944dfc1fad3c4e733be6c40bf31a5942ac030c639e1be85ab`
- Historical non-reuse SHA-256: `7177293656f2687628be8c7dc76d378eb2997184884be5d4edd2162a5b4f9e2e`
- Seal SHA-256: `2fffce1b23747fe0bcd37d396fdc9fc749b5d52feca8cab93844dcef334992e3`
- Capture SHA-256: `457bd13685b3257970ec9c7d395daa47be9faf062784639629f963bb0ded6f41`
- Report SHA-256: `969e91afb6cd4d5f7665e5e1032c92999c1ce7b875d485d5475448d4c15f900c`
- Final state: `CONSUMED_RECORDED`, run count `1`

The 54 scored cases plus one warmup contain six cases in every PNG/JPEG/scanned-PDF x one/two/three-column cell, 21 intentionally inconsistent cases, and 50 visible-title cases. The non-reuse check found zero prohibited reuse against 297 historical OCR cases and 111 previously exposed title cases. The holdout did not exist at the freeze commit; it was generated and sealed only in the later dedicated seal commit.

## Execution profile

The exact frozen configuration used the normal CPU backend, four CPU threads, MKL-DNN disabled, HPI disabled, 1,920-pixel maximum input dimension, 180 DPI rasterization, worker concurrency one, and the 36% metadata-blind top-region policy with unchanged full-page fallback.

- Fast-path hits: 34/54 (62.96%)
- Full-page fallbacks: 20/54 (37.04%)
- Average accepted fast-path latency: 1,384.35 ms
- Average fallback latency: 6,388.17 ms
- Maximum case runtime: 7,656.95 ms
- Model initialization: 3,443.50 ms
- Review outcomes: 2/54 (3.70%)
- Offline guard: enabled and self-tested; no model download occurred

The complete case-level capture and frozen recomputation report are tracked under `docs/assistive-validation/evidence/ocr-title-latency-holdout/`. Generic CI revalidates the committed seal, consumed one-shot state, score arithmetic, latency calculations, hashes, and final decision without loading Paddle, downloading models, or running OCR.

## Scope outcome

No production worker, Admin CMS, persistence, migration, Supabase, Render, Duda, public-feed, rich-media, accessibility UI, or release/KPI path was changed. That is required by the deferred result: the local Paddle title provider remains an evaluated but non-production candidate.
